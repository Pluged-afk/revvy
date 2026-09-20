import { verifyToken } from "@clerk/backend";
import { randomBytes } from "crypto";
import webpush from "web-push";
import sql, { readBody } from "./db.js";

// Server-synced study data + shared-quiz storage. All one serverless function
// to stay under the Vercel Hobby plan's 12-function limit.
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
      // Global, cross-user mock-exam learning bank. Mock questions come from the
      // model's general knowledge of standardized tests (SAT/ACT/etc.), not from
      // anyone's private material, so pooling them is safe. We keep what the crowd
      // generates plus a flag count, then feed the good ones back as style
      // exemplars and the flagged ones as an avoid-list, so mocks get more
      // authentic over time. We never serve exact copies; generation stays fresh.
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
      // Opt-in community Arena pool: vetted, self-contained MCQs contributed from
      // learners' own quizzes, shared to everyone's Arena (served in a later pass).
      sql`CREATE TABLE IF NOT EXISTS arena_contrib (
        id            BIGSERIAL   PRIMARY KEY,
        qhash         TEXT        UNIQUE NOT NULL,
        category      TEXT        NOT NULL DEFAULT 'general',
        question      TEXT        NOT NULL,
        correct       TEXT        NOT NULL,
        distractors   JSONB       NOT NULL,
        difficulty    REAL        NOT NULL DEFAULT 2.5,
        uses          INT         NOT NULL DEFAULT 1,
        flags         INT         NOT NULL DEFAULT 0,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
      // Per-account daily contribution counter, so no one account can flood the pool.
      sql`CREATE TABLE IF NOT EXISTS arena_contrib_actor (
        clerk_user_id TEXT NOT NULL,
        day           DATE NOT NULL DEFAULT CURRENT_DATE,
        contribs      INT  NOT NULL DEFAULT 0,
        PRIMARY KEY (clerk_user_id, day)
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
      // Competitive Arena seasons: each month is a fresh ladder. We keep each
      // player's best run score for the season; the client maps it to a tier
      // (Bronze..Diamond) and a season leaderboard is ranked from it.
      sql`CREATE TABLE IF NOT EXISTS arena_season (
        season        TEXT        NOT NULL,
        clerk_user_id TEXT        NOT NULL,
        best_score    INT         NOT NULL DEFAULT 0,
        questions     INT         NOT NULL DEFAULT 0,
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (season, clerk_user_id)
      )`,
      // Weekly Leagues: small winnable cohorts. Each ISO week, a player sits in
      // one cohort (~30 peers) at a tier; league points accumulate from arena
      // runs that week; at the next week's first visit they promote/demote by
      // where they finished (lazy rollover, no cron needed).
      sql`CREATE TABLE IF NOT EXISTS arena_league (
        week          TEXT        NOT NULL,
        clerk_user_id TEXT        NOT NULL,
        cohort        INT         NOT NULL DEFAULT 0,
        tier          INT         NOT NULL DEFAULT 0,
        points        INT         NOT NULL DEFAULT 0,
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (week, clerk_user_id)
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
      // 1:1 friend direct messages. `kind` carries text OR a shared payload:
      // 'text' | 'material' (a study set to quiz on) | 'score' (a result/brag
      // card) | 'challenge' (a fixed quiz set the friend plays). `data` is JSONB.
      sql`CREATE TABLE IF NOT EXISTS friend_messages (
        id         BIGSERIAL   PRIMARY KEY,
        sender     TEXT        NOT NULL,
        recipient  TEXT        NOT NULL,
        kind       TEXT        NOT NULL DEFAULT 'text',
        body       TEXT        NOT NULL DEFAULT '',
        data       JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
      // 1:1 friend challenges: each of the two friends plays the challenge
      // (a 'challenge' friend_messages row) once — play-once via the PK +
      // ON CONFLICT DO NOTHING — so their scores can be compared and a winner
      // declared once both are in. challenge_id = the friend_messages.id.
      sql`CREATE TABLE IF NOT EXISTS friend_challenge_scores (
        challenge_id  BIGINT      NOT NULL,
        clerk_user_id TEXT        NOT NULL,
        score         INT         NOT NULL DEFAULT 0,
        total         INT         NOT NULL DEFAULT 0,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (challenge_id, clerk_user_id)
      )`,
      // Web Push subscriptions for closed-app study reminders. One row per browser
      // endpoint; last_notified dedups the daily cron to once per UTC day.
      sql`CREATE TABLE IF NOT EXISTS push_subs (
        endpoint      TEXT PRIMARY KEY,
        clerk_user_id TEXT        NOT NULL,
        p256dh        TEXT        NOT NULL,
        auth          TEXT        NOT NULL,
        last_notified DATE,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
    ]).then(() => sql`ALTER TABLE study_groups ADD COLUMN IF NOT EXISTS points INT NOT NULL DEFAULT 0`)
      .then(() => sql`ALTER TABLE study_groups ADD COLUMN IF NOT EXISTS level INT NOT NULL DEFAULT 1`)
      .then(() => sql`CREATE INDEX IF NOT EXISTS mock_bank_bucket ON mock_bank (exam, section)`)
      .then(() => sql`CREATE INDEX IF NOT EXISTS arena_board ON arena_score (best_score DESC)`)
      .then(() => sql`CREATE INDEX IF NOT EXISTS arena_season_board ON arena_season (season, best_score DESC)`)
      .then(() => sql`CREATE INDEX IF NOT EXISTS arena_league_board ON arena_league (week, cohort, points DESC)`)
      .then(() => sql`CREATE INDEX IF NOT EXISTS arena_league_tier ON arena_league (week, tier, cohort)`)
      .then(() => sql`CREATE INDEX IF NOT EXISTS friend_msg_thread ON friend_messages (sender, recipient, id)`)
      .then(() => sql`CREATE INDEX IF NOT EXISTS friend_msg_inbox ON friend_messages (recipient, sender)`)
      .then(() => sql`CREATE INDEX IF NOT EXISTS gk_pool_diff ON gk_pool (difficulty)`)
      .then(() => sql`ALTER TABLE arena_contrib ADD COLUMN IF NOT EXISTS concept TEXT`)
      .then(() => sql`ALTER TABLE arena_contrib ADD COLUMN IF NOT EXISTS plays INT NOT NULL DEFAULT 0`)
      .then(() => sql`ALTER TABLE arena_contrib ADD COLUMN IF NOT EXISTS correct_count INT NOT NULL DEFAULT 0`)
      .then(() => sql`CREATE INDEX IF NOT EXISTS arena_contrib_diff ON arena_contrib (difficulty)`)
      .then(() => sql`CREATE INDEX IF NOT EXISTS arena_contrib_concept ON arena_contrib (concept)`)
      .then(() => sql`CREATE INDEX IF NOT EXISTS friendships_addr ON friendships (addressee, status)`)
      .then(() => sql`CREATE INDEX IF NOT EXISTS friendships_req ON friendships (requester, status)`)
      .then(() => sql`CREATE INDEX IF NOT EXISTS group_members_user ON group_members (clerk_user_id)`)
      .then(() => sql`CREATE INDEX IF NOT EXISTS group_library_grp ON group_library (group_id, created_at DESC)`)
      .then(() => sql`CREATE INDEX IF NOT EXISTS group_activity_grp ON group_activity (group_id, at DESC)`)
      .then(() => sql`CREATE INDEX IF NOT EXISTS group_messages_grp ON group_messages (group_id, id DESC)`)
      .then(() => sql`CREATE INDEX IF NOT EXISTS group_challenges_grp ON group_challenges (group_id, id DESC)`)
      .then(() => sql`CREATE INDEX IF NOT EXISTS push_subs_user ON push_subs (clerk_user_id)`)
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

// ── Community Arena pool (opt-in) ────────────────────────────────────────
// Learners can opt in to share the good MCQs from their own quizzes to a public
// Arena pool that anyone can play. Everything here is the QUALITY GATE, in layers:
// cheap deterministic checks (well-formed, self-contained, English-only,
// non-abusive), near-duplicate collapse (same idea/answer), then an AI gate that
// keeps only genuinely good, factually-sound, general-interest questions ("pick
// the good ones, not anything").
const ARENA_CONTRIB_DAILY = 120;    // items one account may push through the gate per day
const ARENA_CONTRIB_PER_CALL = 30;  // items accepted from a single call
const ARENA_POOL_CAP = 20000;       // total contributed questions kept
const ARENA_DIFF = [2, 3, 4];       // quiz easy/normal/hard -> arena 1..5 difficulty
// Arena questions are played with NO context, so they must stand alone. Reject
// anything that leans on the learner's own material (a passage, figure, diagram,
// "the author", "underlined", etc.), which would be meaningless to other players.
const SELF_REF_RE = /\b(according to|based on|as (shown|described|stated|mentioned|seen)|refer(ring)? to)\b|\b(the|this|your|above|following|given) (passage|text|material|article|document|excerpt|reading|notes?|paragraph|diagram|image|figure|table|chart|graph|photo|picture|author|video|lecture|transcript|slide)\b|\bunderlined\b|\bhighlighted\b|\bthe marked\b|\bin the (image|figure|diagram|picture|photo|passage|text)\b/i;
// The Arena is English-only. Substantial non-Latin script (Arabic, CJK, Cyrillic,
// Hebrew, Devanagari, Greek, etc.) means a non-English question -> reject. A few
// stray symbols are fine, and medical/Latin/Greek-DERIVED terms are written in
// Latin script so they pass; Latin-script non-English (French, Spanish) is caught
// by the AI gate below.
function isEnglishArena(text) {
  const s = String(text || "");
  let letters = 0, nonLatin = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) { letters++; continue; }
    // Greek/Cyrillic/Hebrew/Arabic, Devanagari, and CJK/Kana/Hangul and beyond.
    if ((c >= 0x0370 && c <= 0x06ff) || (c >= 0x0900 && c <= 0x097f) || c >= 0x3040) nonLatin++;
  }
  if (letters < 6) return false;
  if (nonLatin > 2 || nonLatin / (letters + nonLatin) > 0.1) return false;
  return true;
}
const STOP = new Set("the a an of to in on at for and or is are was were be been being what which who whom whose when where why how does do did can could would should will shall may might must this that these those with from by as it its their his her they them you your our we name named called known following best most main one first type kind example city country place thing term word number group also often usually commonly".split(" "));
// A coarse "concept" key so near-duplicate questions (same idea + answer, just
// reworded) collapse to one, keeping the pool diverse rather than 40 phrasings of
// the same fact: the correct answer plus the salient words of the question.
function conceptKey(q, correct) {
  // Keep the most distinctive words: length >= 4 drops short function words (has,
  // was, who, ...) without an exhaustive stop list, then take the longest few, so
  // wording variants of the same fact ("has the symbol" vs "with symbol") collapse.
  const words = [...new Set(String(q || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length >= 4 && !STOP.has(w)))];
  words.sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
  const top = words.slice(0, 5).sort().join(" ");
  return arenaHash(String(correct || "").toLowerCase().trim() + "|" + top);
}

const arenaHash = (q) => "u" + (Math.abs([...String(q || "").toLowerCase().replace(/\s+/g, " ").trim()].reduce((h, c) => (h * 33 + c.charCodeAt(0)) | 0, 5381)) >>> 0).toString(36);

// Vet + convert one contributed MCQ into the Arena's gk_pool shape, or null if it
// fails the cheap deterministic gate. Runs on every item server-side (so it holds
// even for a client that skips the UI).
function sanitizeArenaItem(x) {
  if (!x || typeof x !== "object") return null;
  const q = clean(x.question, 280);
  if (q.length < 12 || q.length > 280) return null;
  if (SELF_REF_RE.test(q)) return null;                              // not self-contained
  const options = Array.isArray(x.options) ? x.options.slice(0, 6).map((o) => clean(o, 120)).filter(Boolean) : [];
  const ci = Number.isInteger(x.correct) ? x.correct : -1;
  if (options.length < 4 || ci < 0 || ci >= options.length) return null; // need 1 correct + >=3 distractors
  const correct = options[ci];
  const distractors = options.filter((_, i) => i !== ci);
  if (distractors.length < 3) return null;
  const lc = correct.toLowerCase();
  if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) return null; // duplicate options
  if (distractors.some((d) => d.toLowerCase() === lc)) return null;
  if (!isEnglishArena(q + " " + options.join(" "))) return null;     // English-only
  if (looksAbusive(q) || options.some(looksAbusive)) return null;
  const diff = ARENA_DIFF[Math.max(0, Math.min(2, Math.round(Number(x.diff) || 1)))];
  const category = clean(x.subject, 40).toLowerCase() || "general";
  return {
    qhash: arenaHash(q),
    concept: conceptKey(q, correct),
    category,
    question: q,
    correct,
    distractors: distractors.slice(0, 5).map((d) => ({ text: d, close: 0.5 })),
    difficulty: diff,
  };
}

// AI quality gate: only genuinely good, self-contained, factually-sound English
// general-knowledge questions reach the shared Arena. One batched, model-pinned +
// token-capped call. Returns a Set of the indices the model judged good. Fails
// CLOSED (empty) so an outage never lets junk through.
async function arenaAIGate(items) {
  const KEY = process.env.ANTHROPIC_API_KEY;
  if (!KEY || !items.length) return new Set();
  const list = items.map((it, i) => `#${i + 1}\nQ: ${it.question}\nCorrect: ${it.correct}\nOther options: ${it.distractors.map((d) => d.text).join(" | ")}`).join("\n\n");
  const prompt =
    "You are the quality gate for a public English general-knowledge quiz Arena that anyone can play. Judge each numbered question. Mark good=true ONLY if ALL of these hold: " +
    "(1) it is written in clear, natural ENGLISH (technical, medical, Latin or Greek-derived TERMS are fine, but the question itself must be English, not another language); " +
    "(2) it is fully SELF-CONTAINED, answerable on its own with no passage, figure, document, or personal context; " +
    "(3) the marked Correct answer is factually correct and is the single best answer among the options; " +
    "(4) it is of GENERAL interest, not hyper-niche, course-specific, or personal-notes trivia; " +
    "(5) it is clear, unambiguous, and not offensive. Otherwise good=false. Be strict. " +
    "Return ONLY raw JSON: {\"v\":[{\"n\":1,\"good\":true}]} with exactly one entry per number.\n\n" + list;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 1500, system: "You are a strict, fair quiz-quality classifier. Return only raw JSON.", messages: [{ role: "user", content: [{ type: "text", text: prompt }] }] }),
    });
    if (!r.ok) { console.error("[arena gate]", r.status); return new Set(); }
    const j = await r.json();
    const text = (j.content || []).map((b) => b.text || "").join("").trim().replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
    const good = new Set();
    for (const v of (JSON.parse(text).v || [])) if (v && v.good === true && Number.isInteger(v.n)) good.add(v.n - 1);
    return good;
  } catch (e) { console.error("[arena gate] failed:", e.message); return new Set(); }
}

