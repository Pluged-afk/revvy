import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

// Creates a Stripe Checkout session (subscription, charged immediately — no
// trial) and returns its URL. The secret key stays server-side only.
//
// ── Testing (Stripe TEST mode) ───────────────────────────────────────
//   Test card:  4242 4242 4242 4242
//   Expiry:     any future date    CVC: any 3 digits    ZIP: any
//   Use the sk_test_/pk_test_ keys during development; switch to live
//   keys only when you're ready to launch.

// Final fallback only — the real return domain is derived from the request
// (origin header) so redirects always come back to the deployment the user is
// actually on, even on preview/custom domains. Override with SITE_URL env if set.
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
  const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!STRIPE_SECRET_KEY) return res.status(500).json({ error: "Server missing STRIPE_SECRET_KEY." });

  let body = req.body;
  if (!body || typeof body !== "object") {
    try { body = JSON.parse(await readRaw(req) || "{}"); } catch { body = {}; }
  }
  const { priceId, userId, userEmail } = body;
  if (!priceId || !userId) return res.status(400).json({ error: "Missing priceId or userId." });

  const stripe = new Stripe(STRIPE_SECRET_KEY);
  const baseUrl = getBaseUrl(req);

  // Pull email + any existing subscription info from Supabase.
  let email = userEmail;
  let existingCustomerId = null;
  try {
    if (SUPABASE_URL && SERVICE_ROLE_KEY) {
      const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      if (!email) {
        const { data } = await admin.auth.admin.getUserById(userId);
        email = data?.user?.email;
      }
      const { data: prof } = await admin
        .from("profiles")
        .select("stripe_customer_id")
        .eq("id", userId)
        .maybeSingle();
      existingCustomerId = prof?.stripe_customer_id || null;
    }
  } catch (e) {
    console.warn("[create-checkout] Supabase lookup failed:", e.message);
  }

  try {
    // No trial — the customer is charged immediately at checkout.
    const subscription_data = { metadata: { supabase_user_id: userId } };

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data,
      payment_method_collection: "always",
      automatic_tax: { enabled: true },
      client_reference_id: userId,
      metadata: { supabase_user_id: userId },
      // Reuse the saved customer if we have one, else pre-fill the email.
      ...(existingCustomerId ? { customer: existingCustomerId } : { customer_email: email || undefined }),
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

async function readRaw(req) {
  const chunks = [];
  for await (const c of req) chunks.push(typeof c === "string" ? Buffer.from(c) : c);
  return Buffer.concat(chunks).toString("utf8");
}
