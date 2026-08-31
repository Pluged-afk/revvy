// ── Rewards economy: power-up wallet, streak savers, universal streak ─────────
// Power-ups (freeze, hint, skip) are earned at the END of any activity and spent
// across ALL modes (endless arena, quizzes, exams). Streak savers are earned per
// 500 questions answered in study modes (quiz/exam/mock, NOT the arena) and
// silently protect the daily streak. The streak itself counts ANY activity.
// Pure functions so the logic is testable and shared.

// Strength order, weakest to strongest: hint < freeze < skip. Stronger power-ups
// are rarer, so they carry a lower cap (a limit that nudges players to spend, not
// hoard, since they cannot bank past it).
export const POWERUP_CAP = { hint: 9, freeze: 6, skip: 4 };
export const POWERUPS = ["hint", "freeze", "skip"];
// Each saver now rescues an ENTIRE lapse (any number of missed days), so it is
// far more powerful than a one-day patch: the cap is kept small on purpose.
export const SAVER_CAP = 3;
export const SAVER_EVERY = 500;   // study-mode questions per streak saver
export const SAVER_MAX_GAP = 15;  // a saver rescues an absence up to this many days; gone longer, every saver is wiped

const capOf = (k) => POWERUP_CAP[k] || 0;
const clampCount = (v, k) => Math.max(0, Math.min(capOf(k), Math.floor(Number(v) || 0)));

export function normWallet(w) {
  w = (w && typeof w === "object") ? w : {};
  return { hint: clampCount(w.hint, "hint"), freeze: clampCount(w.freeze, "freeze"), skip: clampCount(w.skip, "skip") };
}

// Which power-up an ENDLESS run earns, from its final score. Best tier reached;
// tuned so most decent runs earn a hint, strong runs a freeze, great runs a skip.
export function arenaEarn(score) {
  const s = Number(score) || 0;
  if (s >= 3000) return "skip";
  if (s >= 1000) return "freeze";
  if (s >= 300) return "hint";
  return null;
}
// Which power-up PASSING a quiz/exam earns, from the fraction correct. Below the
// pass line (60%) earns nothing, exactly as "only when you pass".
export function passEarn(correct, total) {
  const pct = total ? (Number(correct) || 0) / total : 0;
  if (pct >= 0.95) return "skip";
  if (pct >= 0.80) return "freeze";
  if (pct >= 0.60) return "hint";
  return null;
}

// Add one power-up of `type` to the wallet, capped (excess is discarded).
export function walletAdd(wallet, type) {
  const w = normWallet(wallet);
  if (!type || !(type in POWERUP_CAP)) return w;
  return { ...w, [type]: Math.min(capOf(type), w[type] + 1) };
}
// Subtract the power-ups a run spent.
export function walletSpend(wallet, used) {
  const w = normWallet(wallet); const u = used || {};
  return {
    hint: Math.max(0, w.hint - (parseInt(u.hint, 10) || 0)),
    freeze: Math.max(0, w.freeze - (parseInt(u.freeze, 10) || 0)),
    skip: Math.max(0, w.skip - (parseInt(u.skip, 10) || 0)),
  };
}

// Add study-mode questions toward streak savers. One saver per SAVER_EVERY, up to
// SAVER_CAP; progress stops accruing once the saver bank is full.
export function addSaverProgress(savedProgress, streakSavers, nQuestions) {
  let prog = (Number(savedProgress) || 0) + Math.max(0, Math.floor(Number(nQuestions) || 0));
  let savers = Math.max(0, Math.min(SAVER_CAP, Number(streakSavers) || 0));
  while (prog >= SAVER_EVERY && savers < SAVER_CAP) { savers += 1; prog -= SAVER_EVERY; }
  if (savers >= SAVER_CAP) prog = Math.min(prog, SAVER_EVERY - 1);
  return { savedProgress: prog, streakSavers: savers };
}

const daysBetween = (a, b) => {
  const da = new Date(a + "T00:00:00"), db = new Date(b + "T00:00:00");
  return Math.round((db - da) / 86400000);
};

// Advance the streak for today's activity. A single streak saver rescues the
// WHOLE streak after a lapse, no matter how many days were missed (not one per
// day), spent silently. One exception: if more than SAVER_MAX_GAP days have
// passed since the last activity, the lapse is too long to rescue, the streak
// resets, AND every saved-up saver is wiped. ANY activity feeds this: a quiz,
// an exam, a mock, or an arena run.
export function tickStreak({ streak = 0, best = 0, lastActive = null, streakSavers = 0 }, today, yesterday) {
  if (lastActive === today) return { streak, best: Math.max(best, streak), lastActive, streakSavers };
  let savers = Math.max(0, Number(streakSavers) || 0);
  let ns;
  if (lastActive === yesterday) {
    ns = streak + 1;                                     // consecutive day: no saver needed
  } else if (lastActive) {
    const gap = daysBetween(lastActive, today);          // days since the last activity
    if (gap > SAVER_MAX_GAP) { ns = 1; savers = 0; }     // gone too long: reset AND wipe every saver
    else if (savers >= 1) { savers -= 1; ns = streak + 1; } // one saver rescues the whole lapse
    else ns = 1;                                         // no saver left: streak resets
  } else {
    ns = 1;                                              // first ever activity
  }
  return { streak: ns, best: Math.max(best, ns), lastActive: today, streakSavers: savers };
}