// Opt-in contribution: the learner chose to share their quiz's good questions to
// the public Arena pool. Layers: deterministic vet -> near-duplicate collapse ->
// AI gate -> store. Per-account daily cap bounds both flooding and AI-gate cost.
async function arenaContribute(req, res, body, userId) {
  const received = Array.isArray(body.items) ? body.items.length : 0;
  const used = (await sql`SELECT contribs FROM arena_contrib_actor WHERE clerk_user_id = ${userId} AND day = CURRENT_DATE`)[0]?.contribs || 0;
  if (used >= ARENA_CONTRIB_DAILY) return res.status(200).json({ ok: true, received, accepted: 0, stored: 0, capped: true });
  const room = ARENA_CONTRIB_DAILY - used;
  // 1) cheap deterministic gate (well-formed, self-contained, English, non-abusive)
  let cand = (Array.isArray(body.items) ? body.items : []).slice(0, ARENA_CONTRIB_PER_CALL).map(sanitizeArenaItem).filter(Boolean);
  // 2) drop near-duplicates within this batch, then against what's already stored
  const seen = new Set();
  cand = cand.filter((it) => (seen.has(it.concept) ? false : (seen.add(it.concept), true)));
  if (cand.length) {
    const dupC = new Set((await sql`SELECT concept FROM arena_contrib WHERE concept = ANY(${cand.map((it) => it.concept)}::text[])`).map((r) => r.concept));
    const dupH = new Set((await sql`SELECT qhash FROM arena_contrib WHERE qhash = ANY(${cand.map((it) => it.qhash)}::text[])`).map((r) => r.qhash));
    cand = cand.filter((it) => !dupC.has(it.concept) && !dupH.has(it.qhash));
  }
  cand = cand.slice(0, room);
  // 3) AI quality gate: keep only the genuinely good ones
  const good = cand.length ? await arenaAIGate(cand) : new Set();
  const approved = cand.filter((_, i) => good.has(i));
  let stored = 0;
  for (const it of approved) {
    await sql`INSERT INTO arena_contrib (qhash, concept, category, question, correct, distractors, difficulty)
      VALUES (${it.qhash}, ${it.concept}, ${it.category}, ${it.question}, ${it.correct}, ${JSON.stringify(it.distractors)}::jsonb, ${it.difficulty})
      ON CONFLICT (qhash) DO NOTHING`;
    stored++;
  }
  // Count everything that reached the AI gate against the cap (bounds gate cost).
  if (cand.length) {
    await sql`INSERT INTO arena_contrib_actor (clerk_user_id, day, contribs) VALUES (${userId}, CURRENT_DATE, ${cand.length})
              ON CONFLICT (clerk_user_id, day) DO UPDATE SET contribs = arena_contrib_actor.contribs + ${cand.length}`;
  }
  // Keep the pool bounded: drop most-flagged, then least-played, then oldest beyond the cap.
  await sql`DELETE FROM arena_contrib WHERE id IN (
    SELECT id FROM arena_contrib ORDER BY flags ASC, plays DESC, created_at DESC OFFSET ${ARENA_POOL_CAP})`;
  if (Math.random() < 0.05) await sql`DELETE FROM arena_contrib_actor WHERE day < CURRENT_DATE - 3`;
  return res.status(200).json({ ok: true, received, accepted: approved.length, stored });
}

