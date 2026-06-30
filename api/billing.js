import Stripe from "stripe";
import { verifyToken } from "@clerk/backend";
import sql, { readBody } from "./db.js";

// Consolidated Stripe endpoint (kept as ONE serverless function to stay under
// the Vercel Hobby plan's 12-function limit). All POST, routed by `action`:
//   { action: "checkout" } → subscription Checkout session (Pro)
//   { action: "portal" }   → Customer Portal (manage / cancel)
//   { action: "pack" }     → one-time question-pack Checkout (token-verified)
//   Test card: 4242 4242 4242 4242 · any future expiry · any CVC.

const SITE_URL_FALLBACK = process.env.SITE_URL || "https://revyy.app";

const PACKS = {
  A: { questions: 500,  priceId: "price_1TiAaMGXyNWRBegivLyWO6So" },
  B: { questions: 1500, priceId: "price_1TiAbpGXyNWRBegi8Hdv9GGB" },
  C: { questions: 3000, priceId: "price_1TiAcbGXyNWRBegioXFNLBKW" },
};

function getBaseUrl(req) {
  const origin = req.headers.origin;
  if (origin && /^https?:\/\//.test(origin)) return origin.replace(/\/$/, "");
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const proto = req.headers["x-forwarded-proto"] || "https";
  if (host) return `${proto}://${host}`.replace(/\/$/, "");
  return SITE_URL_FALLBACK;
}

// action=checkout: creates a Stripe Checkout session (subscription, charged
// immediately — no trial) and returns its URL.
async function checkout(req, res, stripe, body) {
  const { priceId, userId, userEmail } = body;
  if (!priceId || !userId) return res.status(400).json({ error: "Missing priceId or userId." });

  // Reuse the saved Stripe customer if this user already has one.
  let existingCustomerId = null;
  try {
    const rows = await sql`SELECT stripe_customer_id FROM profiles WHERE id = ${userId} LIMIT 1`;
    existingCustomerId = rows[0]?.stripe_customer_id || null;
  } catch (e) {
    console.warn("[billing:checkout] Neon lookup failed:", e.message);
  }

  const baseUrl = getBaseUrl(req);
  const meta = { clerk_user_id: userId, email: userEmail || "" };
  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: { metadata: meta },
      payment_method_collection: "always",
      automatic_tax: { enabled: true },
      client_reference_id: userId,
      metadata: meta,
      ...(existingCustomerId ? { customer: existingCustomerId } : { customer_email: userEmail || undefined }),
      allow_promotion_codes: true,
      success_url: `${baseUrl}/app?upgraded=true`,
      cancel_url: `${baseUrl}/pricing`,
    });
    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error("[billing:checkout] Stripe error:", err);
    return res.status(500).json({ error: err.message || "Could not create checkout session." });
  }
}

// action=portal: opens the Stripe Customer Portal (manage / cancel).
async function portal(req, res, stripe, body) {
  const { userId, flow } = body;
  if (!userId) return res.status(400).json({ error: "Missing userId." });

  let customerId, subscriptionId;
  try {
    const rows = await sql`SELECT stripe_customer_id, subscription_id FROM profiles WHERE id = ${userId} LIMIT 1`;
    customerId = rows[0]?.stripe_customer_id;
    subscriptionId = rows[0]?.subscription_id;
  } catch (e) {
    console.error("[billing:portal] Neon lookup failed:", e.message);
  }
  if (!customerId) return res.status(400).json({ error: "No subscription found for this account yet." });

  try {
    const params = { customer: customerId, return_url: `${getBaseUrl(req)}/app` };
    if (flow === "cancel" && subscriptionId) {
      params.flow_data = { type: "subscription_cancel", subscription_cancel: { subscription: subscriptionId } };
    }
    const session = await stripe.billingPortal.sessions.create(params);
    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error("[billing:portal] Stripe error:", err);
    return res.status(500).json({ error: err.message || "Could not open billing portal." });
  }
}

// action=pack: one-time purchase of a question pack. On success the webhook
// credits bonus_questions_remaining. Clerk token verified server-side.
async function pack(req, res, stripe, body) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing token." });

  let userId;
  try {
    const payload = await verifyToken(token, { secretKey: process.env.CLERK_SECRET_KEY });
    userId = payload.sub;
  } catch {
    return res.status(401).json({ error: "Invalid session." });
  }

  const p = PACKS[body.pack];
  if (!p) return res.status(400).json({ error: "Unknown pack." });

  // Packs are available to all users (free or Pro). Look up the profile only to
  // reuse the saved Stripe customer / email — no Pro gate.
  let row = {};
  try {
    const rows = await sql`SELECT email, stripe_customer_id FROM profiles WHERE clerk_user_id = ${userId} OR id = ${userId} LIMIT 1`;
    row = rows[0] || {};
  } catch (e) {
    console.error("[billing:pack] lookup failed:", e.message);
  }

  const baseUrl = getBaseUrl(req);
  const meta = { type: "question_pack", clerk_user_id: userId, pack: body.pack, questions: String(p.questions) };
  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{ price: p.priceId, quantity: 1 }],
      payment_intent_data: { metadata: meta },
      client_reference_id: userId,
      metadata: meta,
      ...(row.stripe_customer_id ? { customer: row.stripe_customer_id } : { customer_email: row.email || undefined }),
      success_url: `${baseUrl}/app?pack=success`,
      cancel_url: `${baseUrl}/app`,
    });
    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error("[billing:pack] Stripe error:", err.message);
    return res.status(500).json({ error: err.message || "Could not start checkout." });
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
  if (!STRIPE_SECRET_KEY) return res.status(500).json({ error: "Server missing STRIPE_SECRET_KEY." });

  const body = await readBody(req);
  const stripe = new Stripe(STRIPE_SECRET_KEY);

  if (body.action === "checkout") return checkout(req, res, stripe, body);
  if (body.action === "portal") return portal(req, res, stripe, body);
  if (body.action === "pack") return pack(req, res, stripe, body);
  return res.status(400).json({ error: "Unknown action." });
}
