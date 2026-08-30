import { verifyToken } from "@clerk/backend";
import { randomBytes } from "crypto";
import sql, { readBody } from "./db.js";

// Server-synced study data + shared-quiz storage. Kept in ONE serverless
// function to stay under the Vercel Hobby plan's 12-function limit.
//
//   Authed (Authorization: Bearer <clerk token>):
//     GET  /api/study                        -> { data }  (the user's blob)
//     POST /api/study { data }               -> upsert the blob (last-write-wins)
//     POST /api/study { action:"createShare", quiz } -> { id }  create a share link
//   Public (no account needed - friends take a shared quiz):
//     GET  /api/study?shared=<id>            -> { quiz, owner, results }
//     POST /api/study { action:"shareScore", id, name, score, total } -> { results }

// Self-provision tables (idempotent), cached per warm lambda instance.
let ensured = null;
function ensureTables() {
  if (!ensured) {
    ensured = Promise.all([
      sql`CREATE TABLE IF NOT EXISTS study_data (
        clerk_user_id TEXT PRIMARY KEY,
        data          JSONB       NOT NULL DEFAULT '{}'::jsonb,
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
      sql`CREATE TABLE IF NOT EXISTS shared_quizzes (
        id         TEXT PRIMARY KEY,
        data       JSONB       NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
      // GLOBAL, cross-user mock-exam learning bank. Mock questions come from the
      // model's general knowledge of standardized tests (SAT/ACT/etc.), NOT from
      // any user's private material, so pooling them across everyone is safe.
      // We keep questions the crowd generates + a flag count, and feed the good
      // ones back into generation as STYLE exemplars and the flagged ones as an
      // avoid-list, so mocks get more authentic for everyone over time. We never
      // serve exact copies; generation stays fresh.
      sql`CREATE TABLE IF NOT EXISTS mock_bank (
        id         BIGSERIAL   PRIMARY KEY,
        exam       TEXT        NOT NULL,
        section    TEXT        NOT NULL,
        qhash      TEXT        NOT NULL,
        data       JSONB       NOT NULL,
        uses       INT         NOT NULL DEFAULT 1,
        flags      INT         NOT NULL DEFAULT 0,  -- count of DISTINCT users who flagged it
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (exam, section, qhash)
      )`,
      // Per-user, per-day action counters, so a single account cannot flood the
      // shared bank with contributions or grief it with mass flags.
      sql`CREATE TABLE IF NOT EXISTS mock_actor (
        clerk_user_id TEXT NOT NULL,
        day           DATE NOT NULL DEFAULT CURRENT_DATE,
        contribs      INT  NOT NULL DEFAULT 0,
        flags         INT  NOT NULL DEFAULT 0,
        PRIMARY KEY (clerk_user_id, day)
      )`,
      // One row per (user, question) flagged, so flags are deduped and the
      // bank's flag count reflects DISTINCT users, not one person spamming.
      sql`CREATE TABLE IF NOT EXISTS mock_flag (
        clerk_user_id TEXT        NOT NULL,
        exam          TEXT        NOT NULL,
        section       TEXT        NOT NULL,
        qhash         TEXT        NOT NULL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (clerk_user_id, exam, section, qhash)
      )`,
      // ── Endless Arena ──
      // Pooled general-knowledge questions for the no-upload high-score game.
      // Each carries a fixed correct answer plus a POOL of relevant distractors
      // (3 are sampled at random per serve), a difficulty the generator guesses
      // and the crowd then refines via play stats.
      sql`CREATE TABLE IF NOT EXISTS gk_pool (
        id            BIGSERIAL   PRIMARY KEY,
        qhash         TEXT        UNIQUE NOT NULL,
        category      TEXT        NOT NULL DEFAULT 'general',
        question      TEXT        NOT NULL,
        correct       TEXT        NOT NULL,
        distractors   JSONB       NOT NULL,
        difficulty    REAL        NOT NULL DEFAULT 2.5,
        plays         INT         NOT NULL DEFAULT 0,
        correct_count INT         NOT NULL DEFAULT 0,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
      // One row per player: their public best run. The board is keyed on this.
      sql`CREATE TABLE IF NOT EXISTS arena_score (
        clerk_user_id TEXT        PRIMARY KEY,
        best_score    INT         NOT NULL DEFAULT 0,
        questions     INT         NOT NULL DEFAULT 0,
        freeze_used   INT         NOT NULL DEFAULT 0,
        hint_used     INT         NOT NULL DEFAULT 0,
        skip_used     INT         NOT NULL DEFAULT 0,
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
    ]).then(() => sql`CREATE INDEX IF NOT EXISTS mock_bank_bucket ON mock_bank (exam, section)`)
      .then(() => sql`CREATE INDEX IF NOT EXISTS arena_board ON arena_score (best_score DESC)`)
      .then(() => sql`CREATE INDEX IF NOT EXISTS gk_pool_diff ON gk_pool (difficulty)`)
      .then(() => true).catch(() => { ensured = null; return false; });
  }
  return ensured;
}

async function userFromToken(req) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return null;
  try {
    const payload = await verifyToken(token, { secretKey: process.env.CLERK_SECRET_KEY });
    return payload.sub || null;
  } catch (e) {
    console.error("[study] token verify failed:", e.message);
    return null;
  }
}

// Trim + length-cap a string, dropping control characters (code < 32 or DEL).
// Quiz content is single-line, and this keeps friend-submitted names clean.
const clean = (s, max) =>
  String(s ?? "")
    .split("")
    .filter((ch) => { const n = ch.charCodeAt(0); return n >= 32 && n !== 127; })
    .join("")
    .trim()
    .slice(0, max);
const shortId = () => randomBytes(5).toString("hex"); // 10 hex chars

// Keep a shared quiz's stored payload lean and safe: cap question count and
// field sizes, keep only what the taker needs.
function sanitizeQuiz(q) {
  if (!q || !Array.isArray(q.questions) || !q.questions.length) return null;
  const questions = q.questions.slice(0, 100).map((x) => ({
    question: clean(x.question, 600),
    options: Array.isArray(x.options) ? x.options.slice(0, 6).map((o) => clean(o, 300)) : [],
    correct: Number.isInteger(x.correct) ? x.correct : 0,
    answer: clean(x.answer, 600),
    explanation: clean(x.explanation, 600),
  }));
  // The sharer's own score, if they shared straight from a results screen, 
  // powers the "beat my 8/10" challenge framing on the taker page.
  const oScore = Number.isFinite(+q.ownerScore) ? Math.max(0, Math.min(+q.ownerScore | 0, 1000)) : null;
  const oTotal = Number.isFinite(+q.ownerTotal) ? Math.max(1, Math.min(+q.ownerTotal | 0, 1000)) : null;
  return {
    title: clean(q.title, 120) || "Shared quiz",
    subject: clean(q.subject, 120),
    type: ["mcq", "cards", "fill", "match"].includes(q.type) ? q.type : "mcq",
    diff: Number.isInteger(q.diff) ? q.diff : 1,
    owner: clean(q.owner, 40),
    ownerScore: oScore != null && oTotal != null ? oScore : null,
    ownerTotal: oScore != null && oTotal != null ? oTotal : null,
    questions,
    results: [],
    createdAt: Date.now(),
  };
}

function topResults(results) {
  return [...(results || [])]
    .sort((a, b) => (b.score / Math.max(1, b.total)) - (a.score / Math.max(1, a.total)))
    .slice(0, 20);
}

// ── Public: fetch a shared quiz ──
async function getSharedQuiz(req, res, id) {
  const rows = await sql`SELECT data FROM shared_quizzes WHERE id = ${id} LIMIT 1`;
  const d = rows[0]?.data;
  if (!d) return res.status(404).json({ error: "Quiz not found." });
  return res.status(200).json({
    quiz: { title: d.title, subject: d.subject, type: d.type, diff: d.diff, questions: d.questions },
    owner: d.owner || "",
    ownerScore: d.ownerScore ?? null,
    ownerTotal: d.ownerTotal ?? null,
    results: topResults(d.results),
  });
}

// ── Public: record a friend's score on a shared quiz ──
async function recordShareScore(req, res, body) {
  const id = clean(body.id, 20);
  if (!id) return res.status(400).json({ error: "Missing quiz id." });
  const rows = await sql`SELECT data FROM shared_quizzes WHERE id = ${id} LIMIT 1`;
  const d = rows[0]?.data;
  if (!d) return res.status(404).json({ error: "Quiz not found." });
  const entry = {
    name: clean(body.name, 24) || "Anonymous",
    score: Math.max(0, Math.min(parseInt(body.score, 10) || 0, 1000)),
    total: Math.max(1, Math.min(parseInt(body.total, 10) || 1, 1000)),
    at: Date.now(),
  };
  const results = [...(d.results || []), entry].slice(-200); // bound growth
  await sql`UPDATE shared_quizzes SET data = jsonb_set(data, '{results}', ${JSON.stringify(results)}::jsonb) WHERE id = ${id}`;
  return res.status(200).json({ results: topResults(results) });
}

// ── Authed: create a share link ──
async function createShare(req, res, body, userId) {
  const quiz = sanitizeQuiz(body.quiz);
  if (!quiz) return res.status(400).json({ error: "Invalid quiz." });
  quiz.ownerId = userId;
  const id = shortId();
  await sql`INSERT INTO shared_quizzes (id, data) VALUES (${id}, ${JSON.stringify(quiz)}::jsonb)`;
  return res.status(200).json({ id });
}

// ── Authed: the sender's challenge activity ──
// Returns the quizzes this user shared that someone has since taken, with the
// most recent takers and whether they beat the sender's score, so the app can
// show "Bombo scored 8/10 on your quiz" and keep the rivalry going.
async function myChallenges(req, res, userId) {
  const rows = await sql`
    SELECT id, data, created_at FROM shared_quizzes
    WHERE data->>'ownerId' = ${userId}
    ORDER BY created_at DESC LIMIT 30`;
  const challenges = rows.map((r) => {
    const d = r.data || {};
    const takers = [...(d.results || [])].sort((a, b) => (b.at || 0) - (a.at || 0));
    return {
      id: r.id,
      title: d.title || "Shared quiz",
      ownerScore: d.ownerScore ?? null,
      ownerTotal: d.ownerTotal ?? null,
      takerCount: takers.length,
      takers: takers.slice(0, 12).map((x) => ({ name: x.name, score: x.score, total: x.total, at: x.at })),
    };
  }).filter((c) => c.takerCount > 0);
  return res.status(200).json({ challenges });
}

// ── Global mock-exam learning bank ──
// Standardized-test questions the crowd generates, pooled to make everyone's
// mocks more authentic. Keyed by exam + section. Privacy-safe (general test
// knowledge, never user material). All endpoints require a signed-in user.
const MOCK_BANK_CAP = 300;        // questions kept per (exam, section) bucket
const MOCK_CONTRIB_DAILY = 600;   // items one account may add to the bank per day
const MOCK_FLAG_DAILY = 60;       // flags one account may cast per day
const MOCK_FLAG_AVOID = 2;        // distinct-user flags before a question is avoided
const MOCK_ITEMS_PER_CALL = 60;   // items accepted from a single contribute call
const examKey = (s) => clean(s, 40);
const sectionKey = (s) => clean(s, 60);

// Contributed questions are fed back into the generation PROMPT as style
// exemplars for OTHER users, so a poisoned contribution is really an attempt to
// hijack generation for everyone. Reject anything that reads like a prompt
// injection / role hijack, carries a link, code fence, or special model tokens,
// or is non-question junk, before it can ever enter the shared pool. Deterministic
// and cheap (runs on every contributed item, incl. direct-API calls that skip the UI).
const INJECT_RE = /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|instruction|instructions|prompt|context|rules?|system)\b/i;
const ROLE_RE = /<\/?(system|assistant|user|instruction|instructions)\b|(^|\n)\s*(system|assistant|user)\s*:|you are (now )?(a |an )?(ai|assistant|model|chatbot|language model|dan)\b|\bjailbreak\b|\bdo anything now\b/i;
const TOKEN_RE = /<\|[^|]*\|>|```|\[\/?INST\]|<<SYS>>|\bBEGIN SYSTEM\b/i;
const LINK_RE = /https?:\/\/|\bwww\.\S/i;
function looksAbusive(text) {
  const s = String(text || "");
  if (!s) return false;
  if (INJECT_RE.test(s) || ROLE_RE.test(s) || TOKEN_RE.test(s) || LINK_RE.test(s)) return true;
  // Mostly non-letters (encoded blob / junk) or an absurdly long unbroken token.
  const letters = (s.match(/[a-zA-Z]/g) || []).length;
  if (s.length >= 20 && letters / s.length < 0.3) return true;
  if (/\S{80,}/.test(s)) return true;
  return false;
}

// Keep only a clean, well-formed, non-abusive MCQ, size-capped, with an optional safe SVG.
function sanitizeMockItem(x) {
  if (!x || typeof x !== "object") return null;
  const q = clean(x.question, 1200);
  if (q.length < 8) return null;
  const options = Array.isArray(x.options) ? x.options.slice(0, 8).map((o) => clean(o, 400)).filter(Boolean) : [];
  if (options.length < 2) return null;
  const correct = Number.isInteger(x.correct) && x.correct >= 0 && x.correct < options.length ? x.correct : null;
  if (correct == null) return null;
  const explanation = clean(x.explanation, 400);
  // Safety gate: drop anything that could steer other users' generations.
  if (looksAbusive(q) || options.some(looksAbusive) || looksAbusive(explanation)) return null;
  const qhash = clean(x.qhash, 24) || String(Math.abs([...q.toLowerCase()].reduce((h, c) => (h * 33 + c.charCodeAt(0)) | 0, 5381)));
  const data = { question: q, options, correct, explanation };
  const svg = typeof x.svg === "string" ? x.svg.trim() : "";
  if (/^<svg[\s>]/i.test(svg) && svg.length < 8000 && !/<script|<foreignobject|\son\w+\s*=|javascript:/i.test(svg)) data.svg = svg;
  return { qhash, data };
}

// Contribute freshly generated (filter-passed) questions to the global bank.
// Guards: a per-account daily budget (a normal user is already capped at a
// couple of mocks/day, so this only bites a direct-API flood) and the abuse
// screen inside sanitizeMockItem.
async function mockContribute(req, res, body, userId) {
  const exam = examKey(body.exam), section = sectionKey(body.section);
  if (!exam || !section) return res.status(400).json({ error: "Missing exam/section." });
  const used = (await sql`SELECT contribs FROM mock_actor WHERE clerk_user_id = ${userId} AND day = CURRENT_DATE`)[0]?.contribs || 0;
  if (used >= MOCK_CONTRIB_DAILY) return res.status(200).json({ ok: true, stored: 0, capped: true });
  const room = MOCK_CONTRIB_DAILY - used;
  const items = (Array.isArray(body.items) ? body.items : [])
    .slice(0, MOCK_ITEMS_PER_CALL).map(sanitizeMockItem).filter(Boolean).slice(0, room);
  for (const it of items) {
    await sql`INSERT INTO mock_bank (exam, section, qhash, data) VALUES (${exam}, ${section}, ${it.qhash}, ${JSON.stringify(it.data)}::jsonb)
              ON CONFLICT (exam, section, qhash) DO UPDATE SET uses = mock_bank.uses + 1`;
  }
  if (items.length) {
    await sql`INSERT INTO mock_actor (clerk_user_id, day, contribs) VALUES (${userId}, CURRENT_DATE, ${items.length})
              ON CONFLICT (clerk_user_id, day) DO UPDATE SET contribs = mock_actor.contribs + ${items.length}`;
  }
  // Prune the bucket: keep the best (fewest flags, most uses, newest), drop the rest.
  await sql`DELETE FROM mock_bank WHERE id IN (
    SELECT id FROM mock_bank WHERE exam = ${exam} AND section = ${section}
    ORDER BY flags ASC, uses DESC, created_at DESC OFFSET ${MOCK_BANK_CAP})`;
  // Occasional housekeeping of the tiny rate-limit + flag ledgers.
  if (Math.random() < 0.05) {
    await sql`DELETE FROM mock_actor WHERE day < CURRENT_DATE - 3`;
    await sql`DELETE FROM mock_flag WHERE created_at < NOW() - INTERVAL '120 days'`;
  }
  return res.status(200).json({ ok: true, stored: items.length });
}

// Flag a mock question as bad (learner reported a problem). Feeds the avoid-list.
// Guards: one flag per user per question (deduped), and a per-account daily flag
// budget, so no single account can grief the bank by mass-flagging.
async function mockFlag(req, res, body, userId) {
  const exam = examKey(body.exam), section = sectionKey(body.section), qhash = clean(body.qhash, 24);
  if (!exam || !section || !qhash) return res.status(400).json({ error: "Missing fields." });
  const used = (await sql`SELECT flags FROM mock_actor WHERE clerk_user_id = ${userId} AND day = CURRENT_DATE`)[0]?.flags || 0;
  if (used >= MOCK_FLAG_DAILY) return res.status(200).json({ ok: true, capped: true });
  // First flag from this user on this question counts; repeats are no-ops.
  const ins = await sql`INSERT INTO mock_flag (clerk_user_id, exam, section, qhash) VALUES (${userId}, ${exam}, ${section}, ${qhash})
                        ON CONFLICT DO NOTHING RETURNING 1`;
  if (!ins.length) return res.status(200).json({ ok: true, duplicate: true });
  await sql`UPDATE mock_bank SET flags = flags + 1 WHERE exam = ${exam} AND section = ${section} AND qhash = ${qhash}`;
  await sql`INSERT INTO mock_actor (clerk_user_id, day, flags) VALUES (${userId}, CURRENT_DATE, 1)
            ON CONFLICT (clerk_user_id, day) DO UPDATE SET flags = mock_actor.flags + 1`;
  return res.status(200).json({ ok: true });
}

// Draw a few good questions as STYLE exemplars + flagged stems to avoid, for the
// next generation of this exam section. Exemplars are pristine (never flagged);
// a stem only reaches the avoid-list once MOCK_FLAG_AVOID DISTINCT users flag it,
// so one person cannot suppress a good question or poison the pool. Never returns
// exact copies to reuse; these only steer fresh generation.
async function mockDraw(req, res, body) {
  const exam = examKey(body.exam), section = sectionKey(body.section);
  if (!exam || !section) return res.status(400).json({ error: "Missing exam/section." });
  // Weighted-random exemplars (Efraimidis-Spirakis): questions that recurred
  // across many users' generations (higher `uses`) surface more often as the
  // canonical style, while newer ones still get a fair chance, so the crowd's
  // most-proven questions steer generation without the pool going stale.
  const good = await sql`SELECT data FROM mock_bank WHERE exam = ${exam} AND section = ${section} AND flags = 0 ORDER BY power(random(), 1.0 / (uses + 1)) DESC LIMIT 3`;
  const bad = await sql`SELECT data->>'question' AS q FROM mock_bank WHERE exam = ${exam} AND section = ${section} AND flags >= ${MOCK_FLAG_AVOID} ORDER BY flags DESC, created_at DESC LIMIT 4`;
  return res.status(200).json({
    exemplars: good.map((r) => r.data).filter(Boolean),
    avoid: bad.map((r) => r.q).filter(Boolean),
  });
}

// ── Endless Arena (server) ──────────────────────────────────────────────────
// Scoring/difficulty helpers MIRROR src/lib/arena.js; inlined so the serverless
// bundle needs no cross-directory import. Keep the two in sync.
const ARENA_GATE = 100, ADIFF_MIN = 1, ADIFF_MAX = 5, ACLOSE_BONUS = 2.0;
const aclamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const aCombo = (s) => aclamp(1 + Math.floor(Math.max(0, s) / 3) * 0.5, 1, 5);
const aBasePts = (d) => Math.round(20 * aclamp(d, ADIFF_MIN, ADIFF_MAX));
const aServeDiff = (base, close) => aclamp((Number(base) || 1) + aclamp(Number(close) || 0, 0, 1) * ACLOSE_BONUS, ADIFF_MIN, ADIFF_MAX);
const aMaxQPts = (base, streak) => Math.round(aBasePts(aServeDiff(base, 1)) * aCombo(streak));
function aDifficulty(base, plays, cc) {
  const b = aclamp(Number(base) || 1, ADIFF_MIN, ADIFF_MAX);
  const p = Number(plays) || 0;
  if (p < 8) return b;
  const rate = aclamp((Number(cc) || 0) / p, 0, 1);
  const observed = aclamp(ADIFF_MAX - rate * (ADIFF_MAX - ADIFF_MIN), ADIFF_MIN, ADIFF_MAX);
  const w = Math.min(1, p / 60);
  return aclamp(b * (1 - w) + observed * w, ADIFF_MIN, ADIFF_MAX);
}

// Lazy self-heal of the public-username column + case-insensitive unique index.
let unameReady = false;
async function ensureUsernameCol() {
  if (unameReady) return;
  try {
    await sql`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS username TEXT`;
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS profiles_username_lower ON profiles (lower(username)) WHERE username IS NOT NULL`;
    unameReady = true;
  } catch (e) { console.error("[arena] username col:", e.message); }
}