// ── Endless Arena (server) ──────────────────────────────────────────────────
// Scoring/difficulty helpers MIRROR src/lib/arena.js; inlined so the serverless
// bundle needs no cross-directory import. Keep the two in sync.
const ARENA_GATE = 100, ADIFF_MIN = 1, ADIFF_MAX = 5, ACLOSE_BONUS = 2.0;
// The global leaderboard stays hidden until this many learners are ranked, so it
// only appears once there are enough to make a real "top 100". Tune freely.
const GLOBAL_GATE = 75;
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
// Competitive Arena season = one calendar month (UTC); the ladder resets each
// month. `arenaSeasonId` labels the current season; `arenaSeasonEnd` is the
// first instant of next month (when this season closes).
const arenaSeasonId = (d = new Date()) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
const arenaSeasonEnd = (d = new Date()) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString();

// ── Weekly Leagues ──────────────────────────────────────────────────────────
// Small, winnable cohorts (Duolingo-style). Gated like the leaderboard: below
// LEAGUE_GATE distinct arena players there aren't enough people to form real
// cohorts, so the whole feature stays locked and shows a progress card instead.
const LEAGUE_GATE = 100;     // distinct arena players before leagues unlock (mirrors the board)
const LEAGUE_COHORT = 30;    // players per cohort
const LEAGUE_PROMOTE = 7;    // top N of a cohort promote a tier each week
const LEAGUE_DEMOTE = 5;     // bottom N demote a tier each week
const LEAGUE_TIERS = ["bronze", "silver", "gold", "sapphire", "ruby", "diamond"]; // index 0..5
// ISO week id (YYYY-Www, UTC) + the instant it closes (next Monday 00:00 UTC).
function isoWeekId(d = new Date()) {
  const dt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - day);          // shift to the week's Thursday
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((dt - yearStart) / 86400000) + 1) / 7);
  return `${dt.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
function leagueWeekEnd(d = new Date()) {
  const day = d.getUTCDay() || 7;                     // 1=Mon..7=Sun
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + (8 - day))).toISOString();
}

// Ensure the player is placed in a cohort for the CURRENT week, rolling last
// week's result into a promotion/demotion first (lazy, so no cron is needed).
// Returns { week, cohort, tier }.
async function leaguePlacement(userId) {
  const wk = isoWeekId();
  const cur = (await sql`SELECT cohort, tier FROM arena_league WHERE week = ${wk} AND clerk_user_id = ${userId}`)[0];
  if (cur) return { week: wk, cohort: cur.cohort, tier: cur.tier };

  // First visit this week: derive the new tier from last week's finish.
  let tier = 0;
  const last = (await sql`SELECT week, cohort, tier, points FROM arena_league
                          WHERE clerk_user_id = ${userId} AND week <> ${wk} ORDER BY week DESC LIMIT 1`)[0];
  if (last) {
    tier = aclamp(Number(last.tier) || 0, 0, LEAGUE_TIERS.length - 1);
    const ahead = (await sql`SELECT COUNT(*)::int AS n FROM arena_league
                             WHERE week = ${last.week} AND cohort = ${last.cohort}
                               AND (points > ${last.points} OR (points = ${last.points} AND clerk_user_id < ${userId}))`)[0]?.n || 0;
    const size = (await sql`SELECT COUNT(*)::int AS n FROM arena_league WHERE week = ${last.week} AND cohort = ${last.cohort}`)[0]?.n || 1;
    const rank = ahead + 1;
    if (rank <= LEAGUE_PROMOTE && tier < LEAGUE_TIERS.length - 1) tier += 1;
    else if (rank > size - LEAGUE_DEMOTE && tier > 0) tier -= 1;
  }
  // Slot into an open cohort at this tier (else start a new one). Racy under
  // load but a slightly over/under-full cohort is harmless.
  const open = (await sql`SELECT cohort FROM arena_league WHERE week = ${wk} AND tier = ${tier}
                          GROUP BY cohort HAVING COUNT(*) < ${LEAGUE_COHORT} ORDER BY cohort ASC LIMIT 1`)[0]?.cohort;
  const cohort = open ?? ((await sql`SELECT COALESCE(MAX(cohort), -1) + 1 AS c FROM arena_league WHERE week = ${wk} AND tier = ${tier}`)[0]?.c ?? 0);
  await sql`INSERT INTO arena_league (week, clerk_user_id, cohort, tier, points)
            VALUES (${wk}, ${userId}, ${cohort}, ${tier}, 0) ON CONFLICT (week, clerk_user_id) DO NOTHING`;
  const row = (await sql`SELECT cohort, tier FROM arena_league WHERE week = ${wk} AND clerk_user_id = ${userId}`)[0] || { cohort, tier };
  return { week: wk, cohort: row.cohort, tier: row.tier };
}

// Add a finished arena run's points to the player's weekly league total.
async function leagueAddPoints(userId, pts) {
  const p = Math.max(0, Math.round(Number(pts) || 0));
  if (!p) return;
  try {
    const pl = await leaguePlacement(userId);
    await sql`UPDATE arena_league SET points = points + ${p}, updated_at = NOW()
              WHERE week = ${pl.week} AND clerk_user_id = ${userId}`;
  } catch (e) { console.error("[league] add points:", e.message); }
}

// This week's cohort standings + where the player sits, with the promotion and
// demotion zones. Locked (like the board) until LEAGUE_GATE players exist.
async function leagueBoard(req, res, userId) {
  await ensureUsernameCol();
  const players = (await sql`SELECT COUNT(*)::int AS n FROM arena_score`)[0]?.n || 0;
  if (players < LEAGUE_GATE) return res.status(200).json({ locked: true, players, need: LEAGUE_GATE });
  const pl = await leaguePlacement(userId);
  const rows = await sql`
    SELECT a.clerk_user_id, a.points, p.username, p.equipped_badge, p.rank
    FROM arena_league a LEFT JOIN profiles p ON p.clerk_user_id = a.clerk_user_id
    WHERE a.week = ${pl.week} AND a.cohort = ${pl.cohort}
    ORDER BY a.points DESC, a.updated_at ASC LIMIT ${LEAGUE_COHORT}`;
  return res.status(200).json({
    locked: false, week: pl.week, endsAt: leagueWeekEnd(),
    tier: pl.tier, tierName: LEAGUE_TIERS[pl.tier], tiers: LEAGUE_TIERS,
    promote: LEAGUE_PROMOTE, demote: LEAGUE_DEMOTE, size: LEAGUE_COHORT,
    board: rows.map((r, i) => ({
      pos: i + 1, name: r.username || "player", points: Number(r.points) || 0,
      badge: publicBadge(r), rank: publicRank(r), you: r.clerk_user_id === userId,
    })),
  });
}

// Lazy self-heal of the public-username column + case-insensitive unique index.
let unameReady = false;
async function ensureUsernameCol() {
  if (unameReady) return;
  try {
    await sql`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS username TEXT`;
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS profiles_username_lower ON profiles (lower(username)) WHERE username IS NOT NULL`;
    // Public flair mirror: the badge the user pinned + their rank tier (0..6) +
    // lifetime XP, computed client-side and stored here so leaderboards show it
    // cheaply. rank NULL or -1 (and xp NULL) means the user hid their status.
    await sql`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS equipped_badge TEXT`;
    await sql`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS rank INT`;
    await sql`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS xp INT`;
    await sql`CREATE INDEX IF NOT EXISTS profiles_xp ON profiles (xp DESC) WHERE xp IS NOT NULL`;
    unameReady = true;
  } catch (e) { console.error("[arena] username col:", e.message); }
}

