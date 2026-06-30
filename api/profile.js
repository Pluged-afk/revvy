import { verifyToken } from "@clerk/backend";
import sql, { readBody } from "./db.js";

// Consolidated profile endpoint (kept as ONE serverless function to stay under
// the Vercel Hobby plan's 12-function limit). Routes by request:
//   GET  /api/profile                      → read the signed-in user's profile
//   POST /api/profile { action: "create" } → ensure a profile row exists
//   POST /api/profile { action: "delete" } → remove the user's profile row

// GET: returns the signed-in user's profile. The Clerk session token (sent as
// `Authorization: Bearer <token>`) is verified server-side and the user id is
// taken from the token — never trusted from the client.
async function getProfile(req, res) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing token.", is_pro: false });

  let userId;
  try {
    const payload = await verifyToken(token, { secretKey: process.env.CLERK_SECRET_KEY });
    userId = payload.sub;
  } catch (e) {
    console.error("[profile:get] token verify failed:", e.message);
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
    console.error("[profile:get]", e.message);
    return res.status(500).json({ error: e.message, is_pro: false });
  }
}

// POST action=create: ensure a profile row exists for the signed-in Clerk user.
// Idempotent. id and clerk_user_id are both set to the Clerk user id.
async function createProfile(req, res, body) {
  const { userId, email } = body;
  if (!userId) return res.status(400).json({ error: "Missing userId." });
  try {
    await sql`
      INSERT INTO profiles (id, clerk_user_id, email)
      VALUES (${userId}, ${userId}, ${email || null})
      ON CONFLICT (id) DO UPDATE
        SET email = COALESCE(EXCLUDED.email, profiles.email),
            clerk_user_id = COALESCE(profiles.clerk_user_id, EXCLUDED.clerk_user_id)`;
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("[profile:create]", e.message);
    return res.status(500).json({ error: e.message });
  }
}

// POST action=delete: removes the user's profile row from Neon. The Clerk user
// record itself is deleted client-side via clerkUser.delete() (a secure,
// self-only call), so no Clerk secret is needed here.
//
// NOTE (hardening): this trusts the userId in the body. For production, verify
// the Clerk session token (Authorization: Bearer …) with @clerk/backend before
// deleting, so a caller can only delete their own row.
async function deleteAccount(req, res, body) {
  const { userId } = body;
  if (!userId) return res.status(400).json({ error: "Missing userId." });
  try {
    await sql`DELETE FROM profiles WHERE id = ${userId}`;
    console.log("[profile:delete] removed profile row for", userId);
    return res.status(200).json({ success: true });
  } catch (e) {
    console.error("[profile:delete]", e.message);
    return res.status(500).json({ error: e.message });
  }
}

export default async function handler(req, res) {
  if (req.method === "GET") return getProfile(req, res);
  if (req.method === "POST") {
    const body = await readBody(req);
    if (body.action === "create") return createProfile(req, res, body);
    if (body.action === "delete") return deleteAccount(req, res, body);
    return res.status(400).json({ error: "Unknown action." });
  }
  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}
