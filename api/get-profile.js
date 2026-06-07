import { verifyToken } from "@clerk/backend";
import sql from "./db.js";

// Returns the signed-in user's profile. The Clerk session token (sent as
// `Authorization: Bearer <token>`) is verified server-side and the user id is
// taken from the token — never trusted from the client.
export default async function handler(req, res) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing token.", is_pro: false });

  let userId;
  try {
    const payload = await verifyToken(token, { secretKey: process.env.CLERK_SECRET_KEY });
    userId = payload.sub;
  } catch (e) {
    console.error("[get-profile] token verify failed:", e.message);
    return res.status(401).json({ error: "Invalid session.", is_pro: false });
  }
  if (!userId) return res.status(401).json({ error: "No user in token.", is_pro: false });

  try {
    const rows = await sql`
      SELECT id, email, is_pro, stripe_customer_id, subscription_id,
             subscription_status, subscription_plan, current_period_end, cancel_at_period_end
      FROM profiles WHERE clerk_user_id = ${userId} OR id = ${userId} LIMIT 1`;
    const p = rows[0];
    if (!p) return res.status(200).json({ is_pro: false });
    return res.status(200).json({ ...p, is_pro: p.is_pro === true });
  } catch (e) {
    console.error("[get-profile]", e.message);
    return res.status(500).json({ error: e.message, is_pro: false });
  }
}
