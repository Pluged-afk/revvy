// AI study-coach planner. Turns a test date + chapter count into a day-by-day
// schedule that splits the material across the available time, spreads spaced
// review into the slack when the exam is far off, and finishes with a full
// review the day before. Formats are chosen per tier: free users get
// frictionless MCQ throughout (the only always-available type); Pro users get
// a rotation of quiz styles plus a mock exam on the final day.
//
// Deterministic on purpose, no API call, so it's instant, free, and reliable.

const DAY = 86400000;
const PRO_LEARN_FORMATS = ["mcq", "cards", "fill", "match"];
const PRO_REVIEW_FORMATS = ["cards", "mcq", "match"];

const uid = () =>
  globalThis.crypto?.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2);

// Local-midnight date from a YYYY-MM-DD string (avoids the UTC off-by-one that
// `new Date("2026-08-10")` causes).
function toLocalDate(str) {
  if (str instanceof Date) return new Date(str.getFullYear(), str.getMonth(), str.getDate());
  const [y, m, d] = String(str).split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}
function dateStr(d) { return d.toLocaleDateString("en-CA"); } // YYYY-MM-DD local
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function daysBetween(a, b) { return Math.round((toLocalDate(b) - toLocalDate(a)) / DAY); }

// Parse the optional chapter-names box into a clean array (comma or newline
// separated). Returns [] when nothing usable is given.
export function parseChapters(namesText, count) {
  const names = String(namesText || "")
    .split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
  if (names.length) return { names, count: names.length };
  const n = Math.max(1, Math.min(parseInt(count, 10) || 1, 60));
  return { names: [], count: n };
}

function learnLabel(from, to, names) {
  if (names.length) {
    const slice = names.slice(from - 1, to);
    if (slice.length) return slice.join(" · ");
  }
  return from === to ? `Chapter ${from}` : `Chapters ${from}–${to}`;
}
function reviewLabel(upto, names) {
  if (names.length && upto >= 1) {
    return upto > 1 ? `Review · ${names[0]} → ${names[Math.min(upto, names.length) - 1]}` : `Review · ${names[0]}`;
  }
  return upto > 1 ? `Review · Chapters 1–${upto}` : "Review · Chapter 1";
}
function finalLabel(n) {
  return n > 1 ? `Final review · all ${n} chapters` : "Final review";
}

// Build the plan. opts:
//   testDate (YYYY-MM-DD, required, future), chapters (int) or chapterNames (text),
//   isPro (bool), mode ("selfpaced"|"remind"), reminderTime ("HH:MM"),
//   title, subject, startDate (defaults today).
export function buildPlan(opts) {
  const { testDate, isPro = false, mode = "selfpaced", reminderTime = "18:00", title = "", subject = "" } = opts || {};
  const { names, count: N } = parseChapters(opts?.chapterNames, opts?.chapters);

  const start = opts?.startDate ? toLocalDate(opts.startDate) : toLocalDate(new Date());
  const test = toLocalDate(testDate);

  // Study window: today … day before the exam (inclusive). If the exam is
  // today/tomorrow there's a single cram day.
  const total = daysBetween(start, test);
  let studyDates = [];
  for (let i = 0; i < total; i++) studyDates.push(addDays(start, i));
  if (studyDates.length === 0) studyDates = [start];

  const base = {
    id: uid(),
    title: String(title || subject || "My study plan").trim(),
    subject: String(subject || "").trim(),
    testDate,
    chapters: N,
    chapterNames: names,
    mode,
    reminderTime: mode === "remind" ? (reminderTime || "18:00") : null,
    isProPlan: !!isPro,
    createdAt: Date.now(),
    days: [],
  };

  // Trivial case: one study day → a single full mock/review over everything.
  if (studyDates.length === 1) {
    base.days = [{
      date: dateStr(studyDates[0]), kind: "final", chFrom: 1, chTo: N,
      label: finalLabel(N), format: isPro ? "exam" : "mcq", numQ: isPro ? 25 : 20, status: "pending",
    }];
    return base;
  }

  // Reserve the last day as a final review / mock exam.
  const learnDates = studyDates.slice(0, studyDates.length - 1);
  const L = learnDates.length;

  // Decide which learning slots get new chapters. When there's slack (more days
  // than chapters) chapters are spread out and the gaps become review days;
  // when time is tight, chapters are grouped so they all fit.
  const assign = new Array(L).fill(null); // {from,to} 1-based chapter range
  if (L >= N) {
    for (let k = 0; k < N; k++) assign[Math.floor((k * L) / N)] = { from: k + 1, to: k + 1 };
  } else {
    const perDay = Math.ceil(N / L);
    let ch = 1;
    for (let slot = 0; slot < L && ch <= N; slot++) {
      const to = Math.min(ch + perDay - 1, N);
      assign[slot] = { from: ch, to };
      ch = to + 1;
    }
  }

  const days = [];
  let coveredThrough = 0, learnCount = 0;
  for (let i = 0; i < L; i++) {
    const a = assign[i];
    if (a) {
      coveredThrough = Math.max(coveredThrough, a.to);
      const format = isPro ? PRO_LEARN_FORMATS[learnCount % PRO_LEARN_FORMATS.length] : "mcq";
      learnCount++;
      days.push({
        date: dateStr(learnDates[i]), kind: "learn", chFrom: a.from, chTo: a.to,
        label: learnLabel(a.from, a.to, names), format, numQ: isPro ? 20 : 15, status: "pending",
      });
    } else {
      const upto = coveredThrough || N;
      const format = isPro ? PRO_REVIEW_FORMATS[i % PRO_REVIEW_FORMATS.length] : "mcq";
      days.push({
        date: dateStr(learnDates[i]), kind: "review", chFrom: 1, chTo: upto,
        label: reviewLabel(upto, names), format, numQ: isPro ? 18 : 12, status: "pending",
      });
    }
  }
  days.push({
    date: dateStr(studyDates[studyDates.length - 1]), kind: "final", chFrom: 1, chTo: N,
    label: finalLabel(N), format: isPro ? "exam" : "mcq", numQ: isPro ? 25 : 20, status: "pending",
  });

  base.days = days;
  return base;
}

// ── Read helpers for the UI ──
export function planProgress(plan) {
  const total = plan?.days?.length || 0;
  const done = (plan?.days || []).filter((d) => d.status === "done").length;
  return { done, total, pct: total ? Math.round((done / total) * 100) : 0 };
}

// Index of the day to do next: today's day if pending, else the first pending
// day (a missed earlier day surfaces first so nothing is skipped). -1 if all done.
export function nextDayIndex(plan) {
  const days = plan?.days || [];
  const today = new Date().toLocaleDateString("en-CA");
  const todayIdx = days.findIndex((d) => d.date === today && d.status !== "done");
  if (todayIdx !== -1) return todayIdx;
  return days.findIndex((d) => d.status !== "done");
}

export function isPlanComplete(plan) {
  return (plan?.days || []).length > 0 && (plan?.days || []).every((d) => d.status === "done");
}

// Human day-status relative to today, for the schedule list.
export function dayState(day) {
  if (day.status === "done") return "done";
  const today = new Date().toLocaleDateString("en-CA");
  if (day.date === today) return "today";
  if (day.date < today) return "missed";
  return "upcoming";
}

export function prettyDate(str) {
  try { return toLocalDate(str).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }); }
  catch { return str; }
}
