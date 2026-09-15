import { topicMastery } from "./insights.js";

// Student model + adaptive difficulty, over the study blob (stats, topicStats,
// the rolling `perf` log). Two outputs: recommendDifficulty(study) picks the
// Easy/Normal/Hard level for the next quiz, and buildLearnerBrief(study) makes a
// short brief we append to the generation prompt so quizzes calibrate to this
// learner. The brief carries only aggregate signals (accuracy, topic labels),
// never any material content, and a new learner gets today's behaviour: a Normal
// default and an empty brief, with personalization fading in as history builds.

const DIFF_MIN = 0, DIFF_MAX = 2;
const DIFF_NAMES = ["Easy", "Normal", "Hard"];

const clampDiff = (d) => Math.max(DIFF_MIN, Math.min(DIFF_MAX, Math.round(Number(d) || 0)));
const pct = (x) => Math.round((x || 0) * 100);

// one graded session for perf.recent, kept tiny: { at, type, diff, total,
// correct }. only fresh difficulty-calibrated rounds get logged (not
// fix-your-misses re-drills or retries), so accuracy reflects real performance.
export function makePerfEntry({ type = "mcq", diff = 1, total = 0, correct = 0 } = {}) {
  return {
    at: Date.now(),
    type: String(type || "mcq"),
    diff: clampDiff(diff),
    total: Math.max(0, Math.round(total) || 0),
    correct: Math.max(0, Math.min(Math.round(correct) || 0, Math.round(total) || 0)),
  };
}

// recency-weighted accuracy at one level, over the last `window` sessions there.
// recent and bigger sessions count for more. returns { acc, q, n }, or null if
// they've never played that level.
export function recentAccuracyAt(perf, diff, { window = 8 } = {}) {
  const d = clampDiff(diff);
  const rows = (perf?.recent || []).filter((s) => clampDiff(s.diff) === d && (s.total || 0) > 0).slice(-window);
  if (!rows.length) return null;
  let wCorrect = 0, wTotal = 0, q = 0;
  rows.forEach((s, i) => {
    const recency = i + 1;            // oldest kept = 1 … newest = rows.length
    wCorrect += recency * (s.correct || 0);
    wTotal += recency * (s.total || 0);
    q += s.total || 0;                // raw question count drives confidence
  });
  return { acc: wTotal ? wCorrect / wTotal : 0, q, n: rows.length };
}

// trend over the recent log: improving, steady, or dipping. only used for framing.
export function momentum(perf) {
  const rows = (perf?.recent || []).filter((s) => (s.total || 0) > 0);
  if (rows.length < 4) return "steady";
  const half = Math.floor(rows.length / 2);
  const acc = (arr) => {
    const t = arr.reduce((s, x) => s + (x.total || 0), 0);
    const c = arr.reduce((s, x) => s + (x.correct || 0), 0);
    return t ? c / t : 0;
  };
  const delta = acc(rows.slice(half)) - acc(rows.slice(0, half));
  return delta > 0.08 ? "improving" : delta < -0.08 ? "dipping" : "steady";
}

// Recommend the next quiz's level. Working level = whatever they last played;
// from there, level up when they're cruising and down when they're underwater,
// else hold. confidence (0..1) says how much data backs the call so the UI can
// auto-apply or just suggest. Returns { diff, reason, confidence, acc, level }.
const UP_AT = 0.85;    // cruising, bump it
const DOWN_AT = 0.5;   // struggling, ease off
const MIN_Q = 10;      // questions before we trust the signal at all
const FULL_Q = 20;     // questions for full confidence

// a strong challenge record is peer-relative: beating people on the same
// questions says more than solo accuracy, so proven winners get pushed a level.
const CHAL_MIN = 3;       // challenges played before the record counts
const CHAL_WIN_AT = 0.6;  // win-rate that earns the bump
export function isStrongCompetitor(study = {}) {
  const s = study?.stats || {};
  const played = Math.max(0, Math.round(Number(s.challengePlayed) || 0));
  const wins = Math.max(0, Math.round(Number(s.challengeWins) || 0));
  return played >= CHAL_MIN && wins / played >= CHAL_WIN_AT;
}

export function recommendDifficulty(study = {}) {
  const perf = study?.perf || {};
  const recent = perf.recent || [];
  const lastDiff = recent.length ? clampDiff(recent[recent.length - 1].diff) : 1;
  const at = recentAccuracyAt(perf, lastDiff);
  const competitor = isStrongCompetitor(study);

  // cold start or too little data: hold at zero confidence so the caller keeps
  // the learner's own default. exception: a proven challenge winner still bumps.
  if (!at || at.q < MIN_Q) {
    if (competitor && lastDiff < DIFF_MAX) {
      const d = Math.min(DIFF_MAX, lastDiff + 1);
      return { diff: d, reason: "up", confidence: 0.5, acc: at ? at.acc : null, level: DIFF_NAMES[d] };
    }
    return { diff: lastDiff, reason: "hold", confidence: 0, acc: at ? at.acc : null, level: DIFF_NAMES[lastDiff] };
  }

  let diff = lastDiff, reason = "hold";
  if (at.acc >= UP_AT && lastDiff < DIFF_MAX) { diff = lastDiff + 1; reason = "up"; }
  else if (at.acc < DOWN_AT && lastDiff > DIFF_MIN) { diff = lastDiff - 1; reason = "down"; }

  // competitor bump, but never override a "down" call: if they're struggling
  // solo, rebuild first.
  if (competitor && reason !== "down" && diff < DIFF_MAX) { diff = Math.min(DIFF_MAX, diff + 1); reason = "up"; }

  const confidence = Math.max(0, Math.min(1, at.q / FULL_Q));
  return { diff, reason, confidence, acc: at.acc, level: DIFF_NAMES[diff] };
}

