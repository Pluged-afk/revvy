// ── Badges, ranks + public flair ─────────────────────────────────────────
// A collectible achievement system layered over the signals Revyy already
// tracks in the server-synced study blob (lifetime stats, best streak, mock
// composites, arena bests, challenge record). Everything here is PURE: given a
// study blob it returns which badges are earned, progress toward the rest, and
// the learner's overall rank ("status"). Nothing is stored beyond a tiny record
// of which badges have been earned + which one is equipped as public flair.
//
// Two visible layers:
//   1. badges  – discrete achievements, a trophy case you fill in.
//   2. rank    – one guild tier derived from lifetime XP, shown next to your
//                name everywhere public. You pin ONE earned badge as flair.

// The scholar-guild ladder. `min` is the XP floor for the tier; colors are used
// for the rank pill in both the app and the public leaderboards.
export const RANKS = [
  { key: "novice",     name: "Novice",     min: 0,     emoji: "🌱", color: "#6b7280" },
  { key: "apprentice", name: "Apprentice", min: 300,   emoji: "📗", color: "#0f6e56" },
  { key: "adept",      name: "Adept",      min: 1200,  emoji: "📘", color: "#185fa5" },
  { key: "scholar",    name: "Scholar",    min: 3000,  emoji: "🎓", color: "#4f46e5" },
  { key: "sage",       name: "Sage",       min: 7000,  emoji: "🔭", color: "#7c3aed" },
  { key: "master",     name: "Master",     min: 15000, emoji: "⭐", color: "#b45309" },
  { key: "luminary",   name: "Luminary",   min: 30000, emoji: "🏆", color: "#a3762b" },
];

// ── Difficulty-adaptive XP ──────────────────────────────────────────────
// A correct answer is worth more the harder the question. `diffXP` is a
// lifetime accumulator: on every graded quiz/exam we add each correct answer's
// premium for that set's difficulty, so grinding easy sets ranks you slowly
// while clearing hard ones climbs fast. Easy earns no premium (participation +
// accuracy only), Normal a little, Hard a lot. Purely additive, so it kicks in
// going forward without disturbing any existing learner's standing.
export const DIFF_PREMIUM = [0, 0.9, 2.4]; // per correct answer at [easy, normal, hard]
export function diffXPFor(correct = 0, diff = 1) {
  const d = Math.max(0, Math.min(2, Math.round(Number(diff) || 0)));
  return Math.max(0, Math.round(Number(correct) || 0)) * DIFF_PREMIUM[d];
}

// Lifetime XP from honestly-earned signals. A flat participation + accuracy
// base, PLUS the difficulty premium (diffXP), streaks, arena bests and wins.
export function computeXP(ctx) {
  return Math.round(
    (ctx.answered || 0) +           // participation, difficulty-neutral
    (ctx.correct || 0) * 0.5 +      // accuracy, difficulty-neutral
    (ctx.diffXP || 0) +             // adaptive: harder correct answers are worth more
    (ctx.best || 0) * 25 +
    (ctx.arenaBest || 0) / 8 +      // arena scoring is itself difficulty-scaled
    (ctx.challengeWins || 0) * 40 +
    (ctx.perfectQuizzes || 0) * 15,
  );
}

// The tier for a given XP total: highest rank whose floor is met. Returns the
// rank object plus its index and progress toward the next tier (0..1, null at top).
export function rankFor(xp) {
  let idx = 0;
  for (let i = 0; i < RANKS.length; i++) if (xp >= RANKS[i].min) idx = i;
  const cur = RANKS[idx], next = RANKS[idx + 1] || null;
  const toNext = next ? Math.max(0, Math.min(1, (xp - cur.min) / (next.min - cur.min))) : null;
  return { ...cur, index: idx, xp, next, toNext };
}
export function rankOf(study) { return rankFor(computeXP(buildCtx(study))); }

