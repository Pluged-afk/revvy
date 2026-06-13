import Stripe from "stripe";
import { verifyToken } from "@clerk/backend";
import sql, { readBody } from "./db.js";

// One-time purchase of a question pack (Pro only). Uses inline price_data so no
// pre-created Stripe Price IDs are needed. On success the webhook credits
// bonus_questions_remaining. Clerk token verified server-side.

const PACKS = {
  A: { questions: 500,  amount: 199, label: "500 questions" },
  B: { questions: 1500, amount: 499, label: "1,500 questions" },
  C: { questions: 3000, amount: 899, label: "3,000 questions" },
};

function getBaseUrl(req) {
  const origin = req.headers.origin;
  if (origin && /^https?:\/\//.test(origin)) return origin.replace(/\/$/, "");
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const proto = req.headers["x-forwarded-proto"] || "https";
  if (host) return `${proto}://${host}`.replace(/\/$/, "");
  return process.env.SITE_URL || "https://revyy.app";
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
  if (!STRIPE_SECRET_KEY) return res.status(500).json({ error: "Server missing STRIPE_SECRET_KEY." });

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

  const { pack } = await readBody(req);
  const p = PACKS[pack];
  if (!p) return res.status(400).json({ error: "Unknown pack." });

  // Packs are Pro-only. Confirm against Neon (not the client).
  let row;
  try {
    const rows = await sql`SELECT is_pro, email, stripe_customer_id FROM profiles WHERE clerk_user_id = ${userId} OR id = ${userId} LIMIT 1`;
    row = rows[0];
  } catch (e) {
    console.error("[buy-pack] lookup failed:", e.message);
    return res.status(500).json({ error: "Lookup failed." });
  }
  if (!row?.is_pro) return res.status(403).json({ error: "Question packs are a Pro feature." });

  const stripe = new Stripe(STRIPE_SECRET_KEY);
  const baseUrl = getBaseUrl(req);
  const meta = { type: "question_pack", clerk_user_id: userId, pack, questions: String(p.questions) };

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{
        quantity: 1,
        price_data: {
          currency: "eur",
          unit_amount: p.amount,
          product_data: { name: `Revyy — ${p.label}` },
        },
      }],
      payment_intent_data: { metadata: meta },
      client_reference_id: userId,
      metadata: meta,
      ...(row.stripe_customer_id ? { customer: row.stripe_customer_id } : { customer_email: row.email || undefined }),
      success_url: `${baseUrl}/app?pack=success`,
      cancel_url: `${baseUrl}/app`,
    });
    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error("[buy-pack] Stripe error:", err.message);
    return res.status(500).json({ error: err.message || "Could not start checkout." });
  }
}
