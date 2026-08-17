import { topicMastery } from "./insights.js";

// ── Per-user student model + adaptive difficulty ──────────────────────────
// Pure functions over the server-synced study blob (stats, topicStats, the
// small rolling `perf` session log, and the SRS deck). They turn the signals
// Revyy already collects into two things:
//   1. recommendDifficulty(study) -> the right Easy/Normal/Hard level for the
//      learner's NEXT quiz, so difficulty adapts to how they've been doing.
//   2. buildLearnerBrief(study)   -> a short, privacy-safe brief injected into
//      generation so every quiz is calibrated to this specific learner.
// No material content leaves the device through the brief, no API call, and no
// extra storage beyond the tiny `perf` log kept in the study blob. Everything
// degrades gracefully: a brand-new learner gets today's exact behaviour (a
// Normal default and an empty brief), and personalization fades in as real
// history accumulates.

const DIFF_MIN = 0, DIFF_MAX = 2;
const DIFF_NAMES = ["Easy", "Normal", "Hard"];

const clampDiff = (d) => Math.max(DIFF_MIN, Math.min(DIFF_MAX, Math.round(Number(d) || 0)));
const pct = (x) => Math.round((x || 0) * 100);

// A single graded session as stored in perf.recent. Kept deliberately tiny:
// { at, type, diff, total, correct }. Only real, difficulty-calibrated quiz
// rounds are logged (not fix-your-misses re-drills or retries of seen sets),
// so the accuracy signal reflects fresh performance at a chosen level.
export function makePerfEntry({ type = "mcq", diff = 1, total = 0, correct = 0 } = {}) {
  return {
    at: Date.now(),
    type: String(type || "mcq"),
    diff: clampDiff(diff),
    total: Math.max(0, Math.round(total) || 0),
    correct: Math.max(0, Math.min(Math.round(correct) || 0, Math.round(total) || 0)),
  };
}

// Recency-weighted accuracy at one difficulty level, from the last `window`
// sessions played at that level. Recent sessions count more (linear ramp) and
// bigger sessions count more (weighted by question volume). Returns
// { acc, q, n } or null when the learner has never played that level.
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

// Direction of travel over the whole recent log: are they trending up, holding
// steady, or slipping? Used only for encouraging, honest framing.
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

// ── Adaptive difficulty ────────────────────────────────────────────────
// Recommend the level for the next quiz. The "working level" is whatever the
// learner most recently played; from there we level up when they're cruising
// and ease down when they're underwater, staying put in the sweet spot. A
// confidence value (0..1) reflects how much data backs the call, so the UI can
// decide whether to auto-apply it or merely suggest it.
//
// Returns { diff, reason: "up"|"down"|"hold", confidence, acc, level }.
const UP_AT = 0.85;    // cruising: bump the challenge
const DOWN_AT = 0.5;   // struggling: rebuild momentum
const MIN_Q = 10;      // questions needed before we trust the signal at all
const FULL_Q = 20;     // questions for full confidence

export function recommendDifficulty(study = {}) {
  const perf = study?.perf || {};
  const recent = perf.recent || [];
  const lastDiff = recent.length ? clampDiff(recent[recent.length - 1].diff) : 1;
  const at = recentAccuracyAt(perf, lastDiff);

  // Cold start or too little data at the working level: hold, but with zero
  // confidence so the caller leaves the learner's own default untouched.
  if (!at || at.q < MIN_Q) {
    return { diff: lastDiff, reason: "hold", confidence: 0, acc: at ? at.acc : null, level: DIFF_NAMES[lastDiff] };
  }

  let diff = lastDiff, reason = "hold";
  if (at.acc >= UP_AT && lastDiff < DIFF_MAX) { diff = lastDiff + 1; reason = "up"; }
  else if (at.acc < DOWN_AT && lastDiff > DIFF_MIN) { diff = lastDiff - 1; reason = "down"; }

  const confidence = Math.max(0, Math.min(1, at.q / FULL_Q));
  return { diff, reason, confidence, acc: at.acc, level: DIFF_NAMES[diff] };
}

// After a quiz finishes, is there an obvious next-level nudge to offer on the
// results screen? Reward-framed only: level up on a strong showing, offer a
// gentler set after a rough one. Returns { dir: "up"|"down", from, to } or null.
export function resultNudge({ diff, correct, total }) {
  const d = clampDiff(diff);
  if (!total || total < 4) return null;               // too short to judge
  const acc = (correct || 0) / total;
  if (acc >= 0.9 && d < DIFF_MAX) return { dir: "up", from: d, to: d + 1 };
  if (acc < 0.4 && d > DIFF_MIN) return { dir: "down", from: d, to: d - 1 };
  return null;
}

// ── Personalized generation brief ──────────────────────────────────────
// A compact English instruction block appended to the generation prompt so the
// model calibrates the set to THIS learner. It carries only aggregate signals
// the learner produced themselves (recent accuracy, topic labels they've been
// quizzed on) never any material content, so it is cheap and privacy-safe. It
// stays quiet for new learners (returns "") and never forces past topics onto
// unrelated new material: topic emphasis is explicitly conditioned on "only if
// the material covers it."
//
// `opts.forDrill` produces the stronger, weak-spot-targeted variant used by the
// no-upload "drill weak spots" flow, where hitting those exact topics is the
// whole point.
export function buildLearnerBrief(study = {}, { max = 4, forDrill = false } = {}) {
  const stats = study?.stats || {};
  const perf = study?.perf || {};
  const answered = stats.answered || 0;
  const mastery = topicMastery(study?.topicStats || {});
  const weak = mastery.filter((t) => t.weak).slice(0, max).map((t) => t.topic);
  const strong = mastery.filter((t) => t.mastery >= 85 && t.seen >= 4).slice(0, max).map((t) => t.topic);

  // Not enough history to personalize honestly: say nothing, keep today's
  // behaviour. (Drill mode always builds one, its caller guarantees signal.)
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
  // Only worth sending if it actually says something beyond the header.
  return lines.length > 1 ? lines.join("\n") : "";
}

// Convenience: a short, localized-agnostic summary object for any UI that wants
// to show the learner their model at a glance (not required by generation).
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
