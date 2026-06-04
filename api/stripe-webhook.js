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
    event = stripe.webhooks.constructEvent(raw, sig, WEBHOOK_SECRET);
  } catch (err) {
    console.error("[stripe-webhook] signature verification failed:", err.message);
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  // Update a profile by Supabase user id (preferred) or Stripe customer id.
  const updateProfile = async ({ userId, customerId, patch }) => {
    if (userId) await admin.from("profiles").update(patch).eq("id", userId);
    else if (customerId) await admin.from("profiles").update(patch).eq("stripe_customer_id", customerId);
    console.log(`[stripe-webhook] ${event.type}:`, JSON.stringify(patch), "user=", userId || "?", "cust=", customerId || "?");
  };

  const trialIso = (sub) => (sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null);

  try {
    switch (event.type) {
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
          },
        });
        break;
      }
      case "customer.subscription.updated": {
        const sub = event.data.object;
        const isPro = ACTIVE.includes(sub.status) ? true
          : INACTIVE.includes(sub.status) ? false : undefined;
        const patch = { subscription_status: sub.status, subscription_id: sub.id, trial_end: trialIso(sub) };
        if (isPro !== undefined) patch.is_pro = isPro;
        await updateProfile({ userId: sub.metadata?.supabase_user_id, customerId: sub.customer, patch });
        break;
      }
      case "customer.subscription.deleted": {
        const sub = event.data.object;
        await updateProfile({
          userId: sub.metadata?.supabase_user_id,
          customerId: sub.customer,
          patch: { is_pro: false, subscription_id: null, subscription_status: "canceled", trial_end: null },
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
