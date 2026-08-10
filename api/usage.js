import { verifyToken } from "@clerk/backend";
import sql, { readBody } from "./db.js";

// Question-limit / usage state for the signed-in user.
//   GET  /api/usage                      → current usage (after daily reset)
//   POST /api/usage {action:"consume", count}  → consume N questions
//   POST /api/usage {action:"watch-ad"}        → free: +1 ad watch (+10/day)
// The Clerk token is verified server-side; the user id comes from the token.

const FREE_DAILY = 50;
const PRO_DAILY = 250;
const AD_BONUS = 10;        // questions granted per ad watch (free)
const MAX_AD_WATCHES = 2;   // ads per day (free)
const MOCK_DAILY_CAP = 2;   // full mock exams per day (Pro-only)

// Shape the client consumes. `remaining` already folds in the pack bonus.
// `mocksUsed` is read separately (self-healing path), so it's passed in.
function shape(row, mocksUsed = 0) {
  const isPro = row?.is_pro === true;
  const used = row?.questions_used_today || 0;
  const bonus = row?.bonus_questions_remaining || 0;
  const adWatches = row?.ad_watches_today || 0;
  const dailyLimit = isPro ? PRO_DAILY : FREE_DAILY + adWatches * AD_BONUS;
  return {
    is_pro: isPro,
    questions_used_today: used,
    daily_limit: dailyLimit,
    bonus_questions_remaining: bonus,
    ad_watches_today: adWatches,
    max_ad_watches: isPro ? 0 : MAX_AD_WATCHES,
    ad_question_bonus: AD_BONUS,
    remaining: Math.max(0, dailyLimit - used) + bonus,
    mocks_used_today: mocksUsed,
    mock_daily_cap: MOCK_DAILY_CAP,
    mocks_remaining: isPro ? Math.max(0, MOCK_DAILY_CAP - mocksUsed) : 0,
  };
}

// Reset questions_used_today / ad_watches_today when the date rolls over, then
// return the current counters. Atomic, uses CURRENT_DATE on the server.
// Deliberately does NOT touch the mock columns, so this core path can never
// break if the mock migration hasn't been applied yet.
async function resetAndRead(userId) {
  const rows = await sql`
    UPDATE profiles SET
      questions_used_today = CASE WHEN last_reset_date IS DISTINCT FROM CURRENT_DATE THEN 0 ELSE questions_used_today END,
      last_reset_date      = CURRENT_DATE,
      ad_watches_today     = CASE WHEN last_ad_reset_date IS DISTINCT FROM CURRENT_DATE THEN 0 ELSE ad_watches_today END,
      last_ad_reset_date   = CURRENT_DATE
    WHERE clerk_user_id = ${userId} OR id = ${userId}
    RETURNING is_pro, questions_used_today, bonus_questions_remaining, ad_watches_today`;
  return rows[0] || null;
}

// Mock-exam usage lives in its own self-healing path: the columns are created on
// first use (ADD COLUMN IF NOT EXISTS), so no manual migration is required and a
// missing column never breaks the core usage above. Returns today's mock count.
let mockColsReady = false;
async function readMockUsage(userId, ensureCols) {
  try {
    if (ensureCols && !mockColsReady) {
      await sql`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS mocks_used_today INTEGER DEFAULT 0`;
      await sql`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS last_mock_reset_date DATE`;
      mockColsReady = true;
    }
    const rows = await sql`
      UPDATE profiles SET
        mocks_used_today     = CASE WHEN last_mock_reset_date IS DISTINCT FROM CURRENT_DATE THEN 0 ELSE mocks_used_today END,
        last_mock_reset_date = CURRENT_DATE
      WHERE clerk_user_id = ${userId} OR id = ${userId}
      RETURNING mocks_used_today`;
    return rows[0]?.mocks_used_today || 0;
  } catch { return 0; } // columns not there yet → treat as 0 used
}

export default async function handler(req, res) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing token." });

  let userId;
  try {
    const payload = await verifyToken(token, { secretKey: process.env.CLERK_SECRET_KEY });
    userId = payload.sub;
  } catch (e) {
    console.error("[usage] token verify failed:", e.message);
    return res.status(401).json({ error: "Invalid session." });
  }
  if (!userId) return res.status(401).json({ error: "No user in token." });

  try {
    const row = await resetAndRead(userId);
    if (!row) return res.status(200).json(shape(null)); // no profile yet → free defaults

    if (req.method === "GET") { const mu = await readMockUsage(userId, false); return res.status(200).json(shape(row, mu)); }

    if (req.method === "POST") {
      const body = await readBody(req);
      const action = body.action;

      if (action === "consume") {
        const count = Math.max(1, Math.min(parseInt(body.count, 10) || 0, 100));
        const cur = shape(row);
        const remainingDaily = Math.max(0, cur.daily_limit - cur.questions_used_today);
        const total = remainingDaily + cur.bonus_questions_remaining;
        if (count > total) return res.status(200).json({ allowed: false, ...cur });
        const fromDaily = Math.min(count, remainingDaily);
        const fromBonus = count - fromDaily;
        const updated = await sql`
          UPDATE profiles SET
            questions_used_today = questions_used_today + ${fromDaily},
            bonus_questions_remaining = bonus_questions_remaining - ${fromBonus}
          WHERE clerk_user_id = ${userId} OR id = ${userId}
          RETURNING is_pro, questions_used_today, bonus_questions_remaining, ad_watches_today`;
        return res.status(200).json({ allowed: true, ...shape(updated[0]) });
      }

      if (action === "watch-ad") {
        if (row.is_pro === true) return res.status(400).json({ error: "Pro users don't watch ads.", ...shape(row) });
        if ((row.ad_watches_today || 0) >= MAX_AD_WATCHES) return res.status(200).json({ allowed: false, ...shape(row) });
        const updated = await sql`
          UPDATE profiles SET ad_watches_today = ad_watches_today + 1
          WHERE clerk_user_id = ${userId} OR id = ${userId}
          RETURNING is_pro, questions_used_today, bonus_questions_remaining, ad_watches_today`;
        return res.status(200).json({ allowed: true, ...shape(updated[0]) });
      }

      if (action === "consume-mock") {
        // Mocks are Pro-only and capped per day, account-tied + server-enforced.
        if (row.is_pro !== true) return res.status(200).json({ allowed: false, reason: "pro_only", ...shape(row) });
        const used = await readMockUsage(userId, true);   // self-heals the columns + applies the daily reset
        if (used >= MOCK_DAILY_CAP) return res.status(200).json({ allowed: false, reason: "daily_cap", ...shape(row, used) });
        const upd = await sql`
          UPDATE profiles SET mocks_used_today = mocks_used_today + 1
          WHERE clerk_user_id = ${userId} OR id = ${userId}
          RETURNING mocks_used_today`;
        return res.status(200).json({ allowed: true, ...shape(row, upd[0]?.mocks_used_today ?? used + 1) });
      }

      return res.status(400).json({ error: "Unknown action." });
    }

    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("[usage]", e.message);
    return res.status(500).json({ error: e.message });
  }
}
