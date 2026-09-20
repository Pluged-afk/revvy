// Endless Arena game rules. Sudden-death quiz run: answer until one wrong answer
// or a timeout ends it and locks the score. Client and server both run these
// pure functions so the submitted score can be validated server-side against the
// same math. (Tab-switch anti-cheat lives client-side in ArenaGame.)

export const ARENA = {
  BASE_TIMER: 15,     // seconds on the first questions
  MIN_TIMER: 7,       // timer floor as the run ramps
  RAMP_EVERY: 5,      // every N questions the band + timer tighten
  N_OPTIONS: 4,       // 1 correct + 3 distractors
  GATE_PLAYERS: 100,  // board stays hidden until this many distinct players have a score
  POWERUPS: ["freeze", "hint", "skip"],
  DIFF_MIN: 1,
  DIFF_MAX: 5,
  // how much fully-confusing choices can raise a serve's difficulty. big on
  // purpose: obvious choices on a hard question can score less than tempting
  // ones on an easy question.
  CLOSE_BONUS: 2.0,
};

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// combo multiplier, grows with the streak, capped at x5
export function comboMult(streak) {
  return clamp(1 + Math.floor(Math.max(0, streak) / 3) * 0.5, 1, 5);
}

export function basePoints(difficulty) {
  return Math.round(20 * clamp(difficulty, ARENA.DIFF_MIN, ARENA.DIFF_MAX)); // 20 (easy) .. 100 (hard)
}

export function questionPoints(difficulty, streak) {
  return Math.round(basePoints(difficulty) * comboMult(streak));
}

// a serve's difficulty is the question's own difficulty nudged up by how
// confusing the 3 shown distractors are, so close/tempting choices make even an
// easy question play harder
export function serveDifficulty(baseDiff, shownCloseness) {
  const c = clamp(Number(shownCloseness) || 0, 0, 1);
  return clamp((Number(baseDiff) || ARENA.DIFF_MIN) + c * ARENA.CLOSE_BONUS, ARENA.DIFF_MIN, ARENA.DIFF_MAX);
}

// ceiling for one question, used server-side to clamp a submitted score so a
// client can't inflate it
export function maxQuestionPoints(baseDiff, streak) {
  return questionPoints(serveDifficulty(baseDiff, 1), streak);
}

// crowd-refined difficulty: new questions trust the generator's guess, then we
// blend toward what people actually score as plays pile up (low correct-rate =>
// harder)
export function difficultyFromStats(baseDiff, plays, correctCount) {
  const b = clamp(Number(baseDiff) || ARENA.DIFF_MIN, ARENA.DIFF_MIN, ARENA.DIFF_MAX);
  const p = Number(plays) || 0;
  if (p < 8) return b; // not enough signal yet
  const rate = clamp((Number(correctCount) || 0) / p, 0, 1);
  const observed = clamp(ARENA.DIFF_MAX - rate * (ARENA.DIFF_MAX - ARENA.DIFF_MIN), ARENA.DIFF_MIN, ARENA.DIFF_MAX);
  const w = Math.min(1, p / 60); // trust the crowd more as data grows
  return clamp(b * (1 - w) + observed * w, ARENA.DIFF_MIN, ARENA.DIFF_MAX);
}

// seconds allowed at a given depth (0-based)
export function timerFor(qIndex) {
  const step = Math.floor(Math.max(0, qIndex) / ARENA.RAMP_EVERY);
  return Math.max(ARENA.MIN_TIMER, ARENA.BASE_TIMER - step);
}

// shuffle/sample with an injectable RNG so tests can seed it
function shuffle(arr, rand = Math.random) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function sample(arr, n, rand = Math.random) { return shuffle(arr, rand).slice(0, n); }

// build one served question: the correct answer plus 3 distractors pulled at
// random from this question's pool, shuffled. Returns the options, correct
// index, and avg closeness of the shown distractors (feeds serve difficulty), so
// each serve of a question shows a different but still-relevant set of wrongs.
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

// is the leaderboard visible yet
export function boardUnlocked(distinctPlayers) {
  return (Number(distinctPlayers) || 0) >= ARENA.GATE_PLAYERS;
}

// ── Content preferences: "no date / no name" questions ───────────────────────
// A player can opt out of pure date recall (what year did X happen) or pure name
// recall (who did X), which many find rote. The pool isn't tagged by type, so
// these are best-effort text heuristics that catch the obvious cases. Filtering
// shrinks the pool, which is why the UI warns it makes ranking up slower.
const YEARISH = /^\s*(in\s+)?\d{3,4}\s*(bc|bce|ad|ce)?\s*$/i;
export function isDateQuestion(q) {
  const s = String(q?.question || "").toLowerCase();
  if (/\b(what|which|in\s+what|in\s+which)\s+(year|century|decade)\b/.test(s)) return true;
  if (/\bwhat\s+year\b|\bwhich\s+year\b|\bwhat\s+date\b|\bwhen\s+(did|was|were|is|do|does)\b/.test(s)) return true;
  if (q?.correct != null && YEARISH.test(String(q.correct))) return true;
  const opts = [q?.correct, ...((Array.isArray(q?.distractors) ? q.distractors : []).map((d) => d && d.text))].filter((x) => x != null && x !== "");
  const yearOpts = opts.filter((o) => YEARISH.test(String(o))).length;
  return opts.length >= 2 && yearOpts >= Math.ceil(opts.length * 0.75);
}
export function isNameQuestion(q) {
  const s = String(q?.question || "").toLowerCase();
  if (/\bwho\b|\bwhom\b|\bwhose\b/.test(s)) return true;
  if (/\bwhich\s+(person|scientist|author|writer|poet|artist|painter|composer|musician|singer|leader|president|prime\s+minister|king|queen|emperor|philosopher|inventor|explorer|general|mathematician|physicist|chemist|biologist|actor|actress|director|athlete)\b/.test(s)) return true;
  if (/\bnamed\s+after\b/.test(s)) return true;
  return false;
}
// Drop the opted-out question types. dates/names default true (allowed), so the
// full pool passes through untouched unless the player turned one off.
export function filterArenaQuestions(qs, { dates = true, names = true } = {}) {
  const list = Array.isArray(qs) ? qs : [];
  if (dates && names) return list;
  return list.filter((q) => (dates || !isDateQuestion(q)) && (names || !isNameQuestion(q)));
}