// results-screen nudge after a quiz: level up on a strong showing, offer a
// gentler set after a rough one. Returns { dir, from, to } or null.
export function resultNudge({ diff, correct, total }) {
  const d = clampDiff(diff);
  if (!total || total < 4) return null;               // too short to judge
  const acc = (correct || 0) / total;
  if (acc >= 0.9 && d < DIFF_MAX) return { dir: "up", from: d, to: d + 1 };
  if (acc < 0.4 && d > DIFF_MIN) return { dir: "down", from: d, to: d - 1 };
  return null;
}

// The instruction block appended to the generation prompt so the model
// calibrates to this learner. Carries only aggregate signals (recent accuracy,
// topic labels), never material content. Stays empty for new learners, and topic
// emphasis is conditioned on the material actually covering the topic so we don't
// force old topics onto new material. `forDrill` builds the stronger
// weak-spot-targeted variant for the no-upload "drill weak spots" flow.
export function buildLearnerBrief(study = {}, { max = 4, forDrill = false } = {}) {
  const stats = study?.stats || {};
  const perf = study?.perf || {};
  const answered = stats.answered || 0;
  const mastery = topicMastery(study?.topicStats || {});
  const weak = mastery.filter((t) => t.weak).slice(0, max).map((t) => t.topic);
  const strong = mastery.filter((t) => t.mastery >= 85 && t.seen >= 4).slice(0, max).map((t) => t.topic);

  // not enough history to personalize honestly, so say nothing. (drill mode
  // always builds one, its caller guarantees signal.)
  if (!forDrill && answered < 8 && !weak.length) return "";

  const rec = recommendDifficulty(study);
  const mo = momentum(perf);
  const lines = ["PERSONALIZATION (adapt to this specific learner; keep every question fair and answerable from the material):"];

  if (rec.acc != null && rec.acc > 0) {
    const band = rec.acc >= UP_AT ? "comfortably above target, so include a few genuine stretch questions that go one step deeper"
      : rec.acc < DOWN_AT ? "below target, so keep the core questions very clearly answerable from the material and build their confidence"
      : "right around target, so hold a solid, fair challenge";
    lines.push(`- Recent accuracy is about ${pct(rec.acc)}% at the ${rec.level} level and trending ${mo}. Calibrate so the learner is ${band}.`);
  }
  if (weak.length) {
    lines.push(`- They have struggled before with: ${weak.join(", ")}. WHERE the material covers any of these, give them extra attention and a clear path to understanding. Do NOT force these topics if the material does not cover them.`);
  }
  if (strong.length) {
    lines.push(`- They are already strong on: ${strong.join(", ")}. Where the material covers these, push a little deeper rather than re-testing the basics.`);
  }
  if (isStrongCompetitor(study)) {
    lines.push(`- They consistently win head-to-head challenges against their peers, so bias toward genuinely demanding, stretch-level questions rather than routine recall.`);
  }
  // only send it if there's an actual line beyond the header
  return lines.length > 1 ? lines.join("\n") : "";
}

// small summary object for any UI that wants to show the learner their model at
// a glance (generation doesn't need it)
export function studentSnapshot(study = {}) {
  const rec = recommendDifficulty(study);
  return {
    recommendedDiff: rec.diff,
    reason: rec.reason,
    confidence: rec.confidence,
    momentum: momentum(study?.perf || {}),
    sessions: (study?.perf?.recent || []).length,
  };
}

// Personalized daily question goal, replacing the old flat 10. Newcomers get a
// gentle target that ramps with their streak; once there are a few days of real
// history we aim at their own recent typical day (rounded to a nice number,
// clamped). Prior days only, so the goal is stable for the whole of today rather
// than moving as they answer. Pure; the goal always lands in [5, 40].
export function recommendDailyGoal(study = {}) {
  const perf = study?.perf?.recent || [];
  const answered = study?.stats?.answered || 0;
  const streak = Math.max(0, study?.stats?.streak || 0);
  const DAY = 86400000;
  const now = Date.now();
  const today = new Date(now).toLocaleDateString("en-CA");

  // sum questions per prior calendar day over the last two weeks
  const byDay = {};
  for (const s of perf) {
    if (!s || !((s.total || 0) > 0)) continue;
    if (now - (Number(s.at) || 0) > 14 * DAY) continue;
    const day = new Date(Number(s.at) || 0).toLocaleDateString("en-CA");
    if (day === today) continue; // base on prior days so today's goal doesn't move
    byDay[day] = (byDay[day] || 0) + s.total;
  }
  const days = Object.values(byDay);

  // not enough history: a gentle 5, nudged up as they build a streak (5/10/15)
  if (days.length < 3 || answered < 20) return Math.min(15, 5 + Math.floor(streak / 7) * 5);

  const avg = days.reduce((a, b) => a + b, 0) / days.length;
  const round5 = Math.round(avg / 5) * 5;
  return Math.min(40, Math.max(10, round5));
}