// Flatten the study blob into the plain numbers every badge check reads.
export function buildCtx(study = {}) {
  const s = study.stats || {}, m = study.mockScores || {};
  const answered = s.answered || 0, correct = s.correct || 0;
  return {
    answered, correct,
    accuracy: answered ? correct / answered : 0,
    best: s.best || 0,
    diffXP: s.diffXP || 0,
    perfectQuizzes: s.perfectQuizzes || 0,
    hardPasses: s.hardPasses || 0,
    arenaBest: s.arenaBest || 0,
    arenaBestRun: s.arenaBestRun || 0,
    challengeWins: s.challengeWins || 0,
    challengePlayed: s.challengePlayed || 0,
    groupsJoined: s.groupsJoined || 0,
    mockCount: Object.keys(m).length,
    satComposite: m.sat?.best?.composite || 0,
    actComposite: m.act?.best?.composite || 0,
    subjectCounts: (s.subjectCounts && typeof s.subjectCounts === "object") ? s.subjectCounts : {},
    // How many distinct subjects the learner has meaningfully studied (>=20 Qs).
    domainCount: Object.values((s.subjectCounts && typeof s.subjectCounts === "object") ? s.subjectCounts : {}).filter((v) => (Number(v) || 0) >= 20).length,
  };
}

// Each badge: id, category, emoji, a current `value(ctx)`, a `target` it must
// reach, and an optional `count(ctx)` shown as "earned ×N". Names + descriptions
// are localized in the UI via `badge_<id>` / `badgeDesc_<id>` i18n keys; the
// English text here is the fallback and the source of the copy.
export const BADGES = [
  // Consistency
  { id: "warmup",       cat: "consistency", emoji: "🔥", name: "Warmed Up",     desc: "Finish your first activity",   value: (c) => c.answered, target: 1 },
  { id: "regular",      cat: "consistency", emoji: "📆", name: "Regular",       desc: "Reach a 7-day streak",         value: (c) => c.best, target: 7 },
  { id: "unbroken",     cat: "consistency", emoji: "⛓️", name: "Unbroken",      desc: "Reach a 30-day streak",        value: (c) => c.best, target: 30 },
  { id: "century_days", cat: "consistency", emoji: "💯", name: "Hundred Days",  desc: "Reach a 100-day streak",       value: (c) => c.best, target: 100 },
  { id: "year_one",     cat: "consistency", emoji: "🎂", name: "Year One",      desc: "Reach a 365-day streak",       value: (c) => c.best, target: 365 },
  // Volume
  { id: "century",      cat: "volume", emoji: "💠", name: "Century",       desc: "Answer 100 questions",      value: (c) => c.answered, target: 100 },
  { id: "thousand",     cat: "volume", emoji: "🔵", name: "Thousand Club", desc: "Answer 1,000 questions",    value: (c) => c.answered, target: 1000 },
  { id: "ten_thousand", cat: "volume", emoji: "🌀", name: "Ten Thousand",  desc: "Answer 10,000 questions",   value: (c) => c.answered, target: 10000 },
  // Accuracy
  { id: "flawless",       cat: "accuracy", emoji: "🎯", name: "Flawless",      desc: "Score 100% on a quiz",             value: (c) => c.perfectQuizzes, target: 1, count: (c) => c.perfectQuizzes },
  { id: "perfectionist",  cat: "accuracy", emoji: "💎", name: "Perfectionist", desc: "Score 100% on 10 quizzes",         value: (c) => c.perfectQuizzes, target: 10 },
  { id: "sharp",          cat: "accuracy", emoji: "🧠", name: "Sharp",         desc: "Hold 90% accuracy over 200 answers", value: (c) => (c.answered >= 200 ? Math.round(c.accuracy * 100) : 0), target: 90 },
  // Difficulty
  { id: "step_up",   cat: "difficulty", emoji: "⛰️", name: "Step Up",   desc: "Pass a Hard quiz",           value: (c) => c.hardPasses, target: 1 },
  { id: "relentless",cat: "difficulty", emoji: "🗻", name: "Relentless",desc: "Pass 15 Hard quizzes",       value: (c) => c.hardPasses, target: 15 },
  { id: "proven",    cat: "difficulty", emoji: "👑", name: "Proven",    desc: "Win the majority of at least 3 challenges", value: (c) => (c.challengePlayed >= 3 && c.challengeWins / c.challengePlayed >= 0.6 ? 1 : 0), target: 1 },
  // Exams / mocks
  { id: "test_ready", cat: "exams", emoji: "📝", name: "Test Ready", desc: "Take your first mock exam",   value: (c) => c.mockCount, target: 1 },
  { id: "full_slate", cat: "exams", emoji: "🗂️", name: "Full Slate", desc: "Attempt all 8 mock exams",    value: (c) => c.mockCount, target: 8 },
  { id: "sat_1500",   cat: "exams", emoji: "🏅", name: "1500 Club",  desc: "Score 1500+ on a SAT mock",   value: (c) => c.satComposite, target: 1500 },
  { id: "act_34",     cat: "exams", emoji: "🎖️", name: "Top Marks",  desc: "Score 34+ on an ACT mock",    value: (c) => c.actComposite, target: 34 },
  // Endless Arena
  { id: "first_run",   cat: "arena", emoji: "⚡", name: "First Run",    desc: "Play the Endless Arena",       value: (c) => c.arenaBestRun, target: 1 },
  { id: "streaker",    cat: "arena", emoji: "🌟", name: "Streaker",     desc: "Reach 25 in one arena run",    value: (c) => c.arenaBestRun, target: 25 },
  { id: "half_century",cat: "arena", emoji: "☄️", name: "Half Century", desc: "Reach 50 in one arena run",    value: (c) => c.arenaBestRun, target: 50 },
  { id: "centurion",   cat: "arena", emoji: "🚀", name: "Centurion",    desc: "Reach 100 in one arena run",   value: (c) => c.arenaBestRun, target: 100 },
  // Challenges + social
  { id: "challenger", cat: "challenges", emoji: "⚔️", name: "Challenger", desc: "Play a group challenge",   value: (c) => c.challengePlayed, target: 1 },
  { id: "winner",     cat: "challenges", emoji: "🥇", name: "Winner",     desc: "Win a group challenge",    value: (c) => c.challengeWins, target: 1 },
  { id: "undefeated", cat: "challenges", emoji: "🛡️", name: "Undefeated", desc: "Win 10 group challenges",  value: (c) => c.challengeWins, target: 10 },
  { id: "team_player",cat: "challenges", emoji: "🤝", name: "Team Player",desc: "Join a study group",       value: (c) => c.groupsJoined, target: 1 },
  // Subjects — earned by what you actually study (classified from each set's
  // subject + topics). "A lot of math questions" makes you a Mathematician, etc.
  { id: "mathematician", cat: "subjects", emoji: "➗", name: "Mathematician", desc: "Answer 60 math questions",     value: (c) => c.subjectCounts.math || 0, target: 60 },
  { id: "scientist",     cat: "subjects", emoji: "🔬", name: "Scientist",     desc: "Answer 60 science questions",  value: (c) => c.subjectCounts.science || 0, target: 60 },
  { id: "historian",     cat: "subjects", emoji: "🏛️", name: "Historian",     desc: "Answer 60 history questions",  value: (c) => c.subjectCounts.history || 0, target: 60 },
  { id: "wordsmith",     cat: "subjects", emoji: "✍️", name: "Wordsmith",     desc: "Answer 60 language questions", value: (c) => c.subjectCounts.language || 0, target: 60 },
  { id: "geographer",    cat: "subjects", emoji: "🗺️", name: "Geographer",    desc: "Answer 60 geography questions",value: (c) => c.subjectCounts.geography || 0, target: 60 },
  { id: "economist",     cat: "subjects", emoji: "📈", name: "Economist",     desc: "Answer 60 business questions", value: (c) => c.subjectCounts.business || 0, target: 60 },
  { id: "polymath",      cat: "subjects", emoji: "🧩", name: "Polymath",      desc: "Study 4 different subjects",   value: (c) => c.domainCount, target: 4 },
  // Meta — the ultimate: earn every other badge in the case.
  { id: "the_full_set",  cat: "meta", emoji: "🏵️", name: "The Full Set", desc: "Earn every other badge", meta: true },
];