// Draw a batch of pool questions near a target difficulty. Returns the correct
// answer + full distractor pool + CROWD-CALIBRATED difficulty; the client
// assembles each serve (3 random relevant distractors) and shows instant verdict.
async function arenaDraw(req, res, body) {
  void body;
  // A random spread across difficulties; the client sorts ascending so the run
  // ramps easy -> hard.
  const rows = await sql`
    SELECT id, category, question, correct, distractors, difficulty, plays, correct_count
    FROM gk_pool ORDER BY random() LIMIT 60`;
  return res.status(200).json({ questions: rows.map((r) => ({
    id: String(r.id), category: r.category, question: r.question, correct: r.correct,
    distractors: Array.isArray(r.distractors) ? r.distractors : [],
    difficulty: Math.round(aDifficulty(r.difficulty, r.plays, r.correct_count) * 100) / 100,
  })) });
}

// A finished run: recompute an authoritative score (each submitted per-question
// pts is clamped to what that question could legitimately earn), calibrate the
// pool's difficulty from the answers, and keep only the player's public BEST.
async function arenaSubmit(req, res, body, userId) {
  const answers = Array.isArray(body.answers) ? body.answers.slice(0, 600) : [];
  const questions = Math.max(0, Math.min(parseInt(body.questions, 10) || answers.length, 100000));
  const freeze = aclamp(parseInt(body.freeze, 10) || 0, 0, 999);
  const hint = aclamp(parseInt(body.hint, 10) || 0, 0, 999);
  const skip = aclamp(parseInt(body.skip, 10) || 0, 0, 999);
  const ids = answers.map((a) => parseInt(a.id, 10)).filter(Number.isInteger);
  const diffs = new Map();
  if (ids.length) {
    const drows = await sql`SELECT id, difficulty, plays, correct_count FROM gk_pool WHERE id = ANY(${ids}::bigint[])`;
    for (const r of drows) diffs.set(Number(r.id), aDifficulty(r.difficulty, r.plays, r.correct_count));
  }
  let score = 0, streak = 0;
  const statIds = [], oks = [];
  for (const a of answers) {
    const id = parseInt(a.id, 10);
    if (!Number.isInteger(id)) continue;
    const base = diffs.has(id) ? diffs.get(id) : 2.5;
    const ok = a.ok === true || a.ok === 1;
    statIds.push(id); oks.push(ok ? 1 : 0);
    if (ok) { score += aclamp(parseInt(a.pts, 10) || 0, 0, aMaxQPts(base, streak)); streak += 1; }
    else streak = 0;
  }
  if (statIds.length) {
    try {
      await sql`UPDATE gk_pool g SET plays = plays + 1, correct_count = correct_count + c.ok
                FROM (SELECT unnest(${statIds}::bigint[]) AS id, unnest(${oks}::int[]) AS ok) c
                WHERE g.id = c.id`;
    } catch (e) { console.error("[arena] stat update:", e.message); }
  }
  const prev = (await sql`SELECT best_score FROM arena_score WHERE clerk_user_id = ${userId}`)[0]?.best_score || 0;
  const isBest = score > prev;
  if (isBest) {
    await sql`INSERT INTO arena_score (clerk_user_id, best_score, questions, freeze_used, hint_used, skip_used, updated_at)
              VALUES (${userId}, ${score}, ${questions}, ${freeze}, ${hint}, ${skip}, NOW())
              ON CONFLICT (clerk_user_id) DO UPDATE SET best_score = EXCLUDED.best_score, questions = EXCLUDED.questions,
                freeze_used = EXCLUDED.freeze_used, hint_used = EXCLUDED.hint_used, skip_used = EXCLUDED.skip_used, updated_at = NOW()`;
  } else {
    await sql`INSERT INTO arena_score (clerk_user_id, best_score, questions) VALUES (${userId}, ${score}, ${questions})
              ON CONFLICT (clerk_user_id) DO NOTHING`;
  }
  return res.status(200).json({ ok: true, score, best: Math.max(prev, score), isBest });
}

