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
      // ── Friends + study groups ──
      // One row per relationship: a directed request that becomes mutual once
      // accepted. Friends of X = rows where X is requester or addressee and
      // status='accepted'.
      sql`CREATE TABLE IF NOT EXISTS friendships (
        id         BIGSERIAL   PRIMARY KEY,
        requester  TEXT        NOT NULL,
        addressee  TEXT        NOT NULL,
        status     TEXT        NOT NULL DEFAULT 'pending',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (requester, addressee)
      )`,
      sql`CREATE TABLE IF NOT EXISTS study_groups (
        id          BIGSERIAL   PRIMARY KEY,
        name        TEXT        NOT NULL,
        owner       TEXT        NOT NULL,
        invite_code TEXT        UNIQUE NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
      sql`CREATE TABLE IF NOT EXISTS group_members (
        group_id      BIGINT      NOT NULL,
        clerk_user_id TEXT        NOT NULL,
        role          TEXT        NOT NULL DEFAULT 'member',
        joined_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (group_id, clerk_user_id)
      )`,
      // Pooled study material summaries shared to a group; any member can
      // generate a quiz from them (mirrors the personal study library).
      sql`CREATE TABLE IF NOT EXISTS group_library (
        id            BIGSERIAL   PRIMARY KEY,
        group_id      BIGINT      NOT NULL,
        clerk_user_id TEXT        NOT NULL,
        title         TEXT        NOT NULL,
        subject       TEXT,
        summary       TEXT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
      // Recent group activity feed (joined / shared / quiz / mock).
      sql`CREATE TABLE IF NOT EXISTS group_activity (
        id            BIGSERIAL   PRIMARY KEY,
        group_id      BIGINT      NOT NULL,
        clerk_user_id TEXT        NOT NULL,
        kind          TEXT        NOT NULL,
        detail        TEXT,
        at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
      // Group chat: members discuss their material.
      sql`CREATE TABLE IF NOT EXISTS group_messages (
        id            BIGSERIAL   PRIMARY KEY,
        group_id      BIGINT      NOT NULL,
        clerk_user_id TEXT        NOT NULL,
        text          TEXT        NOT NULL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
      // Collective rewards: when the group levels up its shared goal, every member
      // gets a claimable reward (added to their personal power-up wallet). One row
      // per (group, member, level) so a level is only ever rewarded once each.
      sql`CREATE TABLE IF NOT EXISTS group_reward (
        group_id      BIGINT      NOT NULL,
        clerk_user_id TEXT        NOT NULL,
        level         INT         NOT NULL,
        reward        JSONB       NOT NULL,
        claimed       BOOLEAN     NOT NULL DEFAULT FALSE,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (group_id, clerk_user_id, level)
      )`,
      // Head-to-head challenges: members answer the SAME fixed question set, then
      // scores are ranked (solo/1v1/free-for-all) or summed by team (teams).
      sql`CREATE TABLE IF NOT EXISTS group_challenges (
        id         BIGSERIAL   PRIMARY KEY,
        group_id   BIGINT      NOT NULL,
        created_by TEXT        NOT NULL,
        title      TEXT        NOT NULL,
        mode       TEXT        NOT NULL DEFAULT 'solo',
        questions  JSONB       NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
      sql`CREATE TABLE IF NOT EXISTS challenge_scores (
        challenge_id  BIGINT      NOT NULL,
        clerk_user_id TEXT        NOT NULL,
        team          TEXT,
        score         INT         NOT NULL DEFAULT 0,
        total         INT         NOT NULL DEFAULT 0,
        played_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (challenge_id, clerk_user_id)
      )`,
    ]).then(() => sql`ALTER TABLE study_groups ADD COLUMN IF NOT EXISTS points INT NOT NULL DEFAULT 0`)
      .then(() => sql`ALTER TABLE study_groups ADD COLUMN IF NOT EXISTS level INT NOT NULL DEFAULT 1`)
      .then(() => sql`CREATE INDEX IF NOT EXISTS mock_bank_bucket ON mock_bank (exam, section)`)
      .then(() => sql`CREATE INDEX IF NOT EXISTS arena_board ON arena_score (best_score DESC)`)
      .then(() => sql`CREATE INDEX IF NOT EXISTS gk_pool_diff ON gk_pool (difficulty)`)
      .then(() => sql`CREATE INDEX IF NOT EXISTS friendships_addr ON friendships (addressee, status)`)
      .then(() => sql`CREATE INDEX IF NOT EXISTS friendships_req ON friendships (requester, status)`)
      .then(() => sql`CREATE INDEX IF NOT EXISTS group_members_user ON group_members (clerk_user_id)`)
      .then(() => sql`CREATE INDEX IF NOT EXISTS group_library_grp ON group_library (group_id, created_at DESC)`)
      .then(() => sql`CREATE INDEX IF NOT EXISTS group_activity_grp ON group_activity (group_id, at DESC)`)
      .then(() => sql`CREATE INDEX IF NOT EXISTS group_messages_grp ON group_messages (group_id, id DESC)`)
      .then(() => sql`CREATE INDEX IF NOT EXISTS group_challenges_grp ON group_challenges (group_id, id DESC)`)
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

// ── Friends + study groups ───────────────────────────────────────────────
const GROUP_GOAL_BASE = 300;                        // points per group level (cumulative)
const GROUP_LEVEL_REWARD = { hint: 2, freeze: 1 };  // every member earns this each level-up
// Map a set of clerk user ids to their public usernames (one query).
async function usernamesFor(ids) {
  if (!ids.length) return {};
  const rows = await sql`SELECT COALESCE(clerk_user_id, id) AS uid, username FROM profiles
                         WHERE clerk_user_id = ANY(${ids}::text[]) OR id = ANY(${ids}::text[])`;
  const out = {};
  for (const r of rows) if (r.uid) out[r.uid] = r.username || null;
  return out;
}

async function friendAdd(req, res, body, me) {
  const name = clean(body.username, 30);
  if (!name) return res.status(400).json({ error: "Enter a username." });
  const found = (await sql`SELECT COALESCE(clerk_user_id, id) AS uid FROM profiles WHERE lower(username) = lower(${name}) LIMIT 1`)[0];
  const them = found?.uid;
  if (!them) return res.status(404).json({ error: "No one goes by that username." });
  if (them === me) return res.status(400).json({ error: "That's you." });
  const e = (await sql`SELECT id, requester, status FROM friendships
    WHERE (requester=${me} AND addressee=${them}) OR (requester=${them} AND addressee=${me}) LIMIT 1`)[0];
  if (e) {
    if (e.status === "accepted") return res.status(200).json({ ok: true, status: "accepted" });
    if (e.requester === them) { await sql`UPDATE friendships SET status='accepted' WHERE id=${e.id}`; return res.status(200).json({ ok: true, status: "accepted" }); }
    return res.status(200).json({ ok: true, status: "pending" });
  }
  await sql`INSERT INTO friendships (requester, addressee, status) VALUES (${me}, ${them}, 'pending') ON CONFLICT (requester, addressee) DO NOTHING`;
  return res.status(200).json({ ok: true, status: "pending" });
}

async function friendRespond(req, res, body, me) {
  const id = parseInt(body.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Bad request." });
  const f = (await sql`SELECT id, addressee, status FROM friendships WHERE id=${id} LIMIT 1`)[0];
  if (!f || f.addressee !== me) return res.status(404).json({ error: "Request not found." });
  if (body.accept) await sql`UPDATE friendships SET status='accepted' WHERE id=${id}`;
  else await sql`DELETE FROM friendships WHERE id=${id}`;
  return res.status(200).json({ ok: true });
}

async function friendRemove(req, res, body, me) {
  const them = clean(body.userId, 60);
  if (!them) return res.status(400).json({ error: "Bad request." });
  await sql`DELETE FROM friendships WHERE (requester=${me} AND addressee=${them}) OR (requester=${them} AND addressee=${me})`;
  return res.status(200).json({ ok: true });
}

// One read for the whole social screen: friends, requests, and the user's groups.
async function socialOverview(req, res, me) {
  const fr = await sql`SELECT id, requester, addressee, status FROM friendships WHERE requester=${me} OR addressee=${me}`;
  const grpRows = await sql`SELECT g.id, g.name, g.owner, g.invite_code,
      (SELECT COUNT(*) FROM group_members m2 WHERE m2.group_id=g.id) AS members
    FROM study_groups g JOIN group_members m ON m.group_id=g.id AND m.clerk_user_id=${me}
    ORDER BY g.created_at DESC`;
  const uids = new Set();
  for (const r of fr) { uids.add(r.requester); uids.add(r.addressee); }
  const names = await usernamesFor([...uids]);
  const nameOf = (u) => names[u] || "student";
  const friends = [], incoming = [], outgoing = [];
  for (const r of fr) {
    if (r.status === "accepted") { const o = r.requester === me ? r.addressee : r.requester; friends.push({ userId: o, username: nameOf(o) }); }
    else if (r.addressee === me) incoming.push({ id: Number(r.id), userId: r.requester, username: nameOf(r.requester) });
    else outgoing.push({ id: Number(r.id), userId: r.addressee, username: nameOf(r.addressee) });
  }
  friends.sort((a, b) => a.username.localeCompare(b.username));
  const groups = grpRows.map((g) => ({ id: Number(g.id), name: g.name, members: Number(g.members), isOwner: g.owner === me }));
  return res.status(200).json({ friends, incoming, outgoing, groups });
}

async function groupCreate(req, res, body, me) {
  const name = clean(body.name, 40);
  if (!name) return res.status(400).json({ error: "Give your group a name." });
  const n = Number((await sql`SELECT COUNT(*) AS n FROM group_members WHERE clerk_user_id=${me}`)[0]?.n || 0);
  if (n >= 25) return res.status(400).json({ error: "You're in too many groups already." });
  const code = shortId();
  const g = (await sql`INSERT INTO study_groups (name, owner, invite_code) VALUES (${name}, ${me}, ${code}) RETURNING id`)[0];
  await sql`INSERT INTO group_members (group_id, clerk_user_id, role) VALUES (${g.id}, ${me}, 'owner')`;
  await sql`INSERT INTO group_activity (group_id, clerk_user_id, kind, detail) VALUES (${g.id}, ${me}, 'created', ${name})`;
  return res.status(200).json({ ok: true, id: Number(g.id), code });
}

async function groupJoin(req, res, body, me) {
  const code = clean(body.code, 20);
  const g = (await sql`SELECT id FROM study_groups WHERE invite_code=${code} LIMIT 1`)[0];
  if (!g) return res.status(404).json({ error: "That invite code is not valid." });
  const members = Number((await sql`SELECT COUNT(*) AS n FROM group_members WHERE group_id=${g.id}`)[0]?.n || 0);
  if (members >= 50) return res.status(400).json({ error: "This group is full." });
  const ins = await sql`INSERT INTO group_members (group_id, clerk_user_id) VALUES (${g.id}, ${me}) ON CONFLICT DO NOTHING RETURNING group_id`;
  if (ins.length) await sql`INSERT INTO group_activity (group_id, clerk_user_id, kind) VALUES (${g.id}, ${me}, 'joined')`;
  return res.status(200).json({ ok: true, id: Number(g.id) });
}

async function groupInvite(req, res, body, me) {
  const gid = parseInt(body.groupId, 10);
  const them = clean(body.userId, 60);
  if (!Number.isInteger(gid) || !them) return res.status(400).json({ error: "Bad request." });
  if (!(await sql`SELECT 1 FROM group_members WHERE group_id=${gid} AND clerk_user_id=${me} LIMIT 1`).length)
    return res.status(403).json({ error: "You're not in this group." });
  if (!(await sql`SELECT 1 FROM friendships WHERE status='accepted' AND ((requester=${me} AND addressee=${them}) OR (requester=${them} AND addressee=${me})) LIMIT 1`).length)
    return res.status(400).json({ error: "You can only add your friends." });
  const members = Number((await sql`SELECT COUNT(*) AS n FROM group_members WHERE group_id=${gid}`)[0]?.n || 0);
  if (members >= 50) return res.status(400).json({ error: "This group is full." });
  const ins = await sql`INSERT INTO group_members (group_id, clerk_user_id) VALUES (${gid}, ${them}) ON CONFLICT DO NOTHING RETURNING group_id`;
  if (ins.length) await sql`INSERT INTO group_activity (group_id, clerk_user_id, kind) VALUES (${gid}, ${them}, 'joined')`;
  return res.status(200).json({ ok: true });
}

async function groupLeave(req, res, body, me) {
  const gid = parseInt(body.groupId, 10);
  if (!Number.isInteger(gid)) return res.status(400).json({ error: "Bad request." });
  const g = (await sql`SELECT owner FROM study_groups WHERE id=${gid} LIMIT 1`)[0];
  if (!g) return res.status(404).json({ error: "Group not found." });
  await sql`DELETE FROM group_members WHERE group_id=${gid} AND clerk_user_id=${me}`;
  const remaining = await sql`SELECT clerk_user_id FROM group_members WHERE group_id=${gid} ORDER BY joined_at ASC`;
  if (!remaining.length) {
    await sql`DELETE FROM study_groups WHERE id=${gid}`;
    await sql`DELETE FROM group_library WHERE group_id=${gid}`;
    await sql`DELETE FROM group_activity WHERE group_id=${gid}`;
  } else if (g.owner === me) {
    const heir = remaining[0].clerk_user_id;
    await sql`UPDATE study_groups SET owner=${heir} WHERE id=${gid}`;
    await sql`UPDATE group_members SET role='owner' WHERE group_id=${gid} AND clerk_user_id=${heir}`;
  }
  return res.status(200).json({ ok: true });
}

async function groupGet(req, res, body, me) {
  const gid = parseInt(body.groupId, 10);
  if (!Number.isInteger(gid)) return res.status(400).json({ error: "Bad request." });
  const g = (await sql`SELECT id, name, owner, invite_code, points, level FROM study_groups WHERE id=${gid} LIMIT 1`)[0];
  if (!g) return res.status(404).json({ error: "Group not found." });
  const mem = await sql`SELECT clerk_user_id, role FROM group_members WHERE group_id=${gid}`;
  if (!mem.some((m) => m.clerk_user_id === me)) return res.status(403).json({ error: "You're not in this group." });
  const ids = mem.map((m) => m.clerk_user_id);
  const names = await usernamesFor(ids);
  const statRows = await sql`SELECT clerk_user_id, data->'stats' AS stats FROM study_data WHERE clerk_user_id = ANY(${ids}::text[])`;
  const statMap = Object.fromEntries(statRows.map((r) => [r.clerk_user_id, r.stats || {}]));
  const members = mem.map((m) => {
    const s = statMap[m.clerk_user_id] || {};
    const answered = Number(s.answered) || 0, correct = Number(s.correct) || 0;
    return { userId: m.clerk_user_id, username: names[m.clerk_user_id] || "student", role: m.role,
      streak: Number(s.streak) || 0, answered, accuracy: answered ? Math.round((correct / answered) * 100) : 0, you: m.clerk_user_id === me };
  }).sort((a, b) => b.streak - a.streak || b.answered - a.answered);
  const library = (await sql`SELECT id, clerk_user_id, title, subject FROM group_library WHERE group_id=${gid} ORDER BY created_at DESC LIMIT 60`)
    .map((d) => ({ id: Number(d.id), by: names[d.clerk_user_id] || "student", title: d.title, subject: d.subject }));
  const activity = (await sql`SELECT clerk_user_id, kind, detail, at FROM group_activity WHERE group_id=${gid} ORDER BY at DESC LIMIT 30`)
    .map((a) => ({ by: names[a.clerk_user_id] || "student", kind: a.kind, detail: a.detail, at: a.at }));
  // Shared goal progress + this member's unclaimed collective reward.
  const level = Number(g.level) || 1, points = Number(g.points) || 0;
  const unc = await sql`SELECT reward FROM group_reward WHERE group_id=${gid} AND clerk_user_id=${me} AND claimed=false`;
  let reward = null;
  if (unc.length) { reward = { hint: 0, freeze: 0, skip: 0 }; for (const r of unc) { const rw = r.reward || {}; reward.hint += Number(rw.hint) || 0; reward.freeze += Number(rw.freeze) || 0; reward.skip += Number(rw.skip) || 0; } }
  return res.status(200).json({
    id: Number(g.id), name: g.name, code: g.invite_code, isOwner: g.owner === me, members, library, activity,
    level, points, goal: level * GROUP_GOAL_BASE, prevGoal: (level - 1) * GROUP_GOAL_BASE, reward,
  });
}

async function groupShare(req, res, body, me) {
  const gid = parseInt(body.groupId, 10);
  const title = clean(body.title, 120), subject = clean(body.subject, 80), summary = clean(body.summary, 8000);
  if (!Number.isInteger(gid) || !title) return res.status(400).json({ error: "Bad request." });
  if (!(await sql`SELECT 1 FROM group_members WHERE group_id=${gid} AND clerk_user_id=${me} LIMIT 1`).length)
    return res.status(403).json({ error: "You're not in this group." });
  const n = Number((await sql`SELECT COUNT(*) AS n FROM group_library WHERE group_id=${gid}`)[0]?.n || 0);
  if (n >= 200) return res.status(400).json({ error: "The group library is full." });
  await sql`INSERT INTO group_library (group_id, clerk_user_id, title, subject, summary) VALUES (${gid}, ${me}, ${title}, ${subject}, ${summary})`;
  await sql`INSERT INTO group_activity (group_id, clerk_user_id, kind, detail) VALUES (${gid}, ${me}, 'shared', ${title})`;
  return res.status(200).json({ ok: true });
}

// Fetch one shared doc's summary so a member can generate a quiz from it.
async function groupDoc(req, res, body, me) {
  const id = parseInt(body.docId, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Bad request." });
  const d = (await sql`SELECT group_id, title, subject, summary FROM group_library WHERE id=${id} LIMIT 1`)[0];
  if (!d) return res.status(404).json({ error: "Not found." });
  if (!(await sql`SELECT 1 FROM group_members WHERE group_id=${d.group_id} AND clerk_user_id=${me} LIMIT 1`).length)
    return res.status(403).json({ error: "You're not in this group." });
  return res.status(200).json({ title: d.title, subject: d.subject, summary: d.summary });
}

// Append an activity item and, when `points` are supplied (e.g. correct answers on
// group material), add them to the group's shared total; crossing a level threshold
// grants EVERY member a claimable reward.
async function groupLog(req, res, body, me) {
  const gid = parseInt(body.groupId, 10);
  const kind = clean(body.kind, 16), detail = clean(body.detail, 120);
  const pts = Math.max(0, Math.min(100, parseInt(body.points, 10) || 0));
  if (!Number.isInteger(gid) || !kind) return res.status(400).json({ error: "Bad request." });
  if (!(await sql`SELECT 1 FROM group_members WHERE group_id=${gid} AND clerk_user_id=${me} LIMIT 1`).length)
    return res.status(403).json({ error: "You're not in this group." });
  await sql`INSERT INTO group_activity (group_id, clerk_user_id, kind, detail) VALUES (${gid}, ${me}, ${kind}, ${detail})`;
  await sql`DELETE FROM group_activity WHERE group_id=${gid} AND id NOT IN (SELECT id FROM group_activity WHERE group_id=${gid} ORDER BY at DESC LIMIT 100)`;
  let leveledTo = 0;
  if (pts > 0) {
    const row = (await sql`UPDATE study_groups SET points = points + ${pts} WHERE id=${gid} RETURNING points, level`)[0];
    if (row) {
      let level = row.level;
      while (row.points >= level * GROUP_GOAL_BASE) level++;   // may cross several at once
      if (level > row.level) {
        await sql`UPDATE study_groups SET level=${level} WHERE id=${gid}`;
        for (let L = row.level + 1; L <= level; L++) {
          await sql`INSERT INTO group_reward (group_id, clerk_user_id, level, reward)
                    SELECT group_id, clerk_user_id, ${L}, ${JSON.stringify(GROUP_LEVEL_REWARD)}::jsonb
                    FROM group_members WHERE group_id=${gid}
                    ON CONFLICT DO NOTHING`;
        }
        await sql`INSERT INTO group_activity (group_id, clerk_user_id, kind, detail) VALUES (${gid}, ${me}, 'level', ${String(level)})`;
        leveledTo = level;
      }
    }
  }
  return res.status(200).json({ ok: true, leveledTo });
}

// Claim any group-level rewards waiting for this member; returns the summed bundle
// so the client can add it to the personal power-up wallet.
async function groupClaim(req, res, body, me) {
  const gid = parseInt(body.groupId, 10);
  if (!Number.isInteger(gid)) return res.status(400).json({ error: "Bad request." });
  const rows = await sql`SELECT reward FROM group_reward WHERE group_id=${gid} AND clerk_user_id=${me} AND claimed=false`;
  if (!rows.length) return res.status(200).json({ ok: true, reward: null });
  const total = { hint: 0, freeze: 0, skip: 0 };
  for (const r of rows) { const rw = r.reward || {}; total.hint += Number(rw.hint) || 0; total.freeze += Number(rw.freeze) || 0; total.skip += Number(rw.skip) || 0; }
  await sql`UPDATE group_reward SET claimed=true WHERE group_id=${gid} AND clerk_user_id=${me} AND claimed=false`;
  return res.status(200).json({ ok: true, reward: total });
}

// Group chat.
async function groupChatSend(req, res, body, me) {
  const gid = parseInt(body.groupId, 10);
  const text = clean(body.text, 1000);
  if (!Number.isInteger(gid) || !text) return res.status(400).json({ error: "Bad request." });
  if (!(await sql`SELECT 1 FROM group_members WHERE group_id=${gid} AND clerk_user_id=${me} LIMIT 1`).length)
    return res.status(403).json({ error: "You're not in this group." });
  await sql`INSERT INTO group_messages (group_id, clerk_user_id, text) VALUES (${gid}, ${me}, ${text})`;
  await sql`DELETE FROM group_messages WHERE group_id=${gid} AND id NOT IN (SELECT id FROM group_messages WHERE group_id=${gid} ORDER BY id DESC LIMIT 300)`;
  return res.status(200).json({ ok: true });
}
async function groupChat(req, res, body, me) {
  const gid = parseInt(body.groupId, 10);
  if (!Number.isInteger(gid)) return res.status(400).json({ error: "Bad request." });
  if (!(await sql`SELECT 1 FROM group_members WHERE group_id=${gid} AND clerk_user_id=${me} LIMIT 1`).length)
    return res.status(403).json({ error: "You're not in this group." });
  const rows = await sql`SELECT id, clerk_user_id, text, created_at FROM group_messages WHERE group_id=${gid} ORDER BY id DESC LIMIT 60`;
  const names = await usernamesFor([...new Set(rows.map((r) => r.clerk_user_id))]);
  const messages = rows.reverse().map((r) => ({ id: Number(r.id), by: names[r.clerk_user_id] || "student", mine: r.clerk_user_id === me, text: r.text, at: r.created_at }));
  return res.status(200).json({ messages });
}

// ── Head-to-head challenges ──
async function groupHasMember(gid, me) {
  return (await sql`SELECT 1 FROM group_members WHERE group_id=${gid} AND clerk_user_id=${me} LIMIT 1`).length > 0;
}
// The creator generates the fixed question set client-side (so everyone answers the
// SAME questions), then stores it here.
async function challengeCreate(req, res, body, me) {
  const gid = parseInt(body.groupId, 10);
  const title = clean(body.title, 120) || "Challenge";
  const mode = body.mode === "teams" ? "teams" : "solo";
  const qs = Array.isArray(body.questions) ? body.questions.slice(0, 15).map((q) => ({
    question: clean(q.question, 600),
    options: Array.isArray(q.options) ? q.options.slice(0, 6).map((o) => clean(o, 300)) : [],
    correct: Math.max(0, Math.min(5, parseInt(q.correct, 10) || 0)),
    explanation: clean(q.explanation, 600),
  })).filter((q) => q.question && q.options.length >= 2) : [];
  if (!Number.isInteger(gid) || !qs.length) return res.status(400).json({ error: "Bad request." });
  if (!(await groupHasMember(gid, me))) return res.status(403).json({ error: "You're not in this group." });
  const c = (await sql`INSERT INTO group_challenges (group_id, created_by, title, mode, questions) VALUES (${gid}, ${me}, ${title}, ${mode}, ${JSON.stringify(qs)}::jsonb) RETURNING id`)[0];
  await sql`DELETE FROM group_challenges WHERE group_id=${gid} AND id NOT IN (SELECT id FROM group_challenges WHERE group_id=${gid} ORDER BY id DESC LIMIT 30)`;
  await sql`INSERT INTO group_activity (group_id, clerk_user_id, kind, detail) VALUES (${gid}, ${me}, 'challenge', ${title})`;
  return res.status(200).json({ ok: true, id: Number(c.id) });
}
async function challengeList(req, res, body, me) {
  const gid = parseInt(body.groupId, 10);
  if (!Number.isInteger(gid)) return res.status(400).json({ error: "Bad request." });
  if (!(await groupHasMember(gid, me))) return res.status(403).json({ error: "You're not in this group." });
  const rows = await sql`SELECT c.id, c.created_by, c.title, c.mode, c.created_at,
      (SELECT COUNT(*) FROM challenge_scores s WHERE s.challenge_id=c.id) AS players,
      (SELECT score FROM challenge_scores s WHERE s.challenge_id=c.id AND s.clerk_user_id=${me}) AS my_score,
      (SELECT total FROM challenge_scores s WHERE s.challenge_id=c.id AND s.clerk_user_id=${me}) AS my_total
    FROM group_challenges c WHERE c.group_id=${gid} ORDER BY c.id DESC LIMIT 30`;
  const names = await usernamesFor([...new Set(rows.map((r) => r.created_by))]);
  return res.status(200).json({ challenges: rows.map((r) => ({
    id: Number(r.id), title: r.title, mode: r.mode, by: names[r.created_by] || "student",
    players: Number(r.players), myScore: r.my_score == null ? null : Number(r.my_score), myTotal: r.my_total == null ? null : Number(r.my_total),
  })) });
}
async function challengeGet(req, res, body, me) {
  const id = parseInt(body.challengeId, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Bad request." });
  const c = (await sql`SELECT id, group_id, title, mode, questions FROM group_challenges WHERE id=${id} LIMIT 1`)[0];
  if (!c) return res.status(404).json({ error: "Challenge not found." });
  if (!(await groupHasMember(Number(c.group_id), me))) return res.status(403).json({ error: "You're not in this group." });
  const scores = await sql`SELECT clerk_user_id, team, score, total FROM challenge_scores WHERE challenge_id=${id}`;
  const names = await usernamesFor(scores.map((s) => s.clerk_user_id));
  const mine = scores.find((s) => s.clerk_user_id === me) || null;
  const results = scores.map((s) => ({ username: names[s.clerk_user_id] || "student", team: s.team, score: Number(s.score), total: Number(s.total), you: s.clerk_user_id === me }))
    .sort((a, b) => b.score - a.score);
  let teamTotals = null;
  if (c.mode === "teams") {
    teamTotals = { A: { score: 0, members: 0 }, B: { score: 0, members: 0 } };
    for (const s of scores) { const tm = s.team === "A" || s.team === "B" ? s.team : null; if (tm) { teamTotals[tm].score += Number(s.score); teamTotals[tm].members += 1; } }
  }
  return res.status(200).json({
    id: Number(c.id), groupId: Number(c.group_id), title: c.title, mode: c.mode,
    questions: c.questions, played: !!mine, myTeam: mine?.team || null, results, teamTotals,
  });
}
async function challengeSubmit(req, res, body, me) {
  const id = parseInt(body.challengeId, 10);
  const team = body.team === "A" || body.team === "B" ? body.team : null;
  const score = Math.max(0, Math.min(1000, parseInt(body.score, 10) || 0));
  const total = Math.max(0, Math.min(1000, parseInt(body.total, 10) || 0));
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Bad request." });
  const c = (await sql`SELECT group_id, mode FROM group_challenges WHERE id=${id} LIMIT 1`)[0];
  if (!c) return res.status(404).json({ error: "Challenge not found." });
  if (!(await groupHasMember(Number(c.group_id), me))) return res.status(403).json({ error: "You're not in this group." });
  const useTeam = c.mode === "teams" ? team : null;
  await sql`INSERT INTO challenge_scores (challenge_id, clerk_user_id, team, score, total) VALUES (${id}, ${me}, ${useTeam}, ${score}, ${total}) ON CONFLICT DO NOTHING`;
  // Report how the caller placed against everyone who has played so far, so the
  // client can update the player's win/loss record (which feeds their adaptive
  // difficulty). Ranking is by individual score even in team mode, that's the
  // personal-strength signal. Pending until at least one rival has played.
  const rows = await sql`SELECT clerk_user_id, score FROM challenge_scores WHERE challenge_id=${id}`;
  const mine = rows.find((r) => r.clerk_user_id === me);
  const myScore = mine ? Number(mine.score) : score;
  const others = rows.filter((r) => r.clerk_user_id !== me);
  const beat = others.filter((r) => Number(r.score) < myScore).length;
  const rank = others.filter((r) => Number(r.score) > myScore).length + 1;
  const pending = others.length === 0;
  const won = !pending && beat >= Math.ceil(others.length / 2);
  return res.status(200).json({ ok: true, pending, won, rank, players: rows.length, beat });
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
      // Friends + study groups
      if (body?.action === "social") return socialOverview(req, res, userId);
      if (body?.action === "friendAdd") return friendAdd(req, res, body, userId);
      if (body?.action === "friendRespond") return friendRespond(req, res, body, userId);
      if (body?.action === "friendRemove") return friendRemove(req, res, body, userId);
      if (body?.action === "groupCreate") return groupCreate(req, res, body, userId);
      if (body?.action === "groupJoin") return groupJoin(req, res, body, userId);
      if (body?.action === "groupInvite") return groupInvite(req, res, body, userId);
      if (body?.action === "groupLeave") return groupLeave(req, res, body, userId);
      if (body?.action === "groupGet") return groupGet(req, res, body, userId);
      if (body?.action === "groupShare") return groupShare(req, res, body, userId);
      if (body?.action === "groupDoc") return groupDoc(req, res, body, userId);
      if (body?.action === "groupLog") return groupLog(req, res, body, userId);
      if (body?.action === "groupClaim") return groupClaim(req, res, body, userId);
      if (body?.action === "groupChat") return groupChat(req, res, body, userId);
      if (body?.action === "groupChatSend") return groupChatSend(req, res, body, userId);
      if (body?.action === "challengeCreate") return challengeCreate(req, res, body, userId);
      if (body?.action === "challengeList") return challengeList(req, res, body, userId);
      if (body?.action === "challengeGet") return challengeGet(req, res, body, userId);
      if (body?.action === "challengeSubmit") return challengeSubmit(req, res, body, userId);

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
