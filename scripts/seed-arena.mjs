// Seed the Endless Arena's base pool (gk_pool) with fresh, BALANCED general-
// knowledge trivia: an equal number of questions per topic across a broad set of
// categories, so the pool never leans toward any one subject.
//
// Generates with Claude Haiku, sanitizes, de-dupes against what's already in the
// pool, and inserts. Re-runnable (ON CONFLICT DO NOTHING + text de-dupe), so
// running it again just tops the pool up.
//
//   node scripts/seed-arena.mjs [perCategory]     (default 20 per category)
//
// Needs DATABASE_URL + ANTHROPIC_API_KEY (read from the environment or ./.env).

import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";

// ── env ──────────────────────────────────────────────────────────────────────
const env = {};
try {
  for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch { /* rely on process.env */ }
const DATABASE_URL = process.env.DATABASE_URL || env.DATABASE_URL;
const KEY = process.env.ANTHROPIC_API_KEY || env.ANTHROPIC_API_KEY;
if (!DATABASE_URL || !KEY) { console.error("Missing DATABASE_URL or ANTHROPIC_API_KEY (env or .env)."); process.exit(1); }
const sql = neon(DATABASE_URL);

// ── balanced category set (equal weight each) ─────────────────────────────────
const CATEGORIES = [
  "Science", "History", "Geography", "Sports", "Music", "Film and Television",
  "Literature", "Art", "Food and Drink", "Animals and Nature", "Space and Astronomy",
  "Technology and Computing", "Mythology and Religion", "World Cultures", "Language and Words",
  "General Knowledge",
];
const PER_CATEGORY = Math.max(1, Math.min(40, parseInt(process.argv[2], 10) || 20));

// ── helpers (mirror the app) ──────────────────────────────────────────────────
const arenaHash = (q) => "u" + (Math.abs([...String(q || "").toLowerCase().replace(/\s+/g, " ").trim()]
  .reduce((h, c) => (h * 33 + c.charCodeAt(0)) | 0, 5381)) >>> 0).toString(36);
const normQ = (q) => String(q || "").toLowerCase().replace(/\s+/g, " ").trim();
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

async function generate(category, n) {
  const prompt =
    `Generate exactly ${n} general-knowledge TRIVIA multiple-choice questions about "${category}". Rules: ` +
    "each is a self-contained trivia question answerable on its own (no passages, images or context); clear, natural English; " +
    "exactly ONE unambiguous correct answer; provide FIVE plausible but clearly wrong distractor options (all different from each other and from the answer); " +
    "keep answers short (a word or short phrase); mix difficulty across the set (easy, medium and hard); no duplicates; no offensive content. " +
    'Return ONLY raw JSON, no markdown: [{"question":"...","correct":"...","distractors":["w1","w2","w3","w4","w5"],"difficulty":N}] where N is 1 (very easy) to 5 (very hard).';
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 6000, system: "You are a trivia author. Return only raw JSON.", messages: [{ role: "user", content: [{ type: "text", text: prompt }] }] }),
  });
  if (!r.ok) { console.error(`  [${category}] API ${r.status}`); return []; }
  const j = await r.json();
  let text = (j.content || []).map((b) => b.text || "").join("").trim().replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
  const cut = text.lastIndexOf("]"); if (cut > 0) text = text.slice(0, cut + 1);
  try { return JSON.parse(text); } catch { console.error(`  [${category}] parse failed`); return []; }
}

// keep only well-formed, 4-distinct-option, English-ish trivia
function sanitize(item, category) {
  const question = String(item?.question || "").trim();
  const correct = String(item?.correct || "").trim();
  let distractors = Array.isArray(item?.distractors) ? item.distractors.map((d) => String(d || "").trim()).filter(Boolean) : [];
  if (question.length < 8 || question.length > 320 || !correct) return null;
  // unique options, answer not among distractors
  const seen = new Set([correct.toLowerCase()]);
  distractors = distractors.filter((d) => { const k = d.toLowerCase(); if (seen.has(k) || d.length > 120) return false; seen.add(k); return true; });
  if (distractors.length < 3) return null;              // need at least 3 wrongs to serve
  const difficulty = clamp(Number(item?.difficulty) || 2, 1, 5);
  return {
    qhash: arenaHash(question),
    category: String(category || "general").toLowerCase(),
    question, correct,
    distractors: distractors.slice(0, 5).map((d) => ({ text: d, close: 0.5 })),
    difficulty,
  };
}

async function main() {
  const before = Number((await sql`SELECT COUNT(*)::int AS n FROM gk_pool`)[0]?.n || 0);
  console.log(`gk_pool has ${before} questions. Target: +${PER_CATEGORY} per category x ${CATEGORIES.length} categories.\n`);
  // Existing question text, to skip near-identical adds.
  const existing = new Set((await sql`SELECT question FROM gk_pool`).map((r) => normQ(r.question)));
  const perCat = {};
  let added = 0;
  for (const category of CATEGORIES) {
    const raw = await generate(category, PER_CATEGORY);
    const batchSeen = new Set();
    let n = 0;
    for (const item of raw) {
      const s = sanitize(item, category);
      if (!s) continue;
      const key = normQ(s.question);
      if (existing.has(key) || batchSeen.has(s.qhash)) continue;   // de-dupe vs pool + within batch
      batchSeen.add(s.qhash); existing.add(key);
      try {
        const ins = await sql`INSERT INTO gk_pool (qhash, category, question, correct, distractors, difficulty)
          VALUES (${s.qhash}, ${s.category}, ${s.question}, ${s.correct}, ${JSON.stringify(s.distractors)}::jsonb, ${s.difficulty})
          ON CONFLICT (qhash) DO NOTHING RETURNING id`;
        if (ins.length) { n++; added++; }
      } catch (e) { console.error(`  insert failed: ${e.message}`); }
    }
    perCat[category] = n;
    console.log(`  ${category.padEnd(26)} +${n}`);
  }
  const after = Number((await sql`SELECT COUNT(*)::int AS n FROM gk_pool`)[0]?.n || 0);
  console.log(`\nAdded ${added}. gk_pool: ${before} -> ${after}.`);
  console.log("Per category:", JSON.stringify(perCat));
}
main().catch((e) => { console.error(e); process.exit(1); });
