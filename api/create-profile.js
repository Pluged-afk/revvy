import sql, { readBody } from "./db.js";

// Ensure a profile row exists for the signed-in Clerk user. Idempotent.
// id and clerk_user_id are both set to the Clerk user id.
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const { userId, email } = await readBody(req);
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
    console.error("[create-profile]", e.message);
    return res.status(500).json({ error: e.message });
  }
}
