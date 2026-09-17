// Badges, ranks and public flair, all derived from the study blob (lifetime
// stats, best streak, mock composites, arena bests, challenge record). Pure:
// given a blob, returns which badges are earned, progress toward the rest, and
// the learner's rank. We only persist which badges are earned and which one is
// pinned as flair. Two layers: badges (a trophy case) and rank (one guild tier).

// the scholar-guild ladder. `min` is the XP floor; `color` paints the rank pill
// in the app and on public boards. `icon` is a name in Icon.jsx; `emoji` is only
// for the canvas share card, which can't render SVG.
export const RANKS = [
  { key: "novice",     name: "Novice",     min: 0,    icon: "rank_novice",     emoji: "🌱", color: "#6b7280" },
  { key: "apprentice", name: "Apprentice", min: 400,  icon: "rank_apprentice", emoji: "📖", color: "#0f6e56" },
  { key: "adept",      name: "Adept",      min: 1000, icon: "rank_adept",      emoji: "🧭", color: "#185fa5" },
  { key: "scholar",    name: "Scholar",    min: 2000, icon: "rank_scholar",    emoji: "🎓", color: "#4f46e5" },
  { key: "sage",       name: "Sage",       min: 3500, icon: "rank_sage",       emoji: "🦉", color: "#7c3aed" },
  { key: "master",     name: "Master",     min: 5500, icon: "rank_master",     emoji: "📜", color: "#b45309" },
  { key: "luminary",   name: "Luminary",   min: 8000, icon: "rank_luminary",   emoji: "☀️", color: "#a3762b" },
];

// difficulty-adaptive XP: a correct answer is worth more the harder the set.
// `diffXP` is a lifetime accumulator, so grinding easy sets ranks slowly and
// clearing hard ones climbs fast. purely additive so it doesn't disturb anyone's
// existing standing.
export const DIFF_PREMIUM = [0, 0.9, 2.4]; // per correct answer at [easy, normal, hard]
export function diffXPFor(correct = 0, diff = 1) {
  const d = Math.max(0, Math.min(2, Math.round(Number(diff) || 0)));
  return Math.max(0, Math.round(Number(correct) || 0)) * DIFF_PREMIUM[d];
}

// lifetime XP: a flat participation + accuracy base, plus the difficulty premium
// (diffXP), streaks, arena bests and wins
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

// tier for an XP total: highest rank whose floor is met, plus progress toward
// the next (0..1, null at the top)
export function rankFor(xp) {
  let idx = 0;
  for (let i = 0; i < RANKS.length; i++) if (xp >= RANKS[i].min) idx = i;
  const cur = RANKS[idx], next = RANKS[idx + 1] || null;
  const toNext = next ? Math.max(0, Math.min(1, (xp - cur.min) / (next.min - cur.min))) : null;
  return { ...cur, index: idx, xp, next, toNext };
}
// Study XP that feeds rank: lifetime practice, accuracy, difficulty, streaks,
// hard passes, perfect quizzes and challenge wins. Kept on the same scale as an
// arena score (see RANKS floors) so a dedicated studier climbs the ladder from
// study alone, never having to touch the Arena.
export function studyRankXP(stats) {
  const s = stats || {};
  return Math.max(0, Math.round(
    (Number(s.answered) || 0) * 0.5 +        // participation
    (Number(s.correct) || 0) * 0.5 +         // accuracy
    (Number(s.diffXP) || 0) +                // harder correct answers worth more
    (Number(s.best) || 0) * 20 +             // best streak
    (Number(s.hardPasses) || 0) * 10 +       // clearing Hard sets
    (Number(s.perfectQuizzes) || 0) * 15 +   // 100% quizzes
    (Number(s.challengeWins) || 0) * 40,     // head-to-head wins
  ));
}

// rank is your best arena run PLUS your lifetime study XP, on the same ladder, so
// arena players and dedicated studiers both climb (and doing both climbs fastest).
export function rankOf(study) {
  const s = (study && study.stats) ? study.stats : (study || {});
  const arenaBest = Math.max(0, Math.round(Number(s.arenaBest) || 0));
  return rankFor(arenaBest + studyRankXP(s));
}

// Streak tiers: the flame gets a rougher, wilder icon, a hotter colour and a
// stronger glow the longer the run holds. `min` is the day threshold that
// PROMOTES the flame, and crossing one (from Kindled up) fires a one-time
// celebration. `fx` is the animated-glow level (0 = none; the first two lit
// tiers stay calm, then it intensifies to 3 at Phoenix). `icon` names a flame in
// Icon.jsx; tier names are localized via streakTier_<key>. Pure, so the flame
// component, the celebration and tests all read the same ladder.
export const STREAK_TIERS = [
  { key: "cold",      min: 0,   name: "No streak", icon: "flame",       color: "#9ca3af", fx: 0 },
  { key: "spark",     min: 1,   name: "Spark",     icon: "flame",       color: "#f59e0b", fx: 0 },
  { key: "kindled",   min: 14,  name: "Kindled",   icon: "flame_rough", color: "#fb923c", fx: 0 },
  { key: "blaze",     min: 30,  name: "Blaze",     icon: "flame_rough", color: "#f97316", fx: 1 },
  { key: "wildfire",  min: 60,  name: "Wildfire",  icon: "flame_wild",  color: "#ef4444", fx: 1 },
  { key: "inferno",   min: 90,  name: "Inferno",   icon: "flame_wild",  color: "#dc2626", fx: 2 },
  { key: "firestorm", min: 180, name: "Firestorm", icon: "flame_wild",  color: "#b91c1c", fx: 2 },
  { key: "phoenix",   min: 365, name: "Phoenix",   icon: "flame_wild",  color: "#7c3aed", fx: 3 },
];

// The streak tier for a day count: the highest tier whose floor is met.
export function streakTier(days) {
  const n = Math.max(0, Math.round(Number(days) || 0));
  let i = 0;
  for (let k = 0; k < STREAK_TIERS.length; k++) if (n >= STREAK_TIERS[k].min) i = k;
  return { ...STREAK_TIERS[i], index: i, days: n };
}

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

// each badge: id, category, emoji, a `value(ctx)`, a `target`, and an optional
// `count(ctx)` shown as "earned ×N". names/descs are localized in the UI via
// badge_<id> / badgeDesc_<id>; the English here is the fallback and source copy.
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
  // meta: earn every other badge in the case
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