export const BADGE_BY_ID = Object.fromEntries(BADGES.map((b) => [b.id, b]));
export const BADGE_CATEGORIES = ["consistency", "volume", "accuracy", "difficulty", "exams", "arena", "challenges", "subjects", "meta"];

// Classify a set's subject/topic text into a broad domain for the subject
// badges. Keyword match, first hit wins; returns null when nothing matches.
export const SUBJECT_DOMAINS = {
  math: ["math", "algebra", "calculus", "geometr", "trigonometr", "arithmetic", "equation", "statistic", "probability", "fraction", "polynomial", "derivative", "integral", "theorem"],
  science: ["biolog", "chemistr", "physic", "science", "cell", "atom", "molecul", "organism", "reaction", "photosynth", "ecosystem", "genetic", "enzyme", "electron", "quantum", "anatomy", "astronom"],
  history: ["history", "histor", "war", "revolution", "ancient", "empire", "dynasty", "civiliz", "treaty", "medieval", "colonial", "pharaoh", "renaissance"],
  language: ["grammar", "literatur", "vocabular", "essay", "poem", "poetry", "novel", "language", "syntax", "rhetoric", "linguistic", "shakespeare", "adjective", "sentence"],
  geography: ["geograph", "capital", "continent", "country", "countries", "river", "mountain", "climate", "ocean", "terrain"],
  business: ["econom", "business", "market", "finance", "account", "supply", "demand", "profit", "trade", "management", "marketing", "investment"],
};
export function classifyDomain(text) {
  const s = String(text || "").toLowerCase();
  for (const [dom, kws] of Object.entries(SUBJECT_DOMAINS)) if (kws.some((k) => s.includes(k))) return dom;
  return null;
}

