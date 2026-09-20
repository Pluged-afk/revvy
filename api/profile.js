import { verifyToken } from "@clerk/backend";
import sql, { readBody } from "./db.js";

// Public username column + case-insensitive unique index (lazy, cached).
let unameReady = false;
async function ensureUsernameCol() {
  if (unameReady) return;
  try {
    await sql`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS username TEXT`;
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS profiles_username_lower ON profiles (lower(username)) WHERE username IS NOT NULL`;
    await sql`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS language TEXT`;
    await sql`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS avatar_url TEXT`;
    unameReady = true;
  } catch (e) { console.error("[profile] username col:", e.message); }
}
async function userIdFromToken(req) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return null;
  try { const p = await verifyToken(token, { secretKey: process.env.CLERK_SECRET_KEY }); return p.sub || null; }
  catch { return null; }
}

// Consolidated profile endpoint (kept as ONE serverless function to stay under
// the Vercel Hobby plan's 12-function limit). Routes by request:
//   GET  /api/profile                      → read the signed-in user's profile
//   POST /api/profile { action: "create" } → ensure a profile row exists
//   POST /api/profile { action: "delete" } → remove the user's profile row

// GET: returns the signed-in user's profile. The Clerk session token (sent as
// `Authorization: Bearer <token>`) is verified server-side and the user id is
// taken from the token, never trusted from the client.
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
    await ensureUsernameCol();
    const rows = await sql`
      SELECT id, email, username, language, avatar_url, is_pro, stripe_customer_id, subscription_id,
             subscription_status, subscription_plan, current_period_end, cancel_at_period_end
      FROM profiles WHERE clerk_user_id = ${userId} OR id = ${userId} LIMIT 1`;
    const p = rows[0];
    if (!p) return res.status(200).json({ is_pro: false });
    return res.status(200).json({ ...p, avatar: p.avatar_url || null, is_pro: p.is_pro === true });
  } catch (e) {
    console.error("[profile:get]", e.message);
    return res.status(500).json({ error: "Could not load your profile.", is_pro: false });
  }
}

// POST action=create: ensure a profile row exists for the signed-in Clerk user.
// Idempotent. The user id comes from the verified session token (never the
// body), so a caller can only ever create or touch their own row.
// A safe avatar value: a preset avatar id (a short slug the client maps to a
// built-in icon), or an https image URL (kept for forward-compatibility). Anything
// else becomes null (falls back to the generated letter avatar). Never rendered
// as HTML, so a slug is inert.
function cleanAvatar(v) {
  if (typeof v !== "string") return null;
  if (/^https:\/\//i.test(v)) return v.slice(0, 500);
  if (/^[a-z0-9_-]{1,32}$/i.test(v)) return v.toLowerCase();
  return null;
}
async function createProfile(req, res, body) {
  const userId = await userIdFromToken(req);
  if (!userId) return res.status(401).json({ error: "Invalid session." });
  const { email } = body;
  const avatar = cleanAvatar(body.avatar);
  try {
    await ensureUsernameCol();
    // COALESCE keeps the user's chosen avatar: create runs on every sign-in and
    // carries no avatar, so it must never clear one. The avatar is set/cleared
    // only via action=setAvatar.
    await sql`
      INSERT INTO profiles (id, clerk_user_id, email, avatar_url)
      VALUES (${userId}, ${userId}, ${email || null}, ${avatar})
      ON CONFLICT (id) DO UPDATE
        SET email = COALESCE(EXCLUDED.email, profiles.email),
            clerk_user_id = COALESCE(profiles.clerk_user_id, EXCLUDED.clerk_user_id),
            avatar_url = COALESCE(EXCLUDED.avatar_url, profiles.avatar_url)`;
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("[profile:create]", e.message);
    return res.status(500).json({ error: "Could not create your profile." });
  }
}

// POST action=setAvatar: save the public URL of the photo the user just uploaded
// to Clerk, so friends and leaderboards can show it. Token-verified.
async function setAvatar(req, res, body) {
  const userId = await userIdFromToken(req);
  if (!userId) return res.status(401).json({ error: "Invalid session." });
  const avatar = cleanAvatar(body.avatar);
  await ensureUsernameCol();
  try {
    await sql`INSERT INTO profiles (id, clerk_user_id, avatar_url) VALUES (${userId}, ${userId}, ${avatar})
              ON CONFLICT (id) DO UPDATE SET avatar_url = EXCLUDED.avatar_url`;
    return res.status(200).json({ ok: true, avatar });
  } catch (e) {
    console.error("[profile:setAvatar]", e.message);
    return res.status(500).json({ error: "Could not save your photo." });
  }
}

// POST action=delete: fully erases the user's data across EVERY table, not just
// the profiles row (right-to-erasure). The Clerk user record itself is deleted
// client-side via clerkUser.delete() (a secure, self-only call). The user id
// comes from the verified session token, so a caller can only ever delete their
// own data, never someone else's.
//
// Best-effort + re-runnable: satellite wipes are caught individually and the
// profiles row is deleted LAST, so a hiccup on one table never leaves the account
// half-alive or blocks the client's Clerk-user deletion. Shared, de-identified
// pools (mock_bank / gk_pool / arena_contrib) carry no user id and are left as
// crowd knowledge; contact_rate is keyed by IP, not user.
async function deleteAccount(req, res) {
  const userId = await userIdFromToken(req);
  if (!userId) return res.status(401).json({ error: "Invalid session." });

  // 1) Study groups: leave each one, mirroring groupLeave so we never orphan a
  // group under a deleted owner. Empty groups (we were the last member) are torn
  // down with their content; otherwise ownership passes to the oldest member.
  try {
    const mine = await sql`SELECT group_id FROM group_members WHERE clerk_user_id = ${userId}`;
    for (const g of mine) {
      const gid = g.group_id;
      await sql`DELETE FROM group_members WHERE group_id = ${gid} AND clerk_user_id = ${userId}`;
      const remaining = await sql`SELECT clerk_user_id FROM group_members WHERE group_id = ${gid} ORDER BY joined_at ASC`;
      if (!remaining.length) {
        await Promise.allSettled([
          sql`DELETE FROM study_groups   WHERE id = ${gid}`,
          sql`DELETE FROM group_library  WHERE group_id = ${gid}`,
          sql`DELETE FROM group_activity WHERE group_id = ${gid}`,
          sql`DELETE FROM group_messages WHERE group_id = ${gid}`,
          sql`DELETE FROM group_reward   WHERE group_id = ${gid}`,
          sql`DELETE FROM group_challenges WHERE group_id = ${gid}`,
        ]);
      } else {
        await sql`UPDATE study_groups SET owner = ${remaining[0].clerk_user_id} WHERE id = ${gid} AND owner = ${userId}`;
        await sql`UPDATE group_members SET role = 'owner' WHERE group_id = ${gid} AND clerk_user_id = ${remaining[0].clerk_user_id}`;
      }
    }
  } catch (e) { console.error("[profile:delete] group handover failed:", e.message); }

  // 2) Wipe every row that belongs to this user across all tables (best-effort,
  // in parallel). Deleting friend_messages where recipient = me also removes the
  // thread the other party held with this now-erased account.
  const wipes = await Promise.allSettled([
    sql`DELETE FROM study_data              WHERE clerk_user_id = ${userId}`,
    sql`DELETE FROM shared_quizzes          WHERE data->>'ownerId' = ${userId}`,
    sql`DELETE FROM push_subs               WHERE clerk_user_id = ${userId}`,
    sql`DELETE FROM friendships             WHERE requester = ${userId} OR addressee = ${userId}`,
    sql`DELETE FROM friend_messages         WHERE sender = ${userId} OR recipient = ${userId}`,
    sql`DELETE FROM friend_challenge_scores WHERE clerk_user_id = ${userId}`,
    sql`DELETE FROM challenge_scores        WHERE clerk_user_id = ${userId}`,
    sql`DELETE FROM group_library           WHERE clerk_user_id = ${userId}`,
    sql`DELETE FROM group_activity          WHERE clerk_user_id = ${userId}`,
    sql`DELETE FROM group_messages          WHERE clerk_user_id = ${userId}`,
    sql`DELETE FROM group_reward            WHERE clerk_user_id = ${userId}`,
    sql`DELETE FROM group_challenges        WHERE created_by = ${userId}`,
    sql`DELETE FROM arena_score             WHERE clerk_user_id = ${userId}`,
    sql`DELETE FROM arena_season            WHERE clerk_user_id = ${userId}`,
    sql`DELETE FROM arena_league            WHERE clerk_user_id = ${userId}`,
    sql`DELETE FROM mock_actor              WHERE clerk_user_id = ${userId}`,
    sql`DELETE FROM mock_flag               WHERE clerk_user_id = ${userId}`,
    sql`DELETE FROM arena_contrib_actor     WHERE clerk_user_id = ${userId}`,
    sql`DELETE FROM ai_rate                 WHERE clerk_user_id = ${userId}`,
  ]);
  const failed = wipes.filter((r) => r.status === "rejected").length;
  if (failed) console.error(`[profile:delete] ${failed} satellite wipe(s) failed for ${userId} (re-runnable)`);

  // 3) Finally the profile row itself. This is the one that must succeed; do it
  // last so a satellite failure never blocks the client's Clerk-user deletion.
  try {
    await sql`DELETE FROM profiles WHERE clerk_user_id = ${userId} OR id = ${userId}`;
    console.log(`[profile:delete] erased account ${userId} (${wipes.length - failed}/${wipes.length} satellite tables clean)`);
    return res.status(200).json({ success: true });
  } catch (e) {
    console.error("[profile:delete]", e.message);
    return res.status(500).json({ error: "Could not delete the account. Please try again." });
  }
}

// POST action=setUsername: claim a public display name. Token-verified (the name
// is public and used on the leaderboard, so we take the user id from the session,
// never the body). Case-insensitive unique; a taken name returns 409.
async function setUsername(req, res, body) {
  const userId = await userIdFromToken(req);
  if (!userId) return res.status(401).json({ error: "Invalid session." });
  const name = String(body.username || "").trim();
  if (!/^[A-Za-z0-9_]{3,20}$/.test(name)) {
    return res.status(400).json({ error: "Use 3-20 letters, numbers or underscore.", invalid: true });
  }
  await ensureUsernameCol();
  try {
    await sql`INSERT INTO profiles (id, clerk_user_id) VALUES (${userId}, ${userId}) ON CONFLICT (id) DO NOTHING`;
    await sql`UPDATE profiles SET username = ${name} WHERE clerk_user_id = ${userId} OR id = ${userId}`;
    return res.status(200).json({ ok: true, username: name });
  } catch (e) {
    if (/duplicate|unique/i.test(e.message)) return res.status(409).json({ error: "That name is taken, try another.", taken: true });
    console.error("[profile:setUsername]", e.message);
    return res.status(500).json({ error: "Could not save your username." });
  }
}

// POST action=setLanguage: remember the signed-in user's language on their
// account so it follows them across devices. Token-verified.
async function setLanguage(req, res, body) {
  const userId = await userIdFromToken(req);
  if (!userId) return res.status(401).json({ error: "Invalid session." });
  const lang = String(body.language || "").trim().toLowerCase().slice(0, 8);
  if (!/^[a-z]{2}$/.test(lang)) return res.status(400).json({ error: "Invalid language." });
  await ensureUsernameCol();
  try {
    await sql`INSERT INTO profiles (id, clerk_user_id) VALUES (${userId}, ${userId}) ON CONFLICT (id) DO NOTHING`;
    await sql`UPDATE profiles SET language = ${lang} WHERE clerk_user_id = ${userId} OR id = ${userId}`;
    return res.status(200).json({ ok: true, language: lang });
  } catch (e) {
    console.error("[profile:setLanguage]", e.message);
    return res.status(500).json({ error: "Could not save your language." });
  }
}

export default async function handler(req, res) {
  if (req.method === "GET") return getProfile(req, res);
  if (req.method === "POST") {
    const body = await readBody(req);
    if (body.action === "create") return createProfile(req, res, body);
    if (body.action === "delete") return deleteAccount(req, res);
    if (body.action === "setUsername") return setUsername(req, res, body);
    if (body.action === "setLanguage") return setLanguage(req, res, body);
    if (body.action === "setAvatar") return setAvatar(req, res, body);
    return res.status(400).json({ error: "Unknown action." });
  }
  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}
