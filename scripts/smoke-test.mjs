// Smoke tests for the pure game/rank logic. These modules are dependency-free
// (no React, no DB), so CI can import and exercise them directly. Keeps the
// scoring, rank thresholds and arena curve from silently regressing on a push.
// Run: node scripts/smoke-test.mjs
import { RANKS, rankFor, rankOf } from "../src/lib/badges.js";
import { ARENA, comboMult, basePoints, questionPoints, timerFor, boardUnlocked, serveDifficulty } from "../src/lib/arena.js";
import { reviewCard, previewInterval, initStability } from "../src/lib/fsrs.js";
import { recommendDailyGoal } from "../src/lib/studentModel.js";
import { detectOvertakes } from "../src/lib/overtake.js";
import { reminderFor, reminderText } from "../src/lib/reminders.js";

let passed = 0, failed = 0;
const eq = (got, want, msg) => {
  if (got === want) { passed++; }
  else { failed++; console.error(`✗ ${msg}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); };
};
const ok = (cond, msg) => { if (cond) { passed++; } else { failed++; console.error(`✗ ${msg}`); } };

// ── Ranks ────────────────────────────────────────────────────────────────
eq(RANKS.length, 7, "seven rank tiers");
eq(RANKS[0].min, 0, "first rank floor is 0");
ok(RANKS.every((r, i) => i === 0 || r.min > RANKS[i - 1].min), "rank floors strictly ascending");
eq(rankFor(0).index, 0, "0 pts => Novice");
eq(rankFor(-50).index, 0, "negative pts clamp to Novice");
eq(rankFor(RANKS[1].min).index, 1, "apprentice floor => index 1");
eq(rankFor(2000).index, 3, "2000 pts => Scholar (index 3)");
eq(rankFor(99999).index, RANKS.length - 1, "huge pts => top rank");
eq(rankOf({ stats: { arenaBest: 2000 } }).index, rankFor(2000).index, "rankOf uses arenaBest");
eq(rankOf({ stats: {} }).index, 0, "no arena history => Novice");
ok(rankFor(RANKS[1].min - 1).toNext > 0 && rankFor(RANKS[1].min - 1).toNext <= 1, "toNext is a 0..1 fraction");
eq(rankFor(RANKS[RANKS.length - 1].min).toNext, null, "top rank has no next");

// ── Arena scoring ────────────────────────────────────────────────────────
eq(basePoints(1), 20, "easy base points = 20");
eq(basePoints(5), 100, "hard base points = 100");
eq(comboMult(0), 1, "no streak => x1 combo");
eq(comboMult(3), 1.5, "streak 3 => x1.5 combo");
ok(comboMult(1000) <= 5, "combo capped at x5");
ok(questionPoints(3, 6) === basePoints(3) * comboMult(6), "questionPoints = base x combo");

// ── Progressive difficulty curve (timer ramps down with depth) ───────────
eq(timerFor(0), ARENA.BASE_TIMER, "first question uses base timer");
ok(timerFor(200) >= ARENA.MIN_TIMER, "timer never drops below the floor");
ok(timerFor(0) >= timerFor(10) && timerFor(10) >= timerFor(50), "timer is non-increasing with depth");

// ── Serve difficulty + leaderboard gate ──────────────────────────────────
ok(serveDifficulty(1, 1) > serveDifficulty(1, 0), "confusing distractors raise serve difficulty");
ok(serveDifficulty(5, 1) <= ARENA.DIFF_MAX, "serve difficulty clamped to max");
eq(boardUnlocked(ARENA.GATE_PLAYERS), true, "board unlocks at the gate");
eq(boardUnlocked(ARENA.GATE_PLAYERS - 1), false, "board locked below the gate");

// ── FSRS spaced repetition ───────────────────────────────────────────────
const NOW = 1_700_000_000_000, DAY = 86400000;
const rNew = reviewCard({ reps: 0, interval: 0, lapses: 0 }, 3, NOW);
ok(rNew.interval >= 1 && rNew.interval <= 7, "new card + Good schedules a small first interval");
eq(rNew.reps, 1, "new card + Good sets reps to 1");
ok(rNew.stability > 0 && rNew.difficulty >= 1 && rNew.difficulty <= 10, "new card has valid stability + difficulty");
const rGrow = reviewCard({ ...rNew }, 3, rNew.due);
ok(rGrow.interval > rNew.interval, "recall grows the interval");
const rLapse = reviewCard({ ...rGrow }, 1, rGrow.due);
eq(rLapse.reps, 0, "Again resets reps");
ok(rLapse.due - rGrow.due < DAY, "Again brings the card back within the day");
ok(rLapse.lapses === (rGrow.lapses || 0) + 1, "Again increments lapses");
ok(reviewCard({ reps: 3, interval: 7, ease: 2.3, due: NOW - 7 * DAY, lastReview: NOW - 7 * DAY }, 3, NOW).stability > 7, "legacy SM-2 card migrates (stability seeded from its interval, then grows)");
let sc = { reps: 0, interval: 0, lapses: 0 }, tt = NOW, bounded = true;
for (let i = 0; i < 15; i++) { const rr = reviewCard(sc, 3, tt); if (rr.difficulty < 1 || rr.difficulty > 10 || rr.stability <= 0) bounded = false; sc = { ...sc, ...rr }; tt = rr.due; }
ok(bounded, "difficulty stays in 1..10 and stability positive across many reviews");
ok(previewInterval({ reps: 0, interval: 0 }, 3) === reviewCard({ reps: 0, interval: 0 }, 3).interval, "previewInterval matches reviewCard");

// ── Adaptive daily goal ──────────────────────────────────────────────────
const RNOW = Date.now();
eq(recommendDailyGoal({ stats: { answered: 0, streak: 0 }, perf: { recent: [] } }), 5, "brand-new learner gets a gentle daily goal of 5");
eq(recommendDailyGoal({ stats: { answered: 5, streak: 7 }, perf: { recent: [] } }), 10, "newcomer daily goal ramps with the streak");
ok(recommendDailyGoal({ stats: { answered: 5, streak: 40 }, perf: { recent: [] } }) <= 15, "newcomer goal capped at 15");
const priorDays = { recent: [1, 2, 3].map((k) => ({ at: RNOW - k * DAY, total: 20, correct: 15 })) };
eq(recommendDailyGoal({ stats: { answered: 200 }, perf: priorDays }), 20, "established learner's goal tracks their ~20/day");
const heavyDays = { recent: [1, 2, 3, 4].map((k) => ({ at: RNOW - k * DAY, total: 200, correct: 150 })) };
eq(recommendDailyGoal({ stats: { answered: 5000 }, perf: heavyDays }), 40, "heavy learner's goal capped at 40");
const todayOnly = { recent: [{ at: RNOW, total: 200, correct: 150 }] };
eq(recommendDailyGoal({ stats: { answered: 200 }, perf: todayOnly }), 5, "today's own sessions don't move today's goal");

// ── Friend-overtake nudge ──────────────────────────────────────────────────
const fx = [{ id: "a", name: "Ann", xp: 300 }, { id: "b", name: "Bo", xp: 100 }];
// First sync (aheadInit false): seed a baseline, never nudge, even though Ann is ahead.
const seed = detectOvertakes({ friendsXp: fx, myXP: 200, seenAhead: [], aheadInit: false });
eq(seed.fresh.length, 0, "overtake: first sync seeds silently, no fresh crossings");
ok(seed.changed, "overtake: first sync counts as a change (needs to persist the seed)");
eq(JSON.stringify(seed.aheadIds), JSON.stringify(["a"]), "overtake: Ann (300) is ahead of my 200, Bo (100) is not");
// Steady state: Ann already known-ahead, nothing changed -> no write, no nudge.
const steady = detectOvertakes({ friendsXp: fx, myXP: 200, seenAhead: ["a"], aheadInit: true });
eq(steady.fresh.length, 0, "overtake: a known rival still ahead is not a fresh crossing");
ok(!steady.changed, "overtake: unchanged standings skip the blob write");
// Fresh overtake: Bo climbs past me while I only knew about Ann.
const crossed = detectOvertakes({ friendsXp: [{ id: "a", name: "Ann", xp: 300 }, { id: "b", name: "Bo", xp: 250 }], myXP: 200, seenAhead: ["a"], aheadInit: true });
eq(crossed.fresh.map((f) => f.id).join(","), "b", "overtake: Bo crossing above fires exactly one fresh nudge");
ok(crossed.changed, "overtake: a fresh crossing is a change");
// Dedup: after Bo is acknowledged, no repeat nudge.
eq(detectOvertakes({ friendsXp: [{ id: "a", name: "Ann", xp: 300 }, { id: "b", name: "Bo", xp: 250 }], myXP: 200, seenAhead: ["a", "b"], aheadInit: true }).fresh.length, 0, "overtake: acknowledged rival is not re-nudged");
// Re-pass: I climb above Ann; she drops out of the ahead set (no nudge), which re-arms her.
const repass = detectOvertakes({ friendsXp: [{ id: "a", name: "Ann", xp: 300 }], myXP: 350, seenAhead: ["a"], aheadInit: true });
eq(repass.aheadIds.length, 0, "overtake: re-passing a rival removes them from the ahead set");
eq(repass.fresh.length, 0, "overtake: re-passing never nudges");
ok(repass.changed, "overtake: a rival dropping out is a change (re-arms them)");
// Re-overtake: Ann passes me again after being re-armed -> nudges again.
eq(detectOvertakes({ friendsXp: [{ id: "a", name: "Ann", xp: 400 }], myXP: 350, seenAhead: [], aheadInit: true }).fresh.map((f) => f.id).join(","), "a", "overtake: a re-armed rival passing again nudges again");
// Privacy / bad data: a friend with hidden (null) xp is ignored.
eq(detectOvertakes({ friendsXp: [{ id: "c", name: "Cy", xp: null }], myXP: 0, seenAhead: [], aheadInit: true }).aheadIds.length, 0, "overtake: a hidden-XP friend is ignored");

// ── Study-reminder push eligibility ────────────────────────────────────────
const RN = Date.now();
eq(reminderFor({ cards: [] }, RN).send, false, "reminder: no cards -> no push");
eq(reminderFor({ cards: [{ due: RN + DAY }] }, RN).send, false, "reminder: nothing due yet -> no push");
eq(reminderFor({ cards: [{ due: RN - DAY }, { due: RN - 2 * DAY }, { due: RN + DAY }] }, RN).dueCount, 2, "reminder: counts only cards due now");
eq(reminderFor({ cards: [{ due: RN - DAY }] }, RN).send, true, "reminder: a due card triggers a push");
eq(reminderFor({ cards: [{ due: "soon" }, { due: null }] }, RN).dueCount, 0, "reminder: non-numeric due dates are ignored");
eq(reminderFor(null, RN).send, false, "reminder: a missing blob is safe");
eq(reminderFor({ cards: [{ due: RN - DAY }], stats: { streak: 5 } }, RN).streak, 5, "reminder: surfaces the streak");
ok(reminderText({ dueCount: 1, streak: 0 }).includes("1 review"), "reminder text: singular review");
ok(reminderText({ dueCount: 3, streak: 0 }).includes("3 reviews"), "reminder text: plural count");
ok(reminderText({ dueCount: 2, streak: 4 }).includes("4-day streak"), "reminder text: mentions the streak when present");
ok(!reminderText({ dueCount: 2, streak: 0 }).includes("streak"), "reminder text: no streak clause at streak 0");

console.log(`\nSmoke tests: ${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