// Evaluate every badge against a study blob. Returns, per badge id, the current
// value, its target, an earned flag, a 0..100 progress percent, and an optional
// repeat count. Also returns `earnedIds` (all currently satisfied).
export function evaluateBadges(study = {}) {
  const c = buildCtx(study);
  const progress = {}; const earnedIds = [];
  const regular = BADGES.filter((b) => !b.meta);
  for (const b of regular) {
    const value = Math.max(0, Math.round(b.value(c)));
    const earned = value >= b.target;
    const pct = Math.max(0, Math.min(100, Math.round((value / b.target) * 100)));
    progress[b.id] = { value, target: b.target, earned, pct, count: b.count ? Math.max(0, Math.round(b.count(c))) : null };
    if (earned) earnedIds.push(b.id);
  }
  // Meta badges: earned once every non-meta badge is earned (the completionist).
  const done = earnedIds.length, total = regular.length;
  for (const b of BADGES.filter((x) => x.meta)) {
    const earned = done >= total;
    progress[b.id] = { value: done, target: total, earned, pct: Math.round((done / total) * 100), count: null };
    if (earned) earnedIds.push(b.id);
  }
  return { progress, earnedIds, ctx: c };
}

// Given the blob's stored `badges.earned` list, return the ids that are newly
// satisfied (used to fire an unlock toast, and to append to the earned record).
export function newlyEarned(study = {}) {
  const already = new Set((study.badges?.earned || []).map((e) => e.id));
  return evaluateBadges(study).earnedIds.filter((id) => !already.has(id));
}
