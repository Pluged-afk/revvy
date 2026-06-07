import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

// Stripe webhook: keeps Supabase `profiles.is_pro` in sync with subscription
// state. Signature verification needs the RAW request body, so body parsing
// MUST stay off (this config disables Vercel/Next body parsing).
//
// ── Testing (Stripe TEST mode) ───────────────────────────────────────
//   stripe listen --forward-to localhost:5173/api/stripe-webhook
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
  // Service-role key ONLY — never the anon key. RLS is bypassed so the webhook
  // can write any user's profile row.
  const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  // Startup diagnostics (booleans only — never log secret values).
  console.log("[stripe-webhook] env check ·",
    "STRIPE_SECRET_KEY:", !!STRIPE_SECRET_KEY,
    "STRIPE_WEBHOOK_SECRET:", !!WEBHOOK_SECRET,
    "SUPABASE_URL:", !!SUPABASE_URL,
    "SERVICE_ROLE_KEY:", !!SERVICE_ROLE_KEY,
  );
  if (!STRIPE_SECRET_KEY || !WEBHOOK_SECRET) {
    console.error("[stripe-webhook] FATAL: missing Stripe secret(s).");
    return res.status(500).json({ error: "Server missing Stripe secrets." });
  }
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    console.error("[stripe-webhook] FATAL: missing Supabase URL or SERVICE ROLE key.");
    return res.status(500).json({ error: "Server missing Supabase config." });
  }

  const stripe = new Stripe(STRIPE_SECRET_KEY);
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // ── Verify the signature against the RAW body ────────────────────────
  const sig = req.headers["stripe-signature"];
  let event;
  try {
    const raw = await readRaw(req);
    console.log("[stripe-webhook] raw body bytes:", raw?.length ?? 0, "· signature header present:", !!sig);
    if (!raw || raw.length === 0) {
      console.error("[stripe-webhook] RAW BODY EMPTY — body was parsed/consumed before us. Signature will fail.");
    }
    event = stripe.webhooks.constructEvent(raw, sig, WEBHOOK_SECRET);
  } catch (err) {
    console.error("[stripe-webhook] SIGNATURE VERIFICATION FAILED:", err.message,
      "→ check that STRIPE_WEBHOOK_SECRET matches THIS endpoint's signing secret and test/live mode matches.");
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  console.log(`[stripe-webhook] ✓ VERIFIED event: ${event.type} (${event.id})`);
  // Full event dump (as requested) — verbose but invaluable for debugging.
  console.log("[stripe-webhook] full event:", JSON.stringify(event));

  // ── Helpers ──────────────────────────────────────────────────────────

  // Find a Supabase auth user id by email (paginated scan of auth.users).
  const findUserIdByEmail = async (email) => {
    if (!email) return null;
    const target = email.toLowerCase().trim();
    try {
      for (let page = 1; page <= 20; page++) {
        const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
        if (error) { console.error("[stripe-webhook] listUsers error:", error.message); return null; }
        const users = data?.users || [];
        const match = users.find((u) => (u.email || "").toLowerCase().trim() === target);
        if (match) return match.id;
        if (users.length < 200) break; // last page reached
      }
    } catch (e) {
      console.error("[stripe-webhook] findUserIdByEmail threw:", e.message);
    }
    return null;
  };

  // Get the customer email from a Stripe customer id.
  const emailFromCustomer = async (customerId) => {
    if (!customerId) return null;
    try {
      const c = await stripe.customers.retrieve(customerId);
      return c && !c.deleted ? c.email : null;
    } catch (e) {
      console.error("[stripe-webhook] customers.retrieve failed:", e.message);
      return null;
    }
  };

  // Grant Pro: resolve the user (id → email → customer id), then write is_pro.
  const grantPro = async ({ userId, email, customerId, subscriptionId, source }) => {
    let resolvedId = userId || null;
    console.log(`[stripe-webhook] ${source}: resolving user · id=${userId || "?"} email=${email || "?"} cust=${customerId || "?"}`);

    if (!resolvedId && email) {
      resolvedId = await findUserIdByEmail(email);
      console.log(`[stripe-webhook] ${source}: email "${email}" → user ${resolvedId || "NOT FOUND"}`);
    }

    if (resolvedId) {
      const patch = { id: resolvedId, is_pro: true };
      if (customerId) patch.stripe_customer_id = customerId;
      if (subscriptionId) patch.subscription_id = subscriptionId;
      const { data, error } = await admin.from("profiles").upsert(patch, { onConflict: "id" }).select("id");
      if (error) console.error(`[stripe-webhook] ${source}: upsert ERROR:`, error.message);
      else console.log(`[stripe-webhook] ${source}: ✓ is_pro=true for user ${resolvedId} (${data?.length ?? 0} row)`);
      return;
    }

    // Last resort: match an existing profile by stripe_customer_id.
    if (customerId) {
      const { data, error } = await admin.from("profiles")
        .update({ is_pro: true, ...(subscriptionId ? { subscription_id: subscriptionId } : {}) })
        .eq("stripe_customer_id", customerId).select("id");
      if (error) console.error(`[stripe-webhook] ${source}: customer-id update ERROR:`, error.message);
      else console.log(`[stripe-webhook] ${source}: customer-id match wrote ${data?.length ?? 0} row(s)`);
      if ((data?.length ?? 0) > 0) return;
    }

    console.error(`[stripe-webhook] ${source}: COULD NOT GRANT PRO — no user id, email match, or customer-id match.`);
  };

  // Generic profile patch by user id (upsert) or customer id, with logging.
  const updateProfile = async ({ userId, customerId, patch }) => {
    let result;
    if (userId) {
      result = await admin.from("profiles").upsert({ id: userId, ...patch }, { onConflict: "id" }).select("id");
    } else if (customerId) {
      result = await admin.from("profiles").update(patch).eq("stripe_customer_id", customerId).select("id");
    } else {
      console.warn(`[stripe-webhook] ${event.type}: no userId/customerId — skipped`);
      return;
    }
    const { data, error } = result;
    if (error) console.error(`[stripe-webhook] ${event.type}: DB write ERROR:`, error.message);
    else console.log(`[stripe-webhook] ${event.type}: wrote ${data?.length ?? 0} row(s) · user=${userId || "?"} cust=${customerId || "?"} ·`, JSON.stringify(patch));
  };

  const trialIso = (sub) => (sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null);
  const periodEndIso = (sub) => (sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null);
  const planFrom = (sub) => {
    const interval = sub.items?.data?.[0]?.price?.recurring?.interval;
    return interval === "year" ? "yearly" : interval === "month" ? "monthly" : null;
  };

  // ── Handle events ────────────────────────────────────────────────────
  try {
    switch (event.type) {
      // Canonical "payment complete / trial started" — most reliable grant.
      case "checkout.session.completed": {
        const s = event.data.object;
        const userId = s.client_reference_id || s.metadata?.supabase_user_id;
        const email = s.customer_details?.email || s.customer_email || null;
        await grantPro({
          userId,
          email,
          customerId: s.customer,
          subscriptionId: s.subscription || undefined,
          source: "checkout.session.completed",
        });
        break;
      }

      case "customer.subscription.created": {
        const sub = event.data.object;
        const email = await emailFromCustomer(sub.customer);
        // Grant Pro (resolves by metadata id → email → customer id)…
        await grantPro({
          userId: sub.metadata?.supabase_user_id,
          email,
          customerId: sub.customer,
          subscriptionId: sub.id,
          source: "customer.subscription.created",
        });
        // …then store the subscription detail fields.
        await updateProfile({
          userId: sub.metadata?.supabase_user_id,
          customerId: sub.customer,
          patch: {
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
        const inv = event.data.object;
        await updateProfile({ customerId: inv.customer, patch: { is_pro: false } });
        break;
      }

      default:
        console.log(`[stripe-webhook] (no handler for ${event.type} — ignored)`);
        break;
    }
  } catch (err) {
    console.error("[stripe-webhook] handler threw:", err);
    return res.status(500).json({ error: "Webhook handler failed." });
  }

  return res.status(200).json({ received: true });
}

async function readRaw(req) {
  const chunks = [];
  for await (const c of req) chunks.push(typeof c === "string" ? Buffer.from(c) : c);
  return Buffer.concat(chunks);
}
