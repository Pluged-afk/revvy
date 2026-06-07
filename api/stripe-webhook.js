import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

// Stripe webhook: keeps Supabase `profiles` in sync with subscription state.
// Requires the raw body for signature verification, so body parsing is off.
//
// ── Testing (Stripe TEST mode) ───────────────────────────────────────
//   Forward events locally with the Stripe CLI:
//     stripe listen --forward-to localhost:5173/api/stripe-webhook
//   Test card 4242 4242 4242 4242 · any future expiry · any CVC.
export const config = { api: { bodyParser: false } };

const ACTIVE = ["active", "trialing"];
const INACTIVE = ["canceled", "cancelled", "past_due", "unpaid", "incomplete_expired"];

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
  const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
  const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!STRIPE_SECRET_KEY || !WEBHOOK_SECRET) {
    return res.status(500).json({ error: "Server missing Stripe secrets." });
  }

  const stripe = new Stripe(STRIPE_SECRET_KEY);
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Verify the signature against the raw body.
  const sig = req.headers["stripe-signature"];
  let event;
  try {
    const raw = await readRaw(req);
    // If this logs 0, Vercel parsed/consumed the body before we read it and
    // signature verification will always fail — see notes in the summary.
    console.log("[stripe-webhook] raw body bytes:", raw?.length ?? 0, "· sig present:", !!sig);
    event = stripe.webhooks.constructEvent(raw, sig, WEBHOOK_SECRET);
  } catch (err) {
    console.error("[stripe-webhook] signature verification FAILED:", err.message);
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  console.log(`[stripe-webhook] ✓ received event: ${event.type} (${event.id})`);

  // Update a profile by Supabase user id (upsert so a missing row is created)
  // or by Stripe customer id. Logs the affected row count + any DB error so a
  // silent 0-row update is visible in the Vercel logs.
  const updateProfile = async ({ userId, customerId, patch }) => {
    let result;
    if (userId) {
      result = await admin.from("profiles").upsert({ id: userId, ...patch }, { onConflict: "id" }).select("id");
    } else if (customerId) {
      result = await admin.from("profiles").update(patch).eq("stripe_customer_id", customerId).select("id");
    } else {
      console.warn(`[stripe-webhook] ${event.type}: no userId or customerId to match — skipped`);
      return;
    }
    const { data, error } = result;
    if (error) {
      console.error(`[stripe-webhook] ${event.type} DB write error:`, error.message);
    } else {
      console.log(`[stripe-webhook] ${event.type}: wrote ${data?.length ?? 0} row(s) · user=${userId || "?"} cust=${customerId || "?"} ·`, JSON.stringify(patch));
    }
  };

  const trialIso = (sub) => (sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null);
  const periodEndIso = (sub) => (sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null);
  // Derive 'monthly' | 'yearly' from the subscription's price recurring interval.
  const planFrom = (sub) => {
    const interval = sub.items?.data?.[0]?.price?.recurring?.interval;
    return interval === "year" ? "yearly" : interval === "month" ? "monthly" : null;
  };

  try {
    switch (event.type) {
      // Canonical "payment complete / trial started" event. Carries the
      // Supabase user id (client_reference_id) AND the Stripe customer id, so
      // it both grants Pro and links the customer id for later customer-only
      // events (invoices). This is the most reliable place to flip is_pro.
      case "checkout.session.completed": {
        const s = event.data.object;
        const userId = s.client_reference_id || s.metadata?.supabase_user_id;
        await updateProfile({
          userId,
          customerId: s.customer,
          patch: {
            is_pro: true,
            stripe_customer_id: s.customer,
            subscription_id: s.subscription || undefined,
          },
        });
        break;
      }
      case "customer.subscription.created": {
        const sub = event.data.object;
        await updateProfile({
          userId: sub.metadata?.supabase_user_id,
          customerId: sub.customer,
          patch: {
            is_pro: ACTIVE.includes(sub.status),
            stripe_customer_id: sub.customer,
            subscription_id: sub.id,
            subscription_status: sub.status,
            trial_end: trialIso(sub),
            subscription_plan: planFrom(sub),
            current_period_end: periodEndIso(sub),
            cancel_at_period_end: !!sub.cancel_at_period_end,
          },
        });
        break;
      }
      case "customer.subscription.updated": {
        const sub = event.data.object;
        const isPro = ACTIVE.includes(sub.status) ? true
          : INACTIVE.includes(sub.status) ? false : undefined;
        const patch = {
          subscription_status: sub.status,
          subscription_id: sub.id,
          trial_end: trialIso(sub),
          subscription_plan: planFrom(sub),
          current_period_end: periodEndIso(sub),
          cancel_at_period_end: !!sub.cancel_at_period_end,
        };
        if (isPro !== undefined) patch.is_pro = isPro;
        await updateProfile({ userId: sub.metadata?.supabase_user_id, customerId: sub.customer, patch });
        break;
      }
      case "customer.subscription.deleted": {
        const sub = event.data.object;
        await updateProfile({
          userId: sub.metadata?.supabase_user_id,
          customerId: sub.customer,
          patch: { is_pro: false, subscription_id: null, subscription_status: "canceled", trial_end: null, current_period_end: null, cancel_at_period_end: false },
        });
        break;
      }
      case "invoice.payment_succeeded": {
        const inv = event.data.object;
        await updateProfile({ customerId: inv.customer, patch: { is_pro: true } });
        break;
      }
      case "invoice.payment_failed": {
        // Handles failed charges after the trial ends.
        const inv = event.data.object;
        await updateProfile({ customerId: inv.customer, patch: { is_pro: false } });
        break;
      }
      default:
        console.log(`[stripe-webhook] (no handler for ${event.type} — ignored)`);
        break;
    }
  } catch (err) {
    console.error("[stripe-webhook] handler error:", err);
    return res.status(500).json({ error: "Webhook handler failed." });
  }

  return res.status(200).json({ received: true });
}

async function readRaw(req) {
  const chunks = [];
  for await (const c of req) chunks.push(typeof c === "string" ? Buffer.from(c) : c);
  return Buffer.concat(chunks);
}
