import Stripe from "stripe";
import sql, { readBody } from "./db.js";

// Opens the Stripe Customer Portal (manage / cancel) for the signed-in user.
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

  const { userId, flow } = await readBody(req);
  if (!userId) return res.status(400).json({ error: "Missing userId." });

  let customerId, subscriptionId;
  try {
    const rows = await sql`SELECT stripe_customer_id, subscription_id FROM profiles WHERE id = ${userId} LIMIT 1`;
    customerId = rows[0]?.stripe_customer_id;
    subscriptionId = rows[0]?.subscription_id;
  } catch (e) {
    console.error("[create-portal] Neon lookup failed:", e.message);
  }

  if (!customerId) return res.status(400).json({ error: "No subscription found for this account yet." });

  try {
    const stripe = new Stripe(STRIPE_SECRET_KEY);
    const params = { customer: customerId, return_url: `${getBaseUrl(req)}/app` };
    if (flow === "cancel" && subscriptionId) {
      params.flow_data = { type: "subscription_cancel", subscription_cancel: { subscription: subscriptionId } };
    }
    const session = await stripe.billingPortal.sessions.create(params);
    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error("[create-portal] Stripe error:", err);
    return res.status(500).json({ error: err.message || "Could not open billing portal." });
  }
}