// Leaderboard, hidden until GATE distinct players have a score.
async function arenaBoard(req, res, userId) {
  await ensureUsernameCol();
  const players = (await sql`SELECT COUNT(*)::int AS n FROM arena_score`)[0]?.n || 0;
  const mine = (await sql`SELECT best_score, questions, freeze_used, hint_used, skip_used FROM arena_score WHERE clerk_user_id = ${userId}`)[0] || null;
  const unlocked = players >= ARENA_GATE;
  const rank = mine && unlocked ? ((await sql`SELECT COUNT(*)::int AS n FROM arena_score WHERE best_score > ${mine.best_score}`)[0]?.n || 0) + 1 : null;
  const you = mine ? { rank, score: mine.best_score, questions: mine.questions, freeze: mine.freeze_used, hint: mine.hint_used, skip: mine.skip_used } : null;
  if (!unlocked) return res.status(200).json({ locked: true, players, need: ARENA_GATE, you });
  const top = await sql`
    SELECT a.best_score, a.questions, a.freeze_used, a.hint_used, a.skip_used, p.username
    FROM arena_score a LEFT JOIN profiles p ON p.clerk_user_id = a.clerk_user_id
    ORDER BY a.best_score DESC, a.updated_at ASC LIMIT 100`;
  return res.status(200).json({
    locked: false, players, you,
    top: top.map((r) => ({ name: r.username || "player", score: r.best_score, questions: r.questions, freeze: r.freeze_used, hint: r.hint_used, skip: r.skip_used })),
  });
}

