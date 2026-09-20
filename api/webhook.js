import Stripe from "stripe";
import sql from "./db.js";

// Stripe webhook → keeps Neon `profiles.is_pro` in sync. Signature
// verification needs the RAW body, so body parsing stays off.
export const config = { api: { bodyParser: false } };

const ACTIVE = ["active", "trialing"];
const INACTIVE = ["canceled", "cancelled", "past_due", "unpaid", "incomplete_expired"];

// Idempotency: Stripe retries and can redeliver the same event. We record each
// event id AFTER it is handled and skip anything already recorded, so a
// duplicate is a no-op, critical for the one-time question-pack credit (it's
// additive and would otherwise double). Recording AFTER success (not before)
// means a delivery that fails mid-handling is never marked, so Stripe's retry
// still gets to run, we never lose a real credit to a transient error.
let eventsTableReady = false;
async function ensureEventsTable() {
  if (eventsTableReady) return;
  await sql`CREATE TABLE IF NOT EXISTS stripe_events (
    id  TEXT PRIMARY KEY,
    at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
  eventsTableReady = true;
}
// True if this event was already handled. Fail-OPEN (false) on any DB hiccup so
// a blip never drops a real event; the worst case is a rare reprocess.
async function alreadyProcessed(id) {
  try {
    await ensureEventsTable();
    const rows = await sql`SELECT 1 FROM stripe_events WHERE id = ${id} LIMIT 1`;
    return rows.length > 0;
  } catch (e) {
    console.error("[wh] idempotency read failed (processing anyway):", e.message);
    return false;
  }
}
// Mark an event handled. Best-effort, and only ever called after the handler
// finished cleanly (never on the error path), so a failed delivery stays retryable.
async function markProcessed(id) {
  try {
    await ensureEventsTable();
    await sql`INSERT INTO stripe_events (id) VALUES (${id}) ON CONFLICT (id) DO NOTHING`;
    if (Math.random() < 0.02) { try { await sql`DELETE FROM stripe_events WHERE at < NOW() - INTERVAL '30 days'`; } catch { /* ignore */ } }
  } catch (e) { console.error("[wh] idempotency write failed:", e.message); }
}

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
  console.log("[webhook] received:", event.type);

  // Skip anything we've already handled (Stripe redelivery / retry).
  if (await alreadyProcessed(event.id)) {
    console.log(`[wh] duplicate ${event.id}, already processed, skipping`);
    return res.status(200).json({ received: true, duplicate: true });
  }

  const emailFromCustomer = async (customerId) => {
    if (!customerId) return null;
    try { const c = await stripe.customers.retrieve(customerId); return c && !c.deleted ? c.email : null; }
    catch (e) { console.error("[wh] customers.retrieve failed:", e.message); return null; }
  };

  // Update the matching profile (by Clerk id, email, or Stripe customer id).
  // COALESCE keeps existing values when a field is null. `isPro` null = leave.
  const apply = async ({ isPro = null, userId = null, email = null, customerId = null,
                         subscriptionId = null, status = null, plan = null, periodEnd = null, cancelAtPeriodEnd = null, source }) => {
    console.log("[webhook] customer email:", email || "(none)", "· clerk_user_id:", userId || "(none)", "· customer:", customerId || "(none)");
    console.log("[webhook] updating profile...");
    try {
      // Match by clerk_user_id first (most reliable), then id, email, customer.
      const result = await sql`
        UPDATE profiles SET
          is_pro               = COALESCE(${isPro}, is_pro),
          stripe_customer_id   = COALESCE(${customerId}, stripe_customer_id),
          subscription_id      = COALESCE(${subscriptionId}, subscription_id),
          subscription_status  = COALESCE(${status}, subscription_status),
          subscription_plan    = COALESCE(${plan}, subscription_plan),
          current_period_end   = COALESCE(${periodEnd}, current_period_end),
          cancel_at_period_end = COALESCE(${cancelAtPeriodEnd}, cancel_at_period_end)
        WHERE clerk_user_id = ${userId} OR id = ${userId} OR email = ${email} OR stripe_customer_id = ${customerId}
        RETURNING id, is_pro`;
      console.log("[webhook] result:", JSON.stringify(result));
      console.log(`[wh] ${source}: updated ${result.length} row(s)${result.length ? "" : " (NO MATCH, user not found by clerk id / email / customer)"}`);
      return result;
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
        // One-time question-pack purchase → credit bonus, do NOT touch is_pro.
        if (s.mode === "payment" || s.metadata?.type === "question_pack") {
          const qty = parseInt(s.metadata?.questions, 10) || 0;
          const uid = s.client_reference_id || s.metadata?.clerk_user_id || null;
          if (qty > 0 && uid) {
            try {
              const rows = await sql`
                UPDATE profiles SET bonus_questions_remaining = COALESCE(bonus_questions_remaining, 0) + ${qty}
                WHERE clerk_user_id = ${uid} OR id = ${uid}
                RETURNING id, bonus_questions_remaining`;
              console.log(`[webhook] pack: +${qty} bonus for ${uid} → ${rows.length} row(s)`);
            } catch (e) { console.error("[webhook] pack credit failed:", e.message); }
          } else {
            console.warn("[webhook] pack: missing qty/uid", JSON.stringify(s.metadata));
          }
          break;
        }
        // Subscription checkout → activate Pro.
        await apply({
          isPro: true,
          userId: s.client_reference_id || s.metadata?.clerk_user_id || null,
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
          userId: sub.metadata?.clerk_user_id || null,
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
          userId: sub.metadata?.clerk_user_id || null,
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
            WHERE clerk_user_id = ${sub.metadata?.clerk_user_id || null} OR id = ${sub.metadata?.clerk_user_id || null} OR stripe_customer_id = ${sub.customer}
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
    return res.status(500).json({ error: "Webhook handler failed." }); // NOT marked → Stripe retry re-runs it
  }

  // Handled cleanly: record it so a later redelivery is a no-op.
  await markProcessed(event.id);
  return res.status(200).json({ received: true });
}

async function readRaw(req) {
  const chunks = [];
  for await (const c of req) chunks.push(typeof c === "string" ? Buffer.from(c) : c);
  return Buffer.concat(chunks);
}
