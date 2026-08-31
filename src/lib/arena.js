// ── Endless Arena: pure game rules (shared by client + server) ──────────────
// A single-player, sudden-death quiz run. Questions come from a pooled bank; the
// player answers until one wrong answer (or a timeout) ends the run and locks a
// score. A visible per-question timer ramps down with depth. Anti-cheat: leaving
// the tab pauses the timer and swaps the question on return (client-side, in
// ArenaGame). Everything here is a pure function so both the client (to play) and
// the server (to validate the submitted score) compute identical numbers.

export const ARENA = {
  BASE_TIMER: 15,     // seconds on the first questions
  MIN_TIMER: 7,       // timer floor as the run ramps
  RAMP_EVERY: 5,      // every N questions the band + timer tighten
  N_OPTIONS: 4,       // 1 correct + 3 distractors
  GATE_PLAYERS: 100,  // leaderboard stays hidden until this many DISTINCT players have a score
  POWERUPS: ["freeze", "hint", "skip"],
  DIFF_MIN: 1,
  DIFF_MAX: 5,
  CLOSE_BONUS: 2.0,   // how much fully-confusing choices can raise a serve's difficulty
                      // (deliberately large: obvious choices on a hard question can
                      //  score LESS than confusing choices on an easier one)
};

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// Combo multiplier: grows the longer the correct streak, capped at x5.
export function comboMult(streak) {
  return clamp(1 + Math.floor(Math.max(0, streak) / 3) * 0.5, 1, 5);
}

// Base points for a correct answer at a given serve difficulty (1..5).
export function basePoints(difficulty) {
  return Math.round(20 * clamp(difficulty, ARENA.DIFF_MIN, ARENA.DIFF_MAX)); // 20 (easy) .. 100 (hard)
}

// Points banked for one correct answer.
export function questionPoints(difficulty, streak) {
  return Math.round(basePoints(difficulty) * comboMult(streak));
}

// A SERVE's difficulty = the question's own difficulty, nudged up by how
// confusing the 3 shown distractors are. Obvious wrong choices make an easy
// serve; close, tempting ones make it harder, even on an otherwise easy question.
export function serveDifficulty(baseDiff, shownCloseness) {
  const c = clamp(Number(shownCloseness) || 0, 0, 1);
  return clamp((Number(baseDiff) || ARENA.DIFF_MIN) + c * ARENA.CLOSE_BONUS, ARENA.DIFF_MIN, ARENA.DIFF_MAX);
}

// The most points a single question could legitimately be worth (used server-side
// to clamp a submitted per-question score so a client cannot inflate it).
export function maxQuestionPoints(baseDiff, streak) {
  return questionPoints(serveDifficulty(baseDiff, 1), streak);
}

// Crowd-refined difficulty. New questions trust the generator's guess; as real
// plays accumulate, blend toward what people actually score (low correct-rate =>
// hard). This is where "the app sets difficulty then changes it from user info".
export function difficultyFromStats(baseDiff, plays, correctCount) {
  const b = clamp(Number(baseDiff) || ARENA.DIFF_MIN, ARENA.DIFF_MIN, ARENA.DIFF_MAX);
  const p = Number(plays) || 0;
  if (p < 8) return b; // not enough signal yet
  const rate = clamp((Number(correctCount) || 0) / p, 0, 1);
  const observed = clamp(ARENA.DIFF_MAX - rate * (ARENA.DIFF_MAX - ARENA.DIFF_MIN), ARENA.DIFF_MIN, ARENA.DIFF_MAX);
  const w = Math.min(1, p / 60); // trust the crowd more as data grows
  return clamp(b * (1 - w) + observed * w, ARENA.DIFF_MIN, ARENA.DIFF_MAX);
}

// Seconds allowed for the question at a given depth (0-based index).
export function timerFor(qIndex) {
  const step = Math.floor(Math.max(0, qIndex) / ARENA.RAMP_EVERY);
  return Math.max(ARENA.MIN_TIMER, ARENA.BASE_TIMER - step);
}

// Deterministic-ish shuffle / sample using an injectable RNG (default Math.random).
function shuffle(arr, rand = Math.random) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function sample(arr, n, rand = Math.random) { return shuffle(arr, rand).slice(0, n); }

// Assemble one served question: the fixed correct answer plus 3 RANDOM but
// relevant distractors drawn from this question's pool, then shuffled. Returns
// the option texts, the correct index, and the average closeness of the shown
// distractors (which feeds the serve difficulty). Different serves of the same
// question therefore show different, still-relevant wrong choices.
export function buildServe(q, rand = Math.random) {
  const pool = (Array.isArray(q.distractors) ? q.distractors : [])
    .filter((d) => d && typeof d.text === "string" && d.text.trim() && d.text.trim().toLowerCase() !== String(q.correct).trim().toLowerCase());
  const need = ARENA.N_OPTIONS - 1;
  const picked = sample(pool, need, rand);
  const closeness = picked.length ? picked.reduce((s, d) => s + clamp(Number(d.close) || 0, 0, 1), 0) / picked.length : 0;
  const merged = shuffle([{ text: String(q.correct), correct: true }, ...picked.map((d) => ({ text: String(d.text), correct: false }))], rand);
  return {
    id: q.id,
    category: q.category || "",
    question: q.question,
    options: merged.map((o) => o.text),
    correctIndex: merged.findIndex((o) => o.correct),
    closeness,                                   // 0..1, avg of shown distractors
    baseDiff: clamp(Number(q.difficulty) || ARENA.DIFF_MIN, ARENA.DIFF_MIN, ARENA.DIFF_MAX),
  };
}

// Whether the leaderboard should be visible yet.
export function boardUnlocked(distinctPlayers) {
  return (Number(distinctPlayers) || 0) >= ARENA.GATE_PLAYERS;
}
