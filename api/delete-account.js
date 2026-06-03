import { createClient } from "@supabase/supabase-js";

// Vercel serverless function: permanently delete the calling user's account.
// The service-role key lives only here (server-side) and is never sent to the browser.
//
// Required environment variables:
//   SUPABASE_URL                — your project URL
//   SUPABASE_SERVICE_ROLE_KEY   — Supabase → Settings → API Keys → Secret key  (KEEP SECRET)

const log = (...a) => console.log("[delete-account]", ...a);
const err = (...a) => console.error("[delete-account]", ...a);

export default async function handler(req, res) {
  log(`${req.method} request received`);

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const SUPABASE_URL =
    process.env.SUPABASE_URL || "https://xzpwfqmoewrmmocriqfn.supabase.co";

  // Explicitly log what the server actually read for the key (first 10 chars).
  const rawEnv = process.env.SUPABASE_SERVICE_ROLE_KEY;
  log(
    "SUPABASE_SERVICE_ROLE_KEY read as:",
    rawEnv === undefined ? "(undefined — not in the loaded .env)"
      : `"${String(rawEnv).slice(0, 10)}…" (length ${String(rawEnv).length})`
  );

  // Guard against junk/placeholder values being treated as a real key.
  const rawKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  const SERVICE_ROLE_KEY =
    !rawKey || rawKey === "undefined" || rawKey === "null" || rawKey.startsWith("your-")
      ? "" : rawKey;

  log("service key present:", !!SERVICE_ROLE_KEY,
      SERVICE_ROLE_KEY ? `(prefix ${SERVICE_ROLE_KEY.slice(0, 10)}…, len ${SERVICE_ROLE_KEY.length})` : "");

  if (!SERVICE_ROLE_KEY) {
    err("aborting: SUPABASE_SERVICE_ROLE_KEY is not set in the server environment");
    return res.status(500).json({
      error: "Server is not configured. SUPABASE_SERVICE_ROLE_KEY is missing from the environment (check revvy/.env and restart the dev server).",
    });
  }

  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) {
    err("aborting: no Bearer token on the request");
    return res.status(401).json({ error: "Missing authorization token." });
  }

  const ANON_KEY = process.env.SUPABASE_ANON_KEY;

  // 1) Verify the caller's token using the publishable/anon key.
  log("verifying user token…");
  const authClient = createClient(SUPABASE_URL, ANON_KEY || SERVICE_ROLE_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: { user }, error: userErr } = await authClient.auth.getUser();
  if (userErr || !user) {
    err("token verification failed:", userErr?.message);
    return res.status(401).json({
      error: `Invalid or expired session${userErr?.message ? `: ${userErr.message}` : "."}`,
    });
  }
  const userId = user.id;
  log("token OK, user id:", userId);

  // Admin client (service-role key) for the actual deletion.
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // 2) Delete all per-user data. Add a row per table that stores user data.
  const USER_TABLES = [
    { table: "profiles", column: "id" },
    // { table: "quizzes",      column: "user_id" },
    // { table: "quiz_history", column: "user_id" },
  ];
  for (const { table, column } of USER_TABLES) {
    log(`deleting from "${table}" where ${column} = ${userId}…`);
    const { error } = await admin.from(table).delete().eq(column, userId);
    if (error) {
      err(`delete from "${table}" failed:`, error);
      return res.status(500).json({
        error: `Failed to delete data from "${table}": ${error.message}`,
        code: error.code,
        hint: error.hint,
      });
    }
  }

  // 3) Delete the auth user itself (requires the service-role key).
  log("deleting auth user…");
  const { error: delErr } = await admin.auth.admin.deleteUser(userId);
  if (delErr) {
    err("deleteUser failed:", delErr);
    return res.status(500).json({ error: `Failed to delete account: ${delErr.message}` });
  }

  log("account deleted successfully:", userId);
  return res.status(200).json({ success: true });
}
