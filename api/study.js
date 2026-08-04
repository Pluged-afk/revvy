import { verifyToken } from "@clerk/backend";
import sql, { readBody } from "./db.js";

// Server-synced study data (spaced-repetition deck, stats/streak, exam date,
// study plans). Kept as ONE serverless function + ONE JSONB row per user to
// stay under the Vercel Hobby plan's 12-function limit.
//   GET  /api/study            → { data }  (the user's blob, or {} if none)
//   POST /api/study { data }   → upsert the blob (last-write-wins)
// The Clerk session token (Authorization: Bearer <token>) is verified
// server-side; the user id comes from the token, never the client.

// Self-provision the table (idempotent) so the endpoint works even if
// /api/init-db hasn't been run yet. Cached per warm lambda instance.
let ensured = null;
function ensureTable() {
  if (!ensured) {
    ensured = sql`
      CREATE TABLE IF NOT EXISTS study_data (
        clerk_user_id TEXT PRIMARY KEY,
        data          JSONB       NOT NULL DEFAULT '{}'::jsonb,
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`.then(() => true).catch(() => { ensured = null; return false; });
  }
  return ensured;
}

async function userFromToken(req) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return null;
  try {
    const payload = await verifyToken(token, { secretKey: process.env.CLERK_SECRET_KEY });
    return payload.sub || null;
  } catch (e) {
    console.error("[study] token verify failed:", e.message);
    return null;
  }
}

export default async function handler(req, res) {
  const userId = await userFromToken(req);
  if (!userId) return res.status(401).json({ error: "Invalid session." });

  try {
    await ensureTable();
    if (req.method === "GET") {
      const rows = await sql`SELECT data FROM study_data WHERE clerk_user_id = ${userId} LIMIT 1`;
      return res.status(200).json({ data: rows[0]?.data || {} });
    }

    if (req.method === "POST") {
      const body = await readBody(req);
      const data = body?.data;
      if (data == null || typeof data !== "object" || Array.isArray(data)) {
        return res.status(400).json({ error: "Missing or invalid data." });
      }
      await sql`
        INSERT INTO study_data (clerk_user_id, data, updated_at)
        VALUES (${userId}, ${JSON.stringify(data)}::jsonb, NOW())
        ON CONFLICT (clerk_user_id) DO UPDATE
          SET data = EXCLUDED.data, updated_at = NOW()`;
      return res.status(200).json({ ok: true });
    }

    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("[study]", e.message);
    return res.status(500).json({ error: e.message });
  }
}