export default async function handler(req, res) {
  try {
    await ensureTables();

    // Public share paths (no account required).
    if (req.method === "GET" && req.query?.shared) {
      return getSharedQuiz(req, res, clean(req.query.shared, 20));
    }

    if (req.method === "POST") {
      const body = await readBody(req);
      if (body?.action === "shareScore") return recordShareScore(req, res, body);

      // Everything else on POST requires a signed-in user.
      const userId = await userFromToken(req);
      if (!userId) return res.status(401).json({ error: "Invalid session." });

      if (body?.action === "createShare") return createShare(req, res, body, userId);
      if (body?.action === "myChallenges") return myChallenges(req, res, userId);
      if (body?.action === "mockContribute") return mockContribute(req, res, body, userId);
      if (body?.action === "mockFlag") return mockFlag(req, res, body, userId);
      if (body?.action === "mockDraw") return mockDraw(req, res, body);
      if (body?.action === "arenaDraw") return arenaDraw(req, res, body);
      if (body?.action === "arenaSubmit") return arenaSubmit(req, res, body, userId);
      if (body?.action === "arenaBoard") return arenaBoard(req, res, userId);

      // Default: save the user's study blob.
      const data = body?.data;
      if (data == null || typeof data !== "object" || Array.isArray(data)) {
        return res.status(400).json({ error: "Missing or invalid data." });
      }
      await sql`
        INSERT INTO study_data (clerk_user_id, data, updated_at)
        VALUES (${userId}, ${JSON.stringify(data)}::jsonb, NOW())
        ON CONFLICT (clerk_user_id) DO UPDATE
          SET data = EXCLUDED.data, updated_at = NOW()`;
      return res.status(200).json({ ok: true });
    }

    if (req.method === "GET") {
      const userId = await userFromToken(req);
      if (!userId) return res.status(401).json({ error: "Invalid session." });
      const rows = await sql`SELECT data FROM study_data WHERE clerk_user_id = ${userId} LIMIT 1`;
      return res.status(200).json({ data: rows[0]?.data || {} });
    }

    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("[study]", e.message);
    return res.status(500).json({ error: e.message });
  }
}
