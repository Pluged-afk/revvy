import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

// Stripe webhook → keeps Supabase `profiles.is_pro` (boolean) in sync with
// subscription state. Signature verification needs the RAW request body, so
// body parsing MUST stay off.
//
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
  // SERVICE-ROLE key only (never anon) — bypasses RLS to write any profile row.
  const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  console.log("[wh] env ·",
    "STRIPE_SECRET_KEY:", !!STRIPE_SECRET_KEY,
    "WEBHOOK_SECRET:", !!WEBHOOK_SECRET,
    "SUPABASE_URL:", SUPABASE_URL || "MISSING",
    "SERVICE_ROLE_KEY:", !!SERVICE_ROLE_KEY,
  );
  if (!STRIPE_SECRET_KEY || !WEBHOOK_SECRET) return res.status(500).json({ error: "Missing Stripe secrets." });
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) return res.status(500).json({ error: "Missing Supabase config." });

  const stripe = new Stripe(STRIPE_SECRET_KEY);
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // ── Verify signature against RAW body ───────────────────────────────
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

  // ── User resolution ─────────────────────────────────────────────────

  // (1) email → auth.users id. Logs the email it searched and what it found.
  const findUserIdByEmail = async (email) => {
    if (!email) { console.log("[wh] findByEmail: no email provided"); return null; }
    const target = email.toLowerCase().trim();
    console.log(`[wh] findByEmail: searching auth.users for "${target}"`);
    try {
      for (let page = 1; page <= 20; page++) {
        const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
        if (error) { console.error("[wh] listUsers error:", error.message); return null; }
        const users = data?.users || (Array.isArray(data) ? data : []);
        const match = users.find((u) => (u.email || "").toLowerCase().trim() === target);
        if (match) { console.log(`[wh] findByEmail: MATCH → user ${match.id}`); return match.id; }
        if (users.length < 200) break;
      }
    } catch (e) { console.error("[wh] findByEmail threw:", e.message); }
    console.log(`[wh] findByEmail: NO MATCH for "${target}"`);
    return null;
  };

  // (2) stripe_customer_id → existing profiles row id.
  const findUserIdByCustomer = async (customerId) => {
    if (!customerId) return null;
    const { data, error } = await admin.from("profiles").select("id").eq("stripe_customer_id", customerId).maybeSingle();
    if (error) { console.error("[wh] findByCustomer error:", error.message); return null; }
    console.log(`[wh] findByCustomer: ${customerId} → ${data?.id || "NO MATCH"}`);
    return data?.id || null;
  };

  const emailFromCustomer = async (customerId) => {
    if (!customerId) return null;
    try { const c = await stripe.customers.retrieve(customerId); return c && !c.deleted ? c.email : null; }
    catch (e) { console.error("[wh] customers.retrieve failed:", e.message); return null; }
  };

  // Write is_pro=true to BOTH the profiles table and auth.users metadata, then
  // READ BACK the profiles row to prove the write landed in THIS project.
  const activatePro = async ({ userId, customerId, subscriptionId, source }) => {
    if (!userId) {
      console.error(`[wh] ${source}: cannot activate — no user id resolved`);
      return false;
    }
    // profiles table (the column the app reads is `is_pro`, boolean)
    const patch = { id: userId, is_pro: true };
    if (customerId) patch.stripe_customer_id = customerId;
    if (subscriptionId) patch.subscription_id = subscriptionId;
    const { error: upErr } = await admin.from("profiles").upsert(patch, { onConflict: "id" });
    if (upErr) console.error(`[wh] ${source}: profiles upsert ERROR:`, upErr.message);

    // auth.users user_metadata (belt-and-suspenders)
    const { error: metaErr } = await admin.auth.admin.updateUserById(userId, { user_metadata: { is_pro: true } });
    if (metaErr) console.error(`[wh] ${source}: updateUserById ERROR:`, metaErr.message);
    else console.log(`[wh] ${source}: auth.users metadata is_pro=true for ${userId}`);

    // READ BACK — definitive proof of what's in the profiles table now.
    const { data: row, error: readErr } = await admin
      .from("profiles").select("id, is_pro, stripe_customer_id").eq("id", userId).maybeSingle();
    if (readErr) console.error(`[wh] ${source}: read-back ERROR:`, readErr.message);
    else console.log(`[wh] ${source}: PROFILES NOW →`, JSON.stringify(row));

    return !!row?.is_pro;
  };

  // Grant flow: resolve user (email → customer-id → metadata id), then activate.
  const grantPro = async ({ userId, email, customerId, subscriptionId, source }) => {
    console.log(`[wh] ${source}: email from Stripe = "${email || "(none)"}", client/metadata id = "${userId || "(none)"}", customer = "${customerId || "(none)"}"`);
    let resolvedId = (await findUserIdByEmail(email))   // (1) email first, as requested
      || (await findUserIdByCustomer(customerId))       // (2) then stripe_customer_id
      || userId                                         // (3) then client_reference_id / metadata
      || null;
    console.log(`[wh] ${source}: resolved user id = ${resolvedId || "NONE"}`);
    if (!resolvedId) { console.error(`[wh] ${source}: COULD NOT GRANT PRO — user not found by email, customer id, or reference id.`); return; }
    await activatePro({ userId: resolvedId, customerId, subscriptionId, source });
  };

  // Generic profile patch (status fields) by user id or customer id.
  const updateProfile = async ({ userId, customerId, patch }) => {
    let result;
    if (userId) result = await admin.from("profiles").upsert({ id: userId, ...patch }, { onConflict: "id" }).select("id");
    else if (customerId) result = await admin.from("profiles").update(patch).eq("stripe_customer_id", customerId).select("id");
    else { console.warn(`[wh] ${event.type}: no id/customer — skipped`); return; }
    const { data, error } = result;
    if (error) console.error(`[wh] ${event.type}: DB ERROR:`, error.message);
    else console.log(`[wh] ${event.type}: wrote ${data?.length ?? 0} row(s) ·`, JSON.stringify(patch));
  };

  const trialIso = (s) => (s.trial_end ? new Date(s.trial_end * 1000).toISOString() : null);
  const periodEndIso = (s) => (s.current_period_end ? new Date(s.current_period_end * 1000).toISOString() : null);
  const planFrom = (s) => { const i = s.items?.data?.[0]?.price?.recurring?.interval; return i === "year" ? "yearly" : i === "month" ? "monthly" : null; };

  // ── Handle events ────────────────────────────────────────────────────
  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const s = event.data.object;
        await grantPro({
          userId: s.client_reference_id || s.metadata?.supabase_user_id,
          email: s.customer_details?.email || s.customer_email || null,
          customerId: s.customer,
          subscriptionId: s.subscription || undefined,
          source: "checkout.session.completed",
        });
        break;
      }

      case "customer.subscription.created": {
        const sub = event.data.object;
        // A new subscription is "trialing" for the 7-day trial (or "active"
        // if no trial). BOTH count as Pro.
        const pro = ACTIVE.includes(sub.status);
        console.log(`[wh] subscription.created status=${sub.status} → is_pro=${pro}`);
        const email = await emailFromCustomer(sub.customer);
        if (pro) {
          await grantPro({
            userId: sub.metadata?.supabase_user_id,
            email,
            customerId: sub.customer,
            subscriptionId: sub.id,
            source: "customer.subscription.created",
          });
        }
        await updateProfile({
          userId: sub.metadata?.supabase_user_id, customerId: sub.customer,
          patch: {
            is_pro: pro, // trialing OR active ⇒ Pro
            stripe_customer_id: sub.customer, subscription_id: sub.id, subscription_status: sub.status,
            trial_end: trialIso(sub), subscription_plan: planFrom(sub),
            current_period_end: periodEndIso(sub), cancel_at_period_end: !!sub.cancel_at_period_end,
          },
        });
        break;
      }

      case "customer.subscription.updated": {
        const sub = event.data.object;
        const isPro = ACTIVE.includes(sub.status) ? true : INACTIVE.includes(sub.status) ? false : undefined;
        const patch = {
          subscription_status: sub.status, subscription_id: sub.id, trial_end: trialIso(sub),
          subscription_plan: planFrom(sub), current_period_end: periodEndIso(sub), cancel_at_period_end: !!sub.cancel_at_period_end,
        };
        if (isPro !== undefined) patch.is_pro = isPro;
        await updateProfile({ userId: sub.metadata?.supabase_user_id, customerId: sub.customer, patch });
        break;
      }

      case "customer.subscription.deleted": {
        const sub = event.data.object;
        await updateProfile({
          userId: sub.metadata?.supabase_user_id, customerId: sub.customer,
          patch: { is_pro: false, subscription_id: null, subscription_status: "canceled", trial_end: null, current_period_end: null, cancel_at_period_end: false },
        });
        break;
      }

      case "invoice.payment_succeeded": {
        const inv = event.data.object;
        const email = inv.customer_email || await emailFromCustomer(inv.customer);
        await grantPro({ email, customerId: inv.customer, source: "invoice.payment_succeeded" });
        break;
      }

      case "invoice.payment_failed": {
        const inv = event.data.object;
        await updateProfile({ customerId: inv.customer, patch: { is_pro: false } });
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