// Draw a batch of pool questions near a target difficulty. Returns the correct
// answer + full distractor pool + CROWD-CALIBRATED difficulty; the client
// assembles each serve (3 random relevant distractors) and shows instant verdict.
async function arenaDraw(req, res, body) {
  void body;
  // STRATIFIED easy-first draw: sample within difficulty bands so every run is
  // GUARANTEED to open with general, easy questions and ramp up, instead of a
  // flat random spread that could start hard. Counts thin out toward the top so
  // the curve stays gentle early and only the deepest questions are brutal. The
  // client then sorts ascending by the crowd-calibrated difficulty for a smooth
  // ramp. Bands use the generator's base difficulty (1..5); a thin band just
  // contributes fewer rows.
  const rows = await sql`
    (SELECT id, category, question, correct, distractors, difficulty, plays, correct_count FROM gk_pool WHERE difficulty < 1.5 ORDER BY random() LIMIT 16)
    UNION ALL (SELECT id, category, question, correct, distractors, difficulty, plays, correct_count FROM gk_pool WHERE difficulty >= 1.5 AND difficulty < 2.5 ORDER BY random() LIMIT 18)
    UNION ALL (SELECT id, category, question, correct, distractors, difficulty, plays, correct_count FROM gk_pool WHERE difficulty >= 2.5 AND difficulty < 3.5 ORDER BY random() LIMIT 14)
    UNION ALL (SELECT id, category, question, correct, distractors, difficulty, plays, correct_count FROM gk_pool WHERE difficulty >= 3.5 AND difficulty < 4.5 ORDER BY random() LIMIT 9)
    UNION ALL (SELECT id, category, question, correct, distractors, difficulty, plays, correct_count FROM gk_pool WHERE difficulty >= 4.5 ORDER BY random() LIMIT 3)`;
  // Blend in opt-in community questions (namespaced "c"+id), skipping flagged or
  // crowd-proven-broken ones (very low correct-rate over enough plays). Wrapped in
  // try/catch so a cold DB without the table still serves the curated pool.
  let contrib;
  try {
    contrib = await sql`SELECT id, category, question, correct, distractors, difficulty, plays, correct_count
      FROM arena_contrib
      WHERE flags = 0 AND NOT (plays >= 12 AND correct_count::float / GREATEST(plays, 1) < 0.15)
      ORDER BY random() LIMIT 14`;
  } catch { contrib = []; }
  const shape = (r, pre) => ({
    id: pre + r.id, category: r.category, question: r.question, correct: r.correct,
    distractors: Array.isArray(r.distractors) ? r.distractors : [],
    difficulty: Math.round(aDifficulty(r.difficulty, r.plays, r.correct_count) * 100) / 100,
  });
  return res.status(200).json({ questions: [...rows.map((r) => shape(r, "")), ...contrib.map((r) => shape(r, "c"))] });
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
  // Answers carry namespaced ids: gk_pool = plain number, community pool = "c"+id.
  const gkIds = [], ccIds = [];
  for (const a of answers) {
    const s = String(a.id ?? "");
    if (s[0] === "c") { const n = parseInt(s.slice(1), 10); if (Number.isInteger(n)) ccIds.push(n); }
    else { const n = parseInt(s, 10); if (Number.isInteger(n)) gkIds.push(n); }
  }
  const diffs = new Map(); // raw id string -> crowd-calibrated difficulty
  if (gkIds.length) {
    const drows = await sql`SELECT id, difficulty, plays, correct_count FROM gk_pool WHERE id = ANY(${gkIds}::bigint[])`;
    for (const r of drows) diffs.set(String(r.id), aDifficulty(r.difficulty, r.plays, r.correct_count));
  }
  if (ccIds.length) {
    try {
      const crows = await sql`SELECT id, difficulty, plays, correct_count FROM arena_contrib WHERE id = ANY(${ccIds}::bigint[])`;
      for (const r of crows) diffs.set("c" + r.id, aDifficulty(r.difficulty, r.plays, r.correct_count));
    } catch { /* table may not exist yet on a cold DB */ }
  }
  let score = 0, streak = 0;
  const gkStat = [], gkOk = [], ccStat = [], ccOk = [];
  for (const a of answers) {
    const s = String(a.id ?? "");
    const isCc = s[0] === "c";
    const num = parseInt(isCc ? s.slice(1) : s, 10);
    if (!Number.isInteger(num)) continue;
    const base = diffs.has(s) ? diffs.get(s) : 2.5;
    const ok = a.ok === true || a.ok === 1;
    if (isCc) { ccStat.push(num); ccOk.push(ok ? 1 : 0); } else { gkStat.push(num); gkOk.push(ok ? 1 : 0); }
    if (ok) { score += aclamp(parseInt(a.pts, 10) || 0, 0, aMaxQPts(base, streak)); streak += 1; }
    else streak = 0;
  }
  if (gkStat.length) {
    try {
      await sql`UPDATE gk_pool g SET plays = plays + 1, correct_count = correct_count + c.ok
                FROM (SELECT unnest(${gkStat}::bigint[]) AS id, unnest(${gkOk}::int[]) AS ok) c WHERE g.id = c.id`;
    } catch (e) { console.error("[arena] gk stat update:", e.message); }
  }
  if (ccStat.length) {
    try {
      await sql`UPDATE arena_contrib g SET plays = plays + 1, correct_count = correct_count + c.ok
                FROM (SELECT unnest(${ccStat}::bigint[]) AS id, unnest(${ccOk}::int[]) AS ok) c WHERE g.id = c.id`;
    } catch (e) { console.error("[arena] contrib stat update:", e.message); }
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
  // Competitive season: keep this month's best run for the seasonal ladder.
  if (score > 0) {
    const season = arenaSeasonId();
    await sql`INSERT INTO arena_season (season, clerk_user_id, best_score, questions, updated_at)
              VALUES (${season}, ${userId}, ${score}, ${questions}, NOW())
              ON CONFLICT (season, clerk_user_id) DO UPDATE SET
                questions = CASE WHEN EXCLUDED.best_score > arena_season.best_score THEN EXCLUDED.questions ELSE arena_season.questions END,
                best_score = GREATEST(arena_season.best_score, EXCLUDED.best_score),
                updated_at = NOW()`;
  }
  // Weekly league: this run's points add to your cohort standing for the week
  // (best-effort; a league hiccup must never fail a submitted arena run).
  await leagueAddPoints(userId, score);
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
    SELECT a.best_score, a.questions, a.freeze_used, a.hint_used, a.skip_used, p.username, p.equipped_badge, p.rank
    FROM arena_score a LEFT JOIN profiles p ON p.clerk_user_id = a.clerk_user_id
    ORDER BY a.best_score DESC, a.updated_at ASC LIMIT 100`;
  return res.status(200).json({
    locked: false, players, you,
    top: top.map((r) => ({ name: r.username || "player", score: r.best_score, questions: r.questions, freeze: r.freeze_used, hint: r.hint_used, skip: r.skip_used, badge: publicBadge(r), rank: publicRank(r) })),
  });
}

// Competitive season ladder: this month's best-run leaderboard + where you
// stand. The client maps `you.score` to a tier (Bronze..Diamond). Not gated,
// so the ladder works from day one of each fresh season.
async function arenaSeasonBoard(req, res, userId) {
  await ensureUsernameCol();
  const season = arenaSeasonId();
  const players = (await sql`SELECT COUNT(*)::int AS n FROM arena_season WHERE season = ${season}`)[0]?.n || 0;
  const mine = (await sql`SELECT best_score, questions FROM arena_season WHERE season = ${season} AND clerk_user_id = ${userId}`)[0] || null;
  const rank = mine ? ((await sql`SELECT COUNT(*)::int AS n FROM arena_season WHERE season = ${season} AND best_score > ${mine.best_score}`)[0]?.n || 0) + 1 : null;
  const top = await sql`
    SELECT a.best_score, a.questions, p.username, p.equipped_badge, p.rank
    FROM arena_season a LEFT JOIN profiles p ON p.clerk_user_id = a.clerk_user_id
    WHERE a.season = ${season} ORDER BY a.best_score DESC, a.updated_at ASC LIMIT 100`;
  return res.status(200).json({
    season, endsAt: arenaSeasonEnd(), players,
    you: mine ? { rank, score: mine.best_score, questions: mine.questions } : null,
    top: top.map((r, i) => ({ pos: i + 1, name: r.username || "player", score: r.best_score, questions: r.questions, badge: publicBadge(r), rank: publicRank(r) })),
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
// Map clerk ids -> their uploaded avatar URL (public profile photo), for lists.
// Fail-soft: the avatar_url column is provisioned by the profile endpoint, so a
// cold DB that hasn't seen it yet just yields no avatars (letter fallback).
async function avatarsFor(ids) {
  if (!ids.length) return {};
  try {
    const rows = await sql`SELECT COALESCE(clerk_user_id, id) AS uid, avatar_url FROM profiles
                           WHERE (clerk_user_id = ANY(${ids}::text[]) OR id = ANY(${ids}::text[])) AND avatar_url IS NOT NULL`;
    const out = {};
    // Only ever serve a preset avatar id to other users, never a URL, so no
    // external image is loaded in a viewer's browser (defence-in-depth vs any
    // legacy/stored URL).
    for (const r of rows) if (r.uid && /^[a-z0-9_-]{1,32}$/.test(String(r.avatar_url))) out[r.uid] = r.avatar_url;
    return out;
  } catch { return {}; }
}
// Public flair helpers: a rank of null or < 0 means the user hid their status,
// so both rank and badge are suppressed. rank 0 (Novice) is a real, shown tier.
function publicRank(r) { const n = r && r.rank; return (n == null || Number(n) < 0) ? null : Number(n); }
function publicBadge(r) { return publicRank(r) == null ? null : (r.equipped_badge || null); }
// Map clerk ids -> their public {badge, rank, xp} for leaderboards/standings.
async function flairFor(ids) {
  if (!ids.length) return {};
  const rows = await sql`SELECT COALESCE(clerk_user_id, id) AS uid, equipped_badge, rank, xp FROM profiles
                         WHERE clerk_user_id = ANY(${ids}::text[]) OR id = ANY(${ids}::text[])`;
  const out = {};
  for (const r of rows) if (r.uid) out[r.uid] = { badge: publicBadge(r), rank: publicRank(r), xp: publicRank(r) == null ? null : (r.xp == null ? null : Number(r.xp)) };
  return out;
}
// POST action=setBadge: mirror the caller's equipped badge + rank tier onto their
// public profile (token-verified). rank = -1 hides their status on leaderboards.
async function setBadge(req, res, body, me) {
  let equipped = body.equipped == null ? null : String(body.equipped).slice(0, 40);
  if (equipped && !/^[a-z0-9_]{1,40}$/.test(equipped)) equipped = null;
  let rank = parseInt(body.rank, 10);
  rank = Number.isInteger(rank) ? Math.max(-1, Math.min(20, rank)) : null;
  // Lifetime XP powers the global leaderboard's fine ordering. A hidden user
  // (rank < 0) is stored with NULL xp so they drop off the public board.
  // Clamp to a sane ceiling: ranks top out at 8,000 XP and even an extreme
  // multi-year user stays well under 2M, so this never clips a real learner but
  // stops an absurd hand-crafted value from topping the board. NOTE: XP is
  // computed client-side from the study blob (which the client authors), so this
  // cap is defense-in-depth, not full anti-cheat; a tamper-proof board needs
  // server-side activity accounting (a separate, larger change).
  let xp = parseInt(body.xp, 10);
  xp = (Number.isInteger(xp) && xp >= 0 && rank != null && rank >= 0) ? Math.min(xp, 2000000) : null;
  await ensureUsernameCol();
  try {
    await sql`INSERT INTO profiles (id, clerk_user_id) VALUES (${me}, ${me}) ON CONFLICT (id) DO NOTHING`;
    await sql`UPDATE profiles SET equipped_badge = ${equipped}, rank = ${rank}, xp = ${xp} WHERE clerk_user_id = ${me} OR id = ${me}`;
    return res.status(200).json({ ok: true });
  } catch (e) { console.error("[study] setBadge:", e.message); return res.status(500).json({ error: "Could not save." }); }
}

// The GLOBAL leaderboard: the top 100 learners by lifetime XP (the "best of the
// best" across every mode), independent of the Endless Arena's high-score board.
// Hidden users (NULL xp) are excluded. Also returns the caller's own standing.
async function globalBoard(req, res, me) {
  await ensureUsernameCol();
  const players = (await sql`SELECT COUNT(*)::int AS n FROM profiles WHERE xp IS NOT NULL AND xp > 0 AND username IS NOT NULL`)[0]?.n || 0;
  const mine = (await sql`SELECT username, equipped_badge, rank, xp FROM profiles WHERE clerk_user_id = ${me} OR id = ${me} LIMIT 1`)[0] || null;
  let you = null;
  if (mine && mine.xp != null && mine.xp > 0) {
    const ahead = (await sql`SELECT COUNT(*)::int AS n FROM profiles WHERE xp IS NOT NULL AND username IS NOT NULL AND (xp > ${mine.xp} OR (xp = ${mine.xp} AND username < ${mine.username || ""}))`)[0]?.n || 0;
    you = { pos: ahead + 1, xp: Number(mine.xp), tier: publicRank(mine), badge: publicBadge(mine), name: mine.username || null };
  }
  // Gate: hidden until enough learners are ranked to be a real board.
  if (players < GLOBAL_GATE) return res.status(200).json({ locked: true, players, need: GLOBAL_GATE, you });
  const top = await sql`
    SELECT COALESCE(clerk_user_id, id) AS uid, username, equipped_badge, rank, xp
    FROM profiles WHERE xp IS NOT NULL AND xp > 0 AND username IS NOT NULL
    ORDER BY xp DESC, username ASC LIMIT 100`;
  return res.status(200).json({
    locked: false, players, you,
    top: top.map((r) => ({ name: r.username || "player", xp: Number(r.xp), tier: publicRank(r), badge: publicBadge(r), you: r.uid === me })),
  });
}

// Per-account daily cap on searches, so the endpoint can't be scripted to walk
// the whole user base (usernames are public, but bound the volume + the scans).
// Own tiny self-provisioned table, fail-OPEN so a counter blip never breaks the
// picker. Generous: real friend-adding is a handful of searches.
const MAX_SEARCHES_DAILY = 200;
let searchRateReady = false;
async function underSearchLimit(me) {
  try {
    if (!searchRateReady) {
      await sql`CREATE TABLE IF NOT EXISTS search_rate (
        clerk_user_id TEXT NOT NULL,
        day           DATE NOT NULL DEFAULT CURRENT_DATE,
        n             INT  NOT NULL DEFAULT 0,
        PRIMARY KEY (clerk_user_id, day)
      )`;
      searchRateReady = true;
    }
    const rows = await sql`INSERT INTO search_rate (clerk_user_id, day, n) VALUES (${me}, CURRENT_DATE, 1)
                           ON CONFLICT (clerk_user_id, day) DO UPDATE SET n = search_rate.n + 1 RETURNING n`;
    if (Math.random() < 0.02) { try { await sql`DELETE FROM search_rate WHERE day < CURRENT_DATE - 2`; } catch { /* ignore */ } }
    return (rows[0]?.n || 1) <= MAX_SEARCHES_DAILY;
  } catch { return true; }
}

// Type-ahead search for the add-a-friend picker: match public usernames by
// prefix first, then substring, so a partial or slightly-off name still finds
// the right person. Usernames are already public (leaderboards), so this exposes
// nothing new; min length + LIMIT + a daily cap keep it from dumping the table.
// Returns each match's flair + whether you're already friends/pending, so the
// picker can show which one is yours.
async function userSearch(req, res, body, me) {
  const q = clean(body.q, 30).toLowerCase();
  if (q.length < 2) return res.status(200).json({ results: [] });
  if (!(await underSearchLimit(me))) return res.status(200).json({ results: [] });
  const esc = q.replace(/[%_\\]/g, "\\$&"); // neutralise LIKE wildcards
  let rows;
  try {
    rows = await sql`
      SELECT COALESCE(clerk_user_id, id) AS uid, username FROM profiles
      WHERE username IS NOT NULL AND COALESCE(clerk_user_id, id) <> ${me}
        AND lower(username) LIKE ${"%" + esc + "%"}
      ORDER BY (lower(username) LIKE ${esc + "%"}) DESC, length(username) ASC, lower(username) ASC
      LIMIT 8`;
  } catch (e) { console.error("[study] userSearch:", e.message); return res.status(200).json({ results: [] }); }
  const ids = rows.map((r) => r.uid);
  if (!ids.length) return res.status(200).json({ results: [] });
  const [flair, avatars, statusRows] = await Promise.all([
    flairFor(ids),
    avatarsFor(ids),
    sql`SELECT requester, addressee, status FROM friendships
        WHERE (requester=${me} AND addressee = ANY(${ids}::text[])) OR (addressee=${me} AND requester = ANY(${ids}::text[]))`,
  ]);
  const statusMap = {};
  for (const f of statusRows) { const other = f.requester === me ? f.addressee : f.requester; statusMap[other] = f.status === "accepted" ? "friends" : "pending"; }
  return res.status(200).json({ results: rows.map((r) => ({
    userId: r.uid, username: r.username, avatar: avatars[r.uid] || null,
    rank: flair[r.uid]?.rank ?? null, badge: flair[r.uid]?.badge || null,
    status: statusMap[r.uid] || null,
  })) });
}

// Cap on OUTSTANDING outgoing friend requests, so an account can't spray
// requests at everyone. Accepted/declined requests free up room, so this never
// limits a genuine user, only mass-spamming.
const MAX_PENDING_REQUESTS = 60;
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
  // Only a brand-new request counts against the cap (accepting a reverse request
  // above never does).
  const pendingOut = Number((await sql`SELECT COUNT(*) AS n FROM friendships WHERE requester=${me} AND status='pending'`)[0]?.n || 0);
  if (pendingOut >= MAX_PENDING_REQUESTS) {
    return res.status(429).json({ error: "You have too many pending friend requests. Wait for some to be accepted first." });
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
  // Attach each friend's public rank tier + XP + equipped badge + avatar for the list.
  const [fflair, favatars] = await Promise.all([flairFor(friends.map((f) => f.userId)), avatarsFor(friends.map((f) => f.userId))]);
  friends.forEach((f) => { const x = fflair[f.userId] || {}; f.rank = x.rank ?? null; f.badge = x.badge || null; f.xp = x.xp ?? null; f.avatar = favatars[f.userId] || null; });
  const groups = grpRows.map((g) => ({ id: Number(g.id), name: g.name, members: Number(g.members), isOwner: g.owner === me }));
  return res.status(200).json({ friends, incoming, outgoing, groups });
}

// ── Friend direct messages (text / shared material / score / challenge) ──────
async function areFriends(me, them) {
  if (!them || them === me) return false;
  return (await sql`SELECT 1 FROM friendships WHERE status='accepted' AND ((requester=${me} AND addressee=${them}) OR (requester=${them} AND addressee=${me})) LIMIT 1`).length > 0;
}
const DM_KINDS = new Set(["text", "material", "score", "challenge"]);
async function dmSend(req, res, body, me) {
  const them = clean(body.friendId, 60);
  if (!them) return res.status(400).json({ error: "Bad request." });
  if (!(await areFriends(me, them))) return res.status(403).json({ error: "You can only message your friends." });
  const kind = DM_KINDS.has(body.kind) ? body.kind : "text";
  const bodyText = clean(body.body || "", 2000);
  let data = null;
  if (body.data && typeof body.data === "object") { const json = JSON.stringify(body.data); if (json.length <= 60000) data = body.data; }
  if (kind === "text" && !bodyText) return res.status(400).json({ error: "Say something." });
  const row = (await sql`INSERT INTO friend_messages (sender, recipient, kind, body, data)
    VALUES (${me}, ${them}, ${kind}, ${bodyText}, ${data ? JSON.stringify(data) : null}::jsonb) RETURNING id`)[0];
  return res.status(200).json({ ok: true, id: Number(row.id) });
}
// Build the comparison payload for one friend challenge from the two players'
// score rows. `complete` once both have played; winner is by percentage.
function dmChallengePct(r) { return r && r.total > 0 ? Math.round((r.score / r.total) * 100) : 0; }
function buildDmChallengeResults(mineRow, theirRow) {
  const mine = mineRow ? { score: mineRow.score, total: mineRow.total, pct: dmChallengePct(mineRow) } : null;
  const theirs = theirRow ? { score: theirRow.score, total: theirRow.total, pct: dmChallengePct(theirRow) } : null;
  const complete = !!(mine && theirs);
  let winner = null;
  if (complete) winner = mine.pct > theirs.pct ? "me" : theirs.pct > mine.pct ? "them" : "tie";
  return { mine, theirs, complete, winner, iPlayed: !!mine };
}
async function dmThread(req, res, body, me) {
  const them = clean(body.friendId, 60);
  if (!them) return res.status(400).json({ error: "Bad request." });
  if (!(await areFriends(me, them))) return res.status(403).json({ error: "You're not friends." });
  const rows = await sql`SELECT id, sender, kind, body, data, created_at FROM friend_messages
    WHERE (sender=${me} AND recipient=${them}) OR (sender=${them} AND recipient=${me})
    ORDER BY id ASC LIMIT 300`;
  // Attach each challenge's two-sided scores + winner so the thread renders the
  // comparison inline (the client already polls this every few seconds).
  const chalIds = rows.filter((r) => r.kind === "challenge").map((r) => Number(r.id));
  const scoreMap = {};
  if (chalIds.length) {
    const srows = await sql`SELECT challenge_id, clerk_user_id, score, total FROM friend_challenge_scores WHERE challenge_id = ANY(${chalIds}::bigint[])`;
    for (const s of srows) { const cid = Number(s.challenge_id); (scoreMap[cid] ||= {})[s.clerk_user_id] = { score: s.score, total: s.total }; }
  }
  const name = (await usernamesFor([them]))[them] || "friend";
  return res.status(200).json({ friendId: them, username: name,
    messages: rows.map((r) => {
      const m = { id: Number(r.id), mine: r.sender === me, kind: r.kind, body: r.body, data: r.data || null, at: r.created_at };
      if (r.kind === "challenge") { const sm = scoreMap[Number(r.id)] || {}; m.results = buildDmChallengeResults(sm[me] || null, sm[them] || null); }
      return m;
    }) });
}
// Record this player's score on a friend challenge (play-once). Either of the
// two friends may submit; ON CONFLICT DO NOTHING makes re-taking a no-op so the
// first recorded score stands. Returns the current comparison.
async function dmChallengeSubmit(req, res, body, me) {
  const cid = Number(body.challengeId);
  if (!Number.isFinite(cid) || cid <= 0) return res.status(400).json({ error: "Bad request." });
  const msg = (await sql`SELECT sender, recipient, kind FROM friend_messages WHERE id=${cid} LIMIT 1`)[0];
  if (!msg || msg.kind !== "challenge" || (msg.sender !== me && msg.recipient !== me))
    return res.status(403).json({ error: "Not your challenge." });
  const total = Math.max(0, Math.min(100, Math.round(Number(body.total) || 0)));
  const score = Math.max(0, Math.min(total, Math.round(Number(body.score) || 0)));
  await sql`INSERT INTO friend_challenge_scores (challenge_id, clerk_user_id, score, total)
    VALUES (${cid}, ${me}, ${score}, ${total}) ON CONFLICT (challenge_id, clerk_user_id) DO NOTHING`;
  const them = msg.sender === me ? msg.recipient : msg.sender;
  const rows = await sql`SELECT clerk_user_id, score, total FROM friend_challenge_scores WHERE challenge_id=${cid}`;
  const byId = Object.fromEntries(rows.map((r) => [r.clerk_user_id, { score: r.score, total: r.total }]));
  return res.status(200).json({ ok: true, results: buildDmChallengeResults(byId[me] || null, byId[them] || null) });
}

// Lightweight notification summary for background polling: how many incoming
// friend requests, and per-group totals of messages from OTHERS + challenges.
// The client diffs these against its own last-seen counts to derive unread
// counts + fresh pop-ups (keeps this endpoint cheap + stateless).
async function notifications(req, res, me) {
  const friendReqs = (await sql`SELECT COUNT(*)::int AS n FROM friendships WHERE addressee=${me} AND status='pending'`)[0]?.n || 0;
  const gids = (await sql`SELECT group_id FROM group_members WHERE clerk_user_id=${me}`).map((r) => Number(r.group_id));
  let groups = [];
  if (gids.length) {
    const msgs = await sql`SELECT group_id, COUNT(*)::int AS n FROM group_messages WHERE group_id = ANY(${gids}::bigint[]) AND clerk_user_id <> ${me} GROUP BY group_id`;
    const chals = await sql`SELECT group_id, COUNT(*)::int AS n FROM group_challenges WHERE group_id = ANY(${gids}::bigint[]) GROUP BY group_id`;
    const mMap = Object.fromEntries(msgs.map((r) => [Number(r.group_id), r.n]));
    const cMap = Object.fromEntries(chals.map((r) => [Number(r.group_id), r.n]));
    groups = gids.map((id) => ({ id, msg: mMap[id] || 0, chal: cMap[id] || 0 }));
  }
  // Per-friend direct-message totals received (client diffs vs its seen counts).
  const dmRows = await sql`SELECT sender, COUNT(*)::int AS n FROM friend_messages WHERE recipient=${me} GROUP BY sender`;
  const dms = dmRows.map((r) => ({ id: r.sender, msg: r.n }));
  // Accepted friends' public XP, for the friend-overtake nudge. flairFor already
  // honours the "hide my status" flag (xp comes back null when hidden), and the
  // client compares each friend against its own live XP, so a hidden own-profile
  // never skews the check.
  const fids = (await sql`SELECT CASE WHEN requester=${me} THEN addressee ELSE requester END AS fid
    FROM friendships WHERE status='accepted' AND (requester=${me} OR addressee=${me})`).map((r) => r.fid).filter(Boolean);
  let friendsXp = [];
  if (fids.length) {
    const flair = await flairFor(fids);
    const names = await usernamesFor(fids);
    friendsXp = fids
      .filter((id) => flair[id] && typeof flair[id].xp === "number")
      .map((id) => ({ id, name: names[id] || "student", xp: flair[id].xp }));
  }
  return res.status(200).json({ friendReqs, groups, dms, friendsXp });
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

// Preview a group by its invite code WITHOUT joining, so a shared link can show
// the name + member count and let the person confirm before they join.
async function groupPreview(req, res, body, me) {
  const code = clean(body.code, 20);
  const g = (await sql`SELECT id, name FROM study_groups WHERE invite_code=${code} LIMIT 1`)[0];
  if (!g) return res.status(404).json({ error: "That invite code is not valid." });
  const members = Number((await sql`SELECT COUNT(*) AS n FROM group_members WHERE group_id=${g.id}`)[0]?.n || 0);
  const already = (await sql`SELECT 1 FROM group_members WHERE group_id=${g.id} AND clerk_user_id=${me} LIMIT 1`).length > 0;
  return res.status(200).json({ id: Number(g.id), name: g.name, members, already, code });
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
  const flair = await flairFor(ids);
  const statRows = await sql`SELECT clerk_user_id, data->'stats' AS stats FROM study_data WHERE clerk_user_id = ANY(${ids}::text[])`;
  const statMap = Object.fromEntries(statRows.map((r) => [r.clerk_user_id, r.stats || {}]));
  const members = mem.map((m) => {
    const s = statMap[m.clerk_user_id] || {};
    const answered = Number(s.answered) || 0, correct = Number(s.correct) || 0;
    return { userId: m.clerk_user_id, username: names[m.clerk_user_id] || "student", role: m.role,
      streak: Number(s.streak) || 0, answered, accuracy: answered ? Math.round((correct / answered) * 100) : 0, you: m.clerk_user_id === me,
      badge: flair[m.clerk_user_id]?.badge || null, rank: flair[m.clerk_user_id]?.rank ?? null };
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
  const flair = await flairFor(scores.map((s) => s.clerk_user_id));
  const mine = scores.find((s) => s.clerk_user_id === me) || null;
  const results = scores.map((s) => ({ username: names[s.clerk_user_id] || "student", team: s.team, score: Number(s.score), total: Number(s.total), you: s.clerk_user_id === me,
      badge: flair[s.clerk_user_id]?.badge || null, rank: flair[s.clerk_user_id]?.rank ?? null }))
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

// ── Closed-app push (study reminders) ───────────────────────────────────────
// Reminder eligibility, inlined here rather than imported from src/ so this
// critical function never depends on cross-boundary bundling. Mirrors the
// tested reference in src/lib/reminders.js (kept in sync; smoke tests guard it).
function reminderFor(blob, nowMs = Date.now()) {
  const b = blob && typeof blob === "object" ? blob : {};
  const cards = Array.isArray(b.cards) ? b.cards : [];
  const dueCount = cards.filter((c) => c && typeof c.due === "number" && c.due <= nowMs).length;
  const streak = Math.max(0, Math.round(Number(b.stats?.streak) || 0));
  return { send: dueCount > 0, dueCount, streak };
}
function reminderText(info, t = {}) {
  const due = Math.max(0, Math.round(Number(info?.dueCount) || 0));
  const base = due === 1
    ? (t.pushDueOne || "1 review is due. Keep it fresh.")
    : (t.pushDueMany || "{n} reviews are due. Keep them fresh.").replace("{n}", due);
  if (info && info.streak > 0) {
    return (t.pushStreak || "{msg} Don't lose your {d}-day streak.").replace("{msg}", base).replace("{d}", info.streak);
  }
  return base;
}
// VAPID is configured from env; when the keys are absent the whole push path
// stays inert (subscriptions can still be stored, but nothing is ever sent).
let vapidReady = null;
function ensureVapid() {
  if (vapidReady !== null) return vapidReady;
  const pub = process.env.VAPID_PUBLIC_KEY, priv = process.env.VAPID_PRIVATE_KEY, subj = process.env.VAPID_SUBJECT;
  if (!pub || !priv || !subj) { vapidReady = false; return false; }
  try { webpush.setVapidDetails(subj, pub, priv); vapidReady = true; } catch { vapidReady = false; }
  return vapidReady;
}
async function sendPush(sub, payload) {
  try {
    await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify(payload));
    return true;
  } catch (e) {
    // 404/410 = the browser dropped this subscription; forget it so we stop trying.
    if (e && (e.statusCode === 404 || e.statusCode === 410)) { try { await sql`DELETE FROM push_subs WHERE endpoint=${sub.endpoint}`; } catch { /* ignore */ } }
    return false;
  }
}
// A push subscription's endpoint is a URL the server later POSTs to (on every
// reminder), so it must be a real browser push service, not an arbitrary or
// internal address. Allowlist the known services so this can't be used as an
// SSRF probe. These cover every mainstream browser; add a host here if a new
// push service appears.
const PUSH_HOSTS = [
  "fcm.googleapis.com",          // Chrome / Chromium / Edge / Brave / Opera
  ".push.services.mozilla.com",  // Firefox
  ".notify.windows.com",         // legacy WNS (older Edge)
  "web.push.apple.com",          // Safari / iOS web push
];
function isPushEndpoint(u) {
  try {
    const url = new URL(u);
    if (url.protocol !== "https:") return false;
    const h = url.hostname.toLowerCase();
    return PUSH_HOSTS.some((s) => (s[0] === "." ? h.endsWith(s) : h === s));
  } catch { return false; }
}
async function pushSubscribe(req, res, body, me) {
  const endpoint = clean(body.endpoint, 1000);
  const p256dh = clean(body.p256dh, 300);
  const auth = clean(body.auth, 300);
  if (!endpoint || !p256dh || !auth || !isPushEndpoint(endpoint)) return res.status(400).json({ error: "Bad subscription." });
  await sql`INSERT INTO push_subs (endpoint, clerk_user_id, p256dh, auth)
    VALUES (${endpoint}, ${me}, ${p256dh}, ${auth})
    ON CONFLICT (endpoint) DO UPDATE SET clerk_user_id=EXCLUDED.clerk_user_id, p256dh=EXCLUDED.p256dh, auth=EXCLUDED.auth`;
  return res.status(200).json({ ok: true });
}
async function pushUnsubscribe(req, res, body, me) {
  const endpoint = clean(body.endpoint, 1000);
  if (endpoint) await sql`DELETE FROM push_subs WHERE endpoint=${endpoint} AND clerk_user_id=${me}`;
  return res.status(200).json({ ok: true });
}
// Send a reminder to the caller's own devices right now, so they can confirm
// delivery the moment they enable it (no waiting for the daily cron).
async function pushTest(req, res, me) {
  if (!ensureVapid()) return res.status(200).json({ ok: false, reason: "not-configured" });
  const subs = await sql`SELECT endpoint, p256dh, auth FROM push_subs WHERE clerk_user_id=${me}`;
  let sent = 0;
  for (const s of subs) if (await sendPush(s, { title: "Revyy", body: "Reminders are on. We'll nudge you when reviews are due.", tag: "revyy-test", url: "/app" })) sent++;
  return res.status(200).json({ ok: sent > 0, sent });
}
// Daily cron: nudge subscribed learners who have reviews due, once per UTC day.
async function runReminders(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret || (req.headers.authorization || "") !== `Bearer ${secret}`) return res.status(401).json({ error: "unauthorized" });
  if (!ensureVapid()) return res.status(200).json({ ok: true, skipped: "vapid-not-configured" });
  const today = new Date().toISOString().slice(0, 10);
  const rows = await sql`SELECT s.endpoint, s.p256dh, s.auth, d.data
    FROM push_subs s JOIN study_data d ON d.clerk_user_id = s.clerk_user_id
    WHERE s.last_notified IS DISTINCT FROM ${today}::date`;
  let sent = 0;
  for (const r of rows) {
    const info = reminderFor(r.data, Date.now());
    if (!info.send) continue;
    if (await sendPush(r, { title: "Revyy", body: reminderText(info), tag: "revyy-due", url: "/app" })) {
      await sql`UPDATE push_subs SET last_notified=${today}::date WHERE endpoint=${r.endpoint}`;
      sent++;
    }
  }
  return res.status(200).json({ ok: true, sent, considered: rows.length });
}

export default async function handler(req, res) {
  try {
    await ensureTables();

    // Daily reminder cron (Vercel Cron -> GET /api/study?cron=reminders). Auth is
    // the platform CRON_SECRET, not a user session. Parse the query straight from
    // the URL as well, so it also fires under the local dev shim (which, unlike
    // Vercel, does not populate req.query).
    const cronParam = req.query?.cron ?? new URLSearchParams((req.url || "").split("?")[1] || "").get("cron");
    if (req.method === "GET" && cronParam === "reminders") return runReminders(req, res);

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
      if (body?.action === "arenaContribute") return arenaContribute(req, res, body, userId);
      if (body?.action === "arenaBoard") return arenaBoard(req, res, userId);
      if (body?.action === "arenaSeason") return arenaSeasonBoard(req, res, userId);
      if (body?.action === "leagueBoard") return leagueBoard(req, res, userId);
      if (body?.action === "setBadge") return setBadge(req, res, body, userId);
      if (body?.action === "globalBoard") return globalBoard(req, res, userId);
      // Friends + study groups
      if (body?.action === "social") return socialOverview(req, res, userId);
      if (body?.action === "notifications") return notifications(req, res, userId);
      if (body?.action === "pushSubscribe") return pushSubscribe(req, res, body, userId);
      if (body?.action === "pushUnsubscribe") return pushUnsubscribe(req, res, body, userId);
      if (body?.action === "pushTest") return pushTest(req, res, userId);
      if (body?.action === "dmSend") return dmSend(req, res, body, userId);
      if (body?.action === "dmThread") return dmThread(req, res, body, userId);
      if (body?.action === "dmChallengeSubmit") return dmChallengeSubmit(req, res, body, userId);
      if (body?.action === "userSearch") return userSearch(req, res, body, userId);
      if (body?.action === "friendAdd") return friendAdd(req, res, body, userId);
      if (body?.action === "friendRespond") return friendRespond(req, res, body, userId);
      if (body?.action === "friendRemove") return friendRemove(req, res, body, userId);
      if (body?.action === "groupCreate") return groupCreate(req, res, body, userId);
      if (body?.action === "groupJoin") return groupJoin(req, res, body, userId);
      if (body?.action === "groupPreview") return groupPreview(req, res, body, userId);
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
    return res.status(500).json({ error: "Something went wrong. Please try again." });
  }
}
