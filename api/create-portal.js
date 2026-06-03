import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

// Creates a Stripe Customer Portal session so the user can manage/cancel
// their subscription, and returns its URL.

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
  const { userId } = body;
  if (!userId) return res.status(400).json({ error: "Missing userId." });

  // Look up the user's Stripe customer id stored on their profile.
  let customerId;
  try {
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data } = await admin.from("profiles").select("stripe_customer_id").eq("id", userId).maybeSingle();
    customerId = data?.stripe_customer_id;
  } catch (e) {
    console.error("[create-portal] profile lookup failed:", e.message);
  }

  if (!customerId) {
    return res.status(400).json({ error: "No subscription found for this account yet." });
  }

  try {
    const stripe = new Stripe(STRIPE_SECRET_KEY);
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${SITE_URL}/app`,
    });
    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error("[create-portal] Stripe error:", err);
    return res.status(500).json({ error: err.message || "Could not open billing portal." });
  }
}

async function readRaw(req) {
  const chunks = [];
  for await (const c of req) chunks.push(typeof c === "string" ? Buffer.from(c) : c);
  return Buffer.concat(chunks).toString("utf8");
}
