import { neon } from "@neondatabase/serverless";

// Single Neon SQL client for all serverless functions. DATABASE_URL is a
// server-only secret (never prefixed with VITE_). Use as a tagged template:
//   const rows = await sql`SELECT * FROM profiles WHERE id = ${id}`;
const sql = neon(process.env.DATABASE_URL);

export default sql;

// Small helper: read the raw request body (Vercel/Vite serverless functions).
export async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  const chunks = [];
  for await (const c of req) chunks.push(typeof c === "string" ? Buffer.from(c) : c);
  const raw = Buffer.concat(chunks).toString("utf8");
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}
