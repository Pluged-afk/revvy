// Smoke tests for the pure game/rank logic. These modules are dependency-free
// (no React, no DB), so CI can import and exercise them directly. Keeps the
// scoring, rank thresholds and arena curve from silently regressing on a push.
// Run: node scripts/smoke-test.mjs
import { RANKS, rankFor, rankOf } from "../src/lib/badges.js";
import { ARENA, comboMult, basePoints, questionPoints, timerFor, boardUnlocked, serveDifficulty } from "../src/lib/arena.js";

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

console.log(`\nSmoke tests: ${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
