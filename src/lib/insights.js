import { planProgress } from "./planner.js";

// Exam-readiness score + weak-topic detection. Pure functions over the
// server-synced study data (SRS deck, lifetime stats, active plan). Turns the
// data Revyy already collects into one motivating number and a short "focus
// here" list — no extra storage, no API call.

const DAY = 86400000;

// A card counts as "solid" once it's been recalled at least twice and isn't
// currently overdue — i.e. it's sticking. Freshly-missed cards drag readiness
// down until they're reviewed, which is the behaviour we want.
function isSolid(c, now) {
  return (c.reps || 0) >= 2 && c.due > now && (c.interval || 0) >= 3;
}
function isStruggling(c, now) {
  return c.due <= now || (c.interval || 0) < 3 || (c.lapses || 0) > 0;
}

function norm(topic) {
  return String(topic || "").trim().toLowerCase();
}

// Weighted blend of whatever signals exist (plan progress, deck health, recent
// accuracy). Missing signals are dropped and the rest re-normalised, so it
// works with or without a plan and degrades gracefully for new users.
export function computeReadiness({ cards = [], stats = {}, plan = null } = {}) {
  const now = Date.now();
  const parts = [];

  if (plan && plan.days && plan.days.length) {
    parts.push([planProgress(plan).pct, 0.4]);
  }
  if (cards.length) {
    const solid = cards.filter((c) => isSolid(c, now)).length;
    parts.push([Math.round((solid / cards.length) * 100), 0.35]);
  }
  if ((stats.answered || 0) >= 5 && stats.accuracy != null) {
    parts.push([stats.accuracy, 0.25]);
  }

  if (!parts.length) return { score: null, label: "Take a quiz to start tracking" };
  const wSum = parts.reduce((s, [, w]) => s + w, 0);
  const score = Math.round(parts.reduce((s, [v, w]) => s + v * w, 0) / wSum);

  const label =
    score >= 90 ? "Exam-ready 🎯" :
    score >= 75 ? "On track" :
    score >= 55 ? "Getting there" :
    score >= 30 ? "Warming up" :
    "Just getting started";
  return { score: Math.max(0, Math.min(100, score)), label };
}

// Per-topic mastery from the accumulated topic stats (seen + correct across all
// quizzes and exams). Returns [{ topic, mastery 0–100, seen, correct, weak }]
// sorted weakest-first. `weak` = enough attempts and still under the bar, i.e.
// worth drilling.
export function topicMastery(topicStats = {}, { minSeen = 4, weakBelow = 70 } = {}) {
  const out = [];
  for (const v of Object.values(topicStats || {})) {
    const seen = v?.seen || 0;
    if (seen < 1) continue;
    const mastery = Math.round(((v.correct || 0) / seen) * 100);
    out.push({ topic: (v.label || "").trim(), mastery, seen, correct: v.correct || 0, weak: seen >= minSeen && mastery < weakBelow });
  }
  return out.filter((t) => t.topic).sort((a, b) => a.mastery - b.mastery || b.seen - a.seen);
}

// Topics you're weakest on, from the review deck. A topic is weak when it has
// unlearned or overdue cards; ranked by how many. Returns up to `limit`
// {topic, weak, total}. Empty when there isn't enough tagged signal yet.
export function weakTopics(cards = [], limit = 3) {
  const now = Date.now();
  const groups = new Map(); // normKey -> { label, weak, total }
  for (const c of cards) {
    const key = norm(c.topic);
    if (!key || key === "general") continue;
    const g = groups.get(key) || { label: (c.topic || "").trim(), weak: 0, total: 0 };
    g.total += 1;
    if (isStruggling(c, now)) g.weak += 1;
    groups.set(key, g);
  }
  return [...groups.values()]
    .filter((g) => g.weak > 0)
    .sort((a, b) => b.weak - a.weak || b.total - a.total)
    .slice(0, limit);
}
