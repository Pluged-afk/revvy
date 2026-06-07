import sql, { readBody } from "./db.js";

// Removes the user's profile row from Neon. The Clerk user record itself is
// deleted client-side via clerkUser.delete() (a secure, self-only call), so no
// Clerk secret is needed here.
//
// NOTE (hardening): this trusts the userId in the body. For production, verify
// the Clerk session token (Authorization: Bearer …) with @clerk/backend before
// deleting, so a caller can only delete their own row.
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const { userId } = await readBody(req);
  if (!userId) return res.status(400).json({ error: "Missing userId." });

  try {
    await sql`DELETE FROM profiles WHERE id = ${userId}`;
    console.log("[delete-account] removed profile row for", userId);
    return res.status(200).json({ success: true });
  } catch (e) {
    console.error("[delete-account]", e.message);
    return res.status(500).json({ error: e.message });
  }
}
