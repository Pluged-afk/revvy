// Rewards: power-up wallet, streak savers, the daily streak. Power-ups (freeze,
// hint, skip) are earned when an activity ends and spent across every mode.
// Streak savers accrue per 500 study-mode questions (not arena) and quietly
// protect the streak. Any activity feeds the streak.

// weakest to strongest: hint < freeze < skip. stronger ones are rarer so they
// cap lower, which pushes players to spend rather than hoard.
export const POWERUP_CAP = { hint: 9, freeze: 6, skip: 4 };
export const POWERUPS = ["hint", "freeze", "skip"];
// a saver rescues a whole lapse (however many days missed), so it's strong, so
// the cap stays small
export const SAVER_CAP = 3;
export const SAVER_EVERY = 500;   // study-mode questions per streak saver
export const SAVER_MAX_GAP = 15;  // a saver rescues an absence up to this many days; gone longer, every saver is wiped

const capOf = (k) => POWERUP_CAP[k] || 0;
const clampCount = (v, k) => Math.max(0, Math.min(capOf(k), Math.floor(Number(v) || 0)));

export function normWallet(w) {
  w = (w && typeof w === "object") ? w : {};
  return { hint: clampCount(w.hint, "hint"), freeze: clampCount(w.freeze, "freeze"), skip: clampCount(w.skip, "skip") };
}

// what an arena run earns, by final score. decent run -> hint, strong -> freeze,
// great -> skip.
export function arenaEarn(score) {
  const s = Number(score) || 0;
  if (s >= 3000) return "skip";
  if (s >= 1000) return "freeze";
  if (s >= 300) return "hint";
  return null;
}
// what passing a quiz/exam earns, by fraction correct. below the 60% pass line
// earns nothing.
export function passEarn(correct, total) {
  const pct = total ? (Number(correct) || 0) / total : 0;
  if (pct >= 0.95) return "skip";
  if (pct >= 0.80) return "freeze";
  if (pct >= 0.60) return "hint";
  return null;
}

// add one power-up, capped (overflow is dropped)
export function walletAdd(wallet, type) {
  const w = normWallet(wallet);
  if (!type || !(type in POWERUP_CAP)) return w;
  return { ...w, [type]: Math.min(capOf(type), w[type] + 1) };
}
// subtract what a run spent
export function walletSpend(wallet, used) {
  const w = normWallet(wallet); const u = used || {};
  return {
    hint: Math.max(0, w.hint - (parseInt(u.hint, 10) || 0)),
    freeze: Math.max(0, w.freeze - (parseInt(u.freeze, 10) || 0)),
    skip: Math.max(0, w.skip - (parseInt(u.skip, 10) || 0)),
  };
}

// credit study-mode questions toward savers: one per SAVER_EVERY up to SAVER_CAP,
// then progress stops accruing
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

// advance the streak for today. one saver rescues the whole lapse (not one per
// missed day), spent silently. but past SAVER_MAX_GAP days the lapse is too long
// to rescue: reset the streak and wipe every saver. any activity counts.
export function tickStreak({ streak = 0, best = 0, lastActive = null, streakSavers = 0 }, today, yesterday) {
  if (lastActive === today) return { streak, best: Math.max(best, streak), lastActive, streakSavers };
  let savers = Math.max(0, Number(streakSavers) || 0);
  let ns;
  if (lastActive === yesterday) {
    ns = streak + 1;                                     // consecutive day: no saver needed
  } else if (lastActive) {
    const gap = daysBetween(lastActive, today);          // days since the last activity
    if (gap > SAVER_MAX_GAP) { ns = 1; savers = 0; }     // gone too long: reset and wipe every saver
    else if (savers >= 1) { savers -= 1; ns = streak + 1; } // one saver rescues the whole lapse
    else ns = 1;                                         // no saver left: streak resets
  } else {
    ns = 1;                                              // first ever activity
  }
  return { streak: ns, best: Math.max(best, ns), lastActive: today, streakSavers: savers };
}
