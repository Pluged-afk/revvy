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

// Shape the client consumes. `remaining` already folds in the pack bonus.
function shape(row) {
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
  };
}

// Reset questions_used_today / ad_watches_today when the date rolls over, then
// return the current counters. Atomic — uses CURRENT_DATE on the server.
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

    if (req.method === "GET") return res.status(200).json(shape(row));

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

      return res.status(400).json({ error: "Unknown action." });
    }

    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("[usage]", e.message);
    return res.status(500).json({ error: e.message });
  }
}
