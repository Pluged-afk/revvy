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
        flags      INT         NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (exam, section, qhash)
      )`,
    ]).then(() => sql`CREATE INDEX IF NOT EXISTS mock_bank_bucket ON mock_bank (exam, section)`)
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
const MOCK_BANK_CAP = 300;    // questions kept per (exam, section) bucket
const examKey = (s) => clean(s, 40);
const sectionKey = (s) => clean(s, 60);

// Keep only a clean, well-formed MCQ, size-capped, with an optional safe SVG.
function sanitizeMockItem(x) {
  if (!x || typeof x !== "object") return null;
  const q = clean(x.question, 1200);
  if (q.length < 8) return null;
  const options = Array.isArray(x.options) ? x.options.slice(0, 8).map((o) => clean(o, 400)).filter(Boolean) : [];
  if (options.length < 2) return null;
  const correct = Number.isInteger(x.correct) && x.correct >= 0 && x.correct < options.length ? x.correct : null;
  if (correct == null) return null;
  const qhash = clean(x.qhash, 24) || String(Math.abs([...q.toLowerCase()].reduce((h, c) => (h * 33 + c.charCodeAt(0)) | 0, 5381)));
  const data = { question: q, options, correct, explanation: clean(x.explanation, 400) };
  const svg = typeof x.svg === "string" ? x.svg.trim() : "";
  if (/^<svg[\s>]/i.test(svg) && svg.length < 8000 && !/<script|<foreignobject|\son\w+\s*=|javascript:/i.test(svg)) data.svg = svg;
  return { qhash, data };
}

// Contribute freshly generated (filter-passed) questions to the global bank.
async function mockContribute(req, res, body) {
  const exam = examKey(body.exam), section = sectionKey(body.section);
  if (!exam || !section) return res.status(400).json({ error: "Missing exam/section." });
  const items = (Array.isArray(body.items) ? body.items : []).map(sanitizeMockItem).filter(Boolean).slice(0, 60);
  for (const it of items) {
    await sql`INSERT INTO mock_bank (exam, section, qhash, data) VALUES (${exam}, ${section}, ${it.qhash}, ${JSON.stringify(it.data)}::jsonb)
              ON CONFLICT (exam, section, qhash) DO UPDATE SET uses = mock_bank.uses + 1`;
  }
  // Prune the bucket: keep the best (fewest flags, most uses, newest), drop the rest.
  await sql`DELETE FROM mock_bank WHERE id IN (
    SELECT id FROM mock_bank WHERE exam = ${exam} AND section = ${section}
    ORDER BY flags ASC, uses DESC, created_at DESC OFFSET ${MOCK_BANK_CAP})`;
  return res.status(200).json({ ok: true, stored: items.length });
}

// Flag a mock question as bad (learner reported a problem). Feeds the avoid-list.
async function mockFlag(req, res, body) {
  const exam = examKey(body.exam), section = sectionKey(body.section), qhash = clean(body.qhash, 24);
  if (!exam || !section || !qhash) return res.status(400).json({ error: "Missing fields." });
  await sql`UPDATE mock_bank SET flags = flags + 1 WHERE exam = ${exam} AND section = ${section} AND qhash = ${qhash}`;
  return res.status(200).json({ ok: true });
}

// Draw a few good questions as STYLE exemplars + recent flagged stems to avoid,
// for the next generation of this exam section. Never returns exact copies to
// reuse; these only steer fresh generation.
async function mockDraw(req, res, body) {
  const exam = examKey(body.exam), section = sectionKey(body.section);
  if (!exam || !section) return res.status(400).json({ error: "Missing exam/section." });
  const good = await sql`SELECT data FROM mock_bank WHERE exam = ${exam} AND section = ${section} AND flags = 0 ORDER BY random() LIMIT 3`;
  const bad = await sql`SELECT data->>'question' AS q FROM mock_bank WHERE exam = ${exam} AND section = ${section} AND flags > 0 ORDER BY flags DESC, created_at DESC LIMIT 4`;
  return res.status(200).json({
    exemplars: good.map((r) => r.data).filter(Boolean),
    avoid: bad.map((r) => r.q).filter(Boolean),
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
      if (body?.action === "mockContribute") return mockContribute(req, res, body);
      if (body?.action === "mockFlag") return mockFlag(req, res, body);
      if (body?.action === "mockDraw") return mockDraw(req, res, body);

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
