import Stripe from "stripe";
import sql from "./db.js";

// Stripe webhook → keeps Neon `profiles.is_pro` in sync. Signature
// verification needs the RAW body, so body parsing stays off.
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
  console.log("[wh] env · STRIPE_SECRET_KEY:", !!STRIPE_SECRET_KEY, "WEBHOOK_SECRET:", !!WEBHOOK_SECRET, "DATABASE_URL:", !!process.env.DATABASE_URL);
  if (!STRIPE_SECRET_KEY || !WEBHOOK_SECRET) return res.status(500).json({ error: "Missing Stripe secrets." });

  const stripe = new Stripe(STRIPE_SECRET_KEY);

  // ── Verify signature against the raw body ──
  const sig = req.headers["stripe-signature"];
  let event;
  try {
    const raw = await readRaw(req);
    console.log("[wh] raw body bytes:", raw?.length ?? 0, "· sig present:", !!sig);
    event = stripe.webhooks.constructEvent(raw, sig, WEBHOOK_SECRET);
  } catch (err) {
    console.error("[wh] SIGNATURE FAILED:", err.message);
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }
  console.log(`[wh] ✓ event: ${event.type} (${event.id})`);

  const emailFromCustomer = async (customerId) => {
    if (!customerId) return null;
    try { const c = await stripe.customers.retrieve(customerId); return c && !c.deleted ? c.email : null; }
    catch (e) { console.error("[wh] customers.retrieve failed:", e.message); return null; }
  };

  // Update the matching profile (by Clerk id, email, or Stripe customer id).
  // COALESCE keeps existing values when a field is null. `isPro` null = leave.
  const apply = async ({ isPro = null, userId = null, email = null, customerId = null,
                         subscriptionId = null, status = null, plan = null, periodEnd = null, cancelAtPeriodEnd = null, source }) => {
    try {
      const rows = await sql`
        UPDATE profiles SET
          is_pro               = COALESCE(${isPro}, is_pro),
          stripe_customer_id   = COALESCE(${customerId}, stripe_customer_id),
          subscription_id      = COALESCE(${subscriptionId}, subscription_id),
          subscription_status  = COALESCE(${status}, subscription_status),
          subscription_plan    = COALESCE(${plan}, subscription_plan),
          current_period_end   = COALESCE(${periodEnd}, current_period_end),
          cancel_at_period_end = COALESCE(${cancelAtPeriodEnd}, cancel_at_period_end)
        WHERE id = ${userId} OR email = ${email} OR stripe_customer_id = ${customerId}
        RETURNING id, is_pro`;
      console.log(`[wh] ${source}: updated ${rows.length} row(s) · id=${userId || "?"} email=${email || "?"} cust=${customerId || "?"} →`, rows[0] || "(no match)");
      return rows;
    } catch (e) {
      console.error(`[wh] ${source}: DB error:`, e.message);
      return [];
    }
  };

  const trialIso = (s) => (s.trial_end ? new Date(s.trial_end * 1000).toISOString() : null);
  const periodIso = (s) => (s.current_period_end ? new Date(s.current_period_end * 1000).toISOString() : null);
  const planFrom = (s) => { const i = s.items?.data?.[0]?.price?.recurring?.interval; return i === "year" ? "yearly" : i === "month" ? "monthly" : null; };

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const s = event.data.object;
        await apply({
          isPro: true,
          userId: s.client_reference_id || s.metadata?.user_id || null,
          email: s.customer_details?.email || s.customer_email || null,
          customerId: s.customer,
          subscriptionId: s.subscription || null,
          source: "checkout.session.completed",
        });
        break;
      }

      case "customer.subscription.created": {
        const sub = event.data.object;
        const pro = ACTIVE.includes(sub.status);
        await apply({
          isPro: pro,
          userId: sub.metadata?.user_id || null,
          email: await emailFromCustomer(sub.customer),
          customerId: sub.customer,
          subscriptionId: sub.id,
          status: sub.status,
          plan: planFrom(sub),
          periodEnd: periodIso(sub) || trialIso(sub),
          cancelAtPeriodEnd: !!sub.cancel_at_period_end,
          source: "customer.subscription.created",
        });
        break;
      }

      case "customer.subscription.updated": {
        const sub = event.data.object;
        const isPro = ACTIVE.includes(sub.status) ? true : INACTIVE.includes(sub.status) ? false : null;
        await apply({
          isPro,
          userId: sub.metadata?.user_id || null,
          customerId: sub.customer,
          subscriptionId: sub.id,
          status: sub.status,
          plan: planFrom(sub),
          periodEnd: periodIso(sub),
          cancelAtPeriodEnd: !!sub.cancel_at_period_end,
          source: "customer.subscription.updated",
        });
        break;
      }

      case "customer.subscription.deleted": {
        const sub = event.data.object;
        try {
          const rows = await sql`
            UPDATE profiles SET is_pro = false, subscription_id = NULL,
              subscription_status = 'canceled', current_period_end = NULL, cancel_at_period_end = false
            WHERE id = ${sub.metadata?.user_id || null} OR stripe_customer_id = ${sub.customer}
            RETURNING id`;
          console.log(`[wh] subscription.deleted: cleared ${rows.length} row(s)`);
        } catch (e) { console.error("[wh] subscription.deleted DB error:", e.message); }
        break;
      }

      case "invoice.payment_succeeded": {
        const inv = event.data.object;
        await apply({ isPro: true, email: inv.customer_email || await emailFromCustomer(inv.customer), customerId: inv.customer, source: "invoice.payment_succeeded" });
        break;
      }

      case "invoice.payment_failed": {
        const inv = event.data.object;
        await apply({ isPro: false, customerId: inv.customer, source: "invoice.payment_failed" });
        break;
      }

      default:
        console.log(`[wh] (no handler for ${event.type})`);
        break;
    }
  } catch (err) {
    console.error("[wh] handler threw:", err);
    return res.status(500).json({ error: "Webhook handler failed." });
  }

  return res.status(200).json({ received: true });
}

async function readRaw(req) {
  const chunks = [];
  for await (const c of req) chunks.push(typeof c === "string" ? Buffer.from(c) : c);
  return Buffer.concat(chunks);
}
