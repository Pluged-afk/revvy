import Stripe from "stripe";
import sql, { readBody } from "./db.js";

// Creates a Stripe Checkout session (subscription, charged immediately — no
// trial) and returns its URL. The secret key stays server-side only.
//   Test card: 4242 4242 4242 4242 · any future expiry · any CVC.

const SITE_URL_FALLBACK = process.env.SITE_URL || "https://revyy.vercel.app";

function getBaseUrl(req) {
  const origin = req.headers.origin;
  if (origin && /^https?:\/\//.test(origin)) return origin.replace(/\/$/, "");
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const proto = req.headers["x-forwarded-proto"] || "https";
  if (host) return `${proto}://${host}`.replace(/\/$/, "");
  return SITE_URL_FALLBACK;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
  if (!STRIPE_SECRET_KEY) return res.status(500).json({ error: "Server missing STRIPE_SECRET_KEY." });

  const { priceId, userId, userEmail } = await readBody(req);
  if (!priceId || !userId) return res.status(400).json({ error: "Missing priceId or userId." });

  const stripe = new Stripe(STRIPE_SECRET_KEY);
  const baseUrl = getBaseUrl(req);

  // Reuse the saved Stripe customer if this user already has one.
  let existingCustomerId = null;
  try {
    const rows = await sql`SELECT stripe_customer_id FROM profiles WHERE id = ${userId} LIMIT 1`;
    existingCustomerId = rows[0]?.stripe_customer_id || null;
  } catch (e) {
    console.warn("[create-checkout] Neon lookup failed:", e.message);
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: { metadata: { user_id: userId } },
      payment_method_collection: "always",
      automatic_tax: { enabled: true },
      client_reference_id: userId,
      metadata: { user_id: userId },
      ...(existingCustomerId ? { customer: existingCustomerId } : { customer_email: userEmail || undefined }),
      allow_promotion_codes: true,
      success_url: `${baseUrl}/app?upgraded=true`,
      cancel_url: `${baseUrl}/pricing`,
    });
    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error("[create-checkout] Stripe error:", err);
    return res.status(500).json({ error: err.message || "Could not create checkout session." });
  }
}
