import sql from "./db.js";

// Returns the profile row for a Clerk user id. The frontend reads is_pro from
// here after sign-in and after returning from Stripe checkout.
export default async function handler(req, res) {
  // req.query is populated on Vercel; fall back to parsing the URL locally.
  let userId = req.query?.userId;
  if (!userId && req.url?.includes("?")) {
    userId = new URLSearchParams(req.url.split("?")[1]).get("userId");
  }
  if (!userId) return res.status(400).json({ error: "Missing userId." });

  try {
    const rows = await sql`
      SELECT id, email, is_pro, stripe_customer_id, subscription_id,
             subscription_status, subscription_plan, current_period_end, cancel_at_period_end
      FROM profiles WHERE id = ${userId} LIMIT 1`;
    const p = rows[0];
    if (!p) return res.status(200).json({ is_pro: false });
    return res.status(200).json(p);
  } catch (e) {
    console.error("[get-profile]", e.message);
    return res.status(500).json({ error: e.message });
  }
}
