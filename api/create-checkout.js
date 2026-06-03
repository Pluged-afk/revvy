import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

// Creates a Stripe Checkout session (subscription, 7-day free trial) and
// returns its URL. The secret key stays server-side.

const SITE_URL = "https://revyy.vercel.app";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
  const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!STRIPE_SECRET_KEY) return res.status(500).json({ error: "Server missing STRIPE_SECRET_KEY." });

  let body = req.body;
  if (!body || typeof body !== "object") {
    try { body = JSON.parse(await readRaw(req) || "{}"); } catch { body = {}; }
  }
  const { priceId, userId } = body;
  if (!priceId || !userId) return res.status(400).json({ error: "Missing priceId or userId." });

  const stripe = new Stripe(STRIPE_SECRET_KEY);

  // Look up the user's email from Supabase to pre-fill checkout.
  let email;
  try {
    if (SUPABASE_URL && SERVICE_ROLE_KEY) {
      const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const { data } = await admin.auth.admin.getUserById(userId);
      email = data?.user?.email;
    }
  } catch (e) {
    console.warn("[create-checkout] could not fetch user email:", e.message);
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: {
        trial_period_days: 7,
        metadata: { userId },
      },
      client_reference_id: userId,
      metadata: { userId },
      customer_email: email || undefined,
      allow_promotion_codes: true,
      success_url: `${SITE_URL}/app?upgraded=true`,
      cancel_url: `${SITE_URL}/pricing`,
    });
    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error("[create-checkout] Stripe error:", err);
    return res.status(500).json({ error: err.message || "Could not create checkout session." });
  }
}

async function readRaw(req) {
  const chunks = [];
  for await (const c of req) chunks.push(typeof c === "string" ? Buffer.from(c) : c);
  return Buffer.concat(chunks).toString("utf8");
}
