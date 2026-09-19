// Server client for the mock-exam / Endless-Arena / social features, extracted
// from StudyQuiz.jsx: mock-section generation + crowd learning bank, arena draw
// and submit, and the one-call social API. Best-effort fetches that fail soft.
import { AI_MODEL } from "./constants.js";
import { stripFences, safeSvg } from "./helpers.js";
import { authHeader, readStream, deDash } from "./ai.js";
import { qhashOf } from "../lib/questionBank.js";

// Crash-safe mock-exam resume. An in-progress mock (any of the 8 exams) is
// mirrored to device storage in two keys: the heavy question set (rewritten only
// when it changes) and the light progress that changes often (answers, position,
// clock). A refresh, crash, or accidental exit can then be resumed. Cleared the
// instant the exam finishes or the user starts over. Stays on-device, never uploaded.
export const MOCK_LS_Q = "revyy_mock_q_v1";

export const MOCK_LS_P = "revyy_mock_p_v1";

export const MOCK_RESUME_TTL = 3 * 24 * 3600 * 1000; // stop offering a stale exam after 3 days

export function clearMockResume() {
  try { localStorage.removeItem(MOCK_LS_Q); localStorage.removeItem(MOCK_LS_P); } catch { /* ignore */ }
}

// Light record only (which exam + where they are), enough for the "Continue" card.
export function readMockProgress() {
  try {
    if (!localStorage.getItem(MOCK_LS_Q)) return null;
    const p = JSON.parse(localStorage.getItem(MOCK_LS_P) || "null");
    if (!p || typeof p.secIdx !== "number") return null;
    if (p.savedAt && Date.now() - p.savedAt > MOCK_RESUME_TTL) { clearMockResume(); return null; }
    return p;
  } catch { return null; }
}

// Full record (question set + progress), for actually continuing.
export function readMockResume() {
  try {
    const e = JSON.parse(localStorage.getItem(MOCK_LS_Q) || "null");
    const p = JSON.parse(localStorage.getItem(MOCK_LS_P) || "null");
    if (!e || !e.mock || !Array.isArray(e.mock.sections) || !e.mock.sections.length || !p) return null;
    if (p.savedAt && Date.now() - p.savedAt > MOCK_RESUME_TTL) { clearMockResume(); return null; }
    return { mock: e.mock, tilt: e.tilt, p };
  } catch { return null; }
}

// A one-sentence answer justification never legitimately second-guesses itself.
// When the model writes "... = $70.50. Wait, let me recalculate: 0.80 x 85 = 68"
// it has almost always keyed the FIRST (wrong) option and landed on a different
// value in the text, so the answer key is wrong. Drop any question whose
// explanation shows that self-correction rather than ship a mis-keyed one.
const RECONSIDERS = /\b(wait|hold on|scratch that|oops)\b|on second thought|let me (re-?calculat|recomput|redo|re-?check|try that)|recalculat|recomput|i made an? (error|mistake)|\bmy mistake\b|correction:|actually,\s+(i|it|the|that|no)\b/i;

// Keep only well-formed MCQs (a ballooning or self-correcting explanation signals
// the model could not solve it cleanly, drop those rather than ship a mis-keyed
// question).
export function sanitizeMockQs(qs) {
  return (Array.isArray(qs) ? qs : []).filter((q) =>
    q && typeof q.question === "string" && q.question.length > 2 &&
    Array.isArray(q.options) && q.options.length >= 2 &&
    q.options.every((o) => typeof o === "string" && o.trim().length) &&
    Number.isInteger(q.correct) && q.correct >= 0 && q.correct < q.options.length &&
    String(q.explanation || "").length <= 400 &&
    !RECONSIDERS.test(String(q.explanation || ""))
  ).map((q) => {
    const svg = safeSvg(q.svg);
    const base = { question: deDash(q.question), options: q.options.map(deDash), correct: q.correct, explanation: deDash(q.explanation) };
    // Per-question stimulus (SAT/PSAT R&W, GRE/GMAT Verbal RC): kept so the runner
    // can show it in the left panel beside the question, like the real test.
    const passage = typeof q.passage === "string" ? deDash(q.passage.trim()).slice(0, 1400) : "";
    const withSvg = svg ? { ...base, svg } : base;
    return passage ? { ...withSvg, passage } : withSvg;
  });
}

// Generate one chunk of a standardized mock section (no upload), authentic
// style. Standalone sections return { format:"standalone", questions }.
// Passage / English sections return { format, passage, svg, questions } where
// the questions all belong to that ONE passage; English passages carry the
// revised portions wrapped in <u>…</u> in reading order (one per question),
// which the runner renders as real underlines. `n` = how many questions to write.
export async function callMockSection(exam, section, tilt, exemplars = [], avoid = [], n) {
  const fmt = section.format || "standalone";
  const nOpt = section.options || 4;
  const count = n || section.count;
  const optTemplate = Array(nOpt).fill('"..."').join(",");
  // Standalone sections whose real test shows the reading text in a LEFT panel
  // beside the question (SAT/PSAT R&W always; GRE/GMAT Verbal only for the
  // reading-comprehension items). The model returns the text in a per-question
  // "passage" field, kept out of the stem, so the runner can split the view.
  const wantsStimulus = section.stimulus === true;
  const optStimulus = section.stimulus === "optional";
  const stimRule = wantsStimulus
    ? ` SPLIT LAYOUT: put the short text each question is based on in a separate "passage" field (the 1-3 sentence passage, poem, or notes excerpt), and keep "question" as ONLY the question itself (e.g. "Which choice best states the main purpose of the text?"). It renders in a panel beside the question, exactly like the real test, so EVERY question must have a non-empty "passage" and the question must NOT repeat that text.`
    : optStimulus
    ? ` SPLIT LAYOUT: for reading-comprehension items, put the passage in a separate "passage" field and keep "question" as only the question; for text-completion, vocabulary, sentence-equivalence or critical-reasoning items where the text IS the prompt, set "passage" to an empty string "".`
    : "";
  const stimField = (wantsStimulus || optStimulus) ? `"passage":"...",` : "";
  // Universal mock learning: a few good crowd-generated questions as STYLE
  // exemplars (never to copy) + recent flagged-bad stems to avoid.
  const exBlock = (exemplars && exemplars.length)
    ? `\nSTYLE EXAMPLES from our question bank of authentic ${exam.name} ${section.name} questions. Study their phrasing, difficulty, structure and format, then write BRAND NEW questions of the same quality. Do NOT copy, translate, or lightly reword them, they are references only:\n${exemplars.slice(0,3).map((q,i)=>`Example ${i+1}: ${JSON.stringify({question:String(q.question||"").slice(0,700),options:(Array.isArray(q.options)?q.options:[]).map(o=>String(o).slice(0,200))})}`).join("\n")}`
    : "";
  const avoidBlock = (avoid && avoid.length)
    ? `\nAVOID: learners flagged questions like these as flawed, mis-keyed or ambiguous. Do NOT produce anything similar:\n- ${avoid.slice(0,4).map(s=>String(s).slice(0,160)).join("\n- ")}`
    : "";
  // Real standardized tests are demanding; the app never generates a soft form.
  // "harder" leans into the top of the authentic range, "standard" is a genuine
  // full-difficulty paper. Neither is easy.
  const tiltLine = tilt === "harder"
    ? "OVERALL DIFFICULTY: a hard authentic form, lean toward the most challenging real question types with subtle, close distractors and multi-step reasoning."
    : "OVERALL DIFFICULTY: a genuine full-difficulty form, matching the real exam's hardest sittings, with a strong share of demanding questions.";
  // Realism/difficulty mandate on EVERY mock, so a form never comes out soft.
  const realismLine = `REALISM: this must be indistinguishable from a real ${exam.name} in difficulty and style. Real ${exam.name} questions are demanding, multi-step, and full of close distractors. Do NOT write easy, obvious, filler, or pure-recall questions, and no throwaway options; every question and every distractor must be one that could genuinely appear on the actual exam.`;
  const instr = String(section.instr || "").replace(/\{N\}/g, count);
  // Sections where the REAL test regularly shows figures (math / quant / data /
  // science): push the model to actually DRAW them, not just "when needed". A
  // hard minimum count is what actually moves the model (tested: ~9% -> ~40%).
  const wantsFigures = /math|quant|qr|di|science|cp|bb|ps|dm/i.test(section.id);
  const kFig = wantsFigures ? Math.max(2, Math.round(count * 0.3)) : 0;
  const svgRules = "SVG RULES: each \"svg\" is a SELF-CONTAINED <svg viewBox='...'>...</svg> using ONLY <line>/<rect>/<circle>/<polygon>/<path>/<text>, with clear labels and SINGLE quotes for every attribute (e.g. <circle cx='50' cy='50' r='40'/>) so the JSON stays valid, NEVER use double quotes inside the svg. No <script>, event handlers, external images, links, or fonts.";

  let prompt, maxTokens;
  if (fmt === "english" || fmt === "passage") {
    const rule = fmt === "english"
      ? `The "passage" MUST contain EXACTLY ${count} portions wrapped in <u>...</u> (use the <u> tag ONLY for these revised portions), and there MUST be EXACTLY ${count} questions in the SAME order: question i revises the i-th underlined portion, and its first option is usually "NO CHANGE".`
      : `Write EXACTLY ${count} questions, all about this ONE passage.`;
    const figRule = wantsFigures
      ? `FIGURE IS MANDATORY: real ${exam.name} ${section.name} is built around data. You MUST include a top-level inline "svg" figure, an accurate graph, chart, data table, or labelled scientific diagram, drawn to real numbers, that the questions genuinely read from. A ${section.name} set with no figure is unacceptable.\n${svgRules}`
      : `Add a top-level inline "svg" only if a figure is truly needed; ${svgRules}`;
    prompt = `You are writing a realistic ${exam.name} ${section.name} passage set that should be indistinguishable from a genuine ${exam.name}. Draw on real ${exam.name} passages, past papers and official practice tests.
${instr}
${rule}
${tiltLine}
${realismLine}
Each question has "options" (EXACTLY ${nOpt} choices), "correct" (the 0-based index of the ONE correct option, which you work out carefully first), and "explanation" (one short sentence). The "explanation" must be a single clean final sentence and must NEVER second-guess or recalculate itself (no "wait", "let me recalculate", "actually"); if you catch a mistake while writing it, fix the "correct" index so it matches, do not narrate the correction. Make distractors close and genuinely ${exam.name}-hard, not trivial.
${figRule}${exBlock}${avoidBlock}
Return ONLY raw JSON, no markdown: {"passage":"the full passage text${fmt==="english"?", with the revised portions wrapped in <u>...</u> in reading order":""}","svg":"OPTIONAL inline <svg>…</svg>","questions":[{"question":"...","options":[${optTemplate}],"correct":0,"explanation":"..."}]}`;
    maxTokens = Math.min(count * 450 + 7000, 40000);
  } else {
    prompt = `You are assembling a realistic ${exam.name} ${section.name} section that should feel indistinguishable from a genuine ${exam.name} form. Draw on your knowledge of actual ${exam.name} exams, real past papers and official practice tests. Match the authentic topics, difficulty spread, phrasing and formats faithfully.
${instr}
Provide EXACTLY ${count} multiple-choice questions.
${wantsFigures ? `\nFIGURES ARE MANDATORY: a real ${exam.name} ${section.name} form is full of diagrams. AT LEAST ${kFig} of the ${count} questions MUST be geometry, coordinate-geometry, trigonometry, or data-interpretation questions, and EACH of those MUST carry an accurate inline "svg" figure the question genuinely depends on (a triangle/circle/polygon with labelled sides or angles, a coordinate plane with plotted points/lines/parabolas, a number line, or a bar/line/scatter chart). Draw each figure to the EXACT numbers in the question and consistent with the correct answer. Fewer than ${kFig} figures does NOT look like a real ${exam.name} and is unacceptable. Purely algebraic or arithmetic questions need no figure.\n${svgRules}\n` : ""}
${tiltLine} Vary difficulty across the real exam's hard range, but never make a question easy.
${realismLine}
Each question object: "question" (${(wantsStimulus||optStimulus) ? `only the question itself, with any reading text placed in "passage" instead of here` : "the full stem, with any context written into it"}), "options" (EXACTLY ${nOpt} choices), "correct" (0-based index of the ONE correct option), "explanation" (one short sentence)${wantsFigures ? `, and "svg" (the figure, or omit it for a figure-free question)` : ""}. CRITICAL: work every calculation out FIRST, then key the matching option; double-check numbers and units. Exactly ONE correct option each; discard any you are not certain of. The "explanation" must be a single clean final sentence and must NEVER second-guess or recalculate itself (no "wait", "let me recalculate", "actually"); if you catch a mistake while writing it, fix the "correct" index so it matches the value you land on, do not narrate the correction.${stimRule}${exBlock}${avoidBlock}
Return ONLY raw JSON, no markdown: {"questions":[{${stimField}"question":"...","options":[${optTemplate}],"correct":0,"explanation":"..."${wantsFigures ? `,"svg":"<svg viewBox='0 0 200 200'>…</svg> only when the question needs a figure"` : ""}}]}
The "questions" array MUST contain ${count} items${wantsFigures ? `, at least ${kFig} of them with an "svg"` : ""}.`;
    // Figure-heavy sections run longer (each SVG is ~500-1000 tokens), so give
    // them more headroom to avoid truncating a chunk mid-figure.
    maxTokens = Math.min(count * (wantsFigures ? 750 : 500) + 4000, 64000);
  }

  const res = await fetch("/api/anthropic", {
    method:"POST", headers:{"Content-Type":"application/json", ...(await authHeader())},
    body: JSON.stringify({ model:AI_MODEL, max_tokens:maxTokens,
      system:"You are an expert standardized-test writer. Return ONLY valid raw JSON, no markdown.",
      messages:[{ role:"user", content:[{type:"text",text:prompt}] }] }),
  });
  if (!res.ok) { const e=await res.json().catch(()=>({})); throw new Error(e.error?.message||`Error ${res.status}`); }
  const raw = stripFences(await readStream(res));
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch {
    const cut = raw.lastIndexOf("}");
    try { parsed = JSON.parse(raw.slice(0, cut + 1) + "]}"); } catch { parsed = {}; }
  }
  const questions = sanitizeMockQs(parsed.questions);
  if (fmt === "english" || fmt === "passage") {
    return { format: fmt, passage: deDash(String(parsed.passage || "").slice(0, 9000)), svg: safeSvg(parsed.svg), questions };
  }
  return { format: "standalone", passage: "", svg: "", questions };
}

// Build a WHOLE mock section to the real question count, ready for the runner.
// Everything is generated UPFRONT (during the load screen, before the section
// timer starts) so the timed run never stalls mid-section. Calls run in PARALLEL
// so a full 50-question, 5-passage section loads in roughly one call's time.
// Standalone sections batch into chunks (a single call under-delivers a big
// count); passage/English sections split into passages (capped) and each
// question is tagged with its passage so the runner keeps it on screen.
export const MOCK_CHUNK = 25;      // standalone questions per parallel call

export const MOCK_MAX_PASSAGES = 6; // cap passages per section so the load stays bounded

export async function buildMockSection(exam, section, tilt) {
  const fmt = section.format || "standalone";
  if (fmt === "standalone") {
    const nChunks = Math.max(1, Math.ceil(section.count / MOCK_CHUNK));
    const sizes = [];
    for (let i = 0, rem = section.count; i < nChunks; i++) { const n = Math.min(MOCK_CHUNK, rem); if (n <= 0) break; sizes.push(n); rem -= n; }
    const { exemplars, avoid } = await mockDrawGlobal(exam.name, section.name);
    const results = await Promise.all(sizes.map((n) => callMockSection(exam, section, tilt, exemplars, avoid, n).catch(() => ({ questions: [] }))));
    const seen = new Set(); const out = [];
    // Dedup on stimulus + question: with the passage split out, the bare question
    // ("Which choice completes the text...") repeats across items, so keying on
    // the question alone would wrongly drop valid ones.
    for (const r of results) for (const q of (r.questions || [])) { const k = (String(q.passage || "") + "||" + String(q.question || "")).toLowerCase().trim(); if (k && !seen.has(k)) { seen.add(k); out.push(q); } }
    // If chunks fell short (a failed batch or duplicates), top the shortfall up
    // once so the section keeps its authentic length. Fail-soft: any error just
    // leaves it slightly short, which still scores fairly against its own count.
    const short = section.count - out.length;
    if (short > 0 && out.length > 0) {
      const top = [];
      for (let rem = short; rem > 0; rem -= MOCK_CHUNK) top.push(Math.min(MOCK_CHUNK, rem));
      const more = await Promise.all(top.map((n) => callMockSection(exam, section, tilt, exemplars, avoid, n).catch(() => ({ questions: [] }))));
      for (const r of more) for (const q of (r.questions || [])) { const k = (String(q.passage || "") + "||" + String(q.question || "")).toLowerCase().trim(); if (k && !seen.has(k)) { seen.add(k); out.push(q); } }
    }
    // A per-question stimulus (SAT/PSAT R&W, GRE/GMAT Verbal RC) becomes the
    // left-panel passage so the runner shows the real two-panel layout; any
    // figure moves into that panel with its text. Items with no stimulus stay
    // single-column, exactly as those questions look on the real test.
    const tagged = out.map((q, i) => q.passage
      ? { ...q, passage: undefined, svg: "", _passage: q.passage, _psvg: q.svg || "", _pIdx: i }
      : q);
    mockContributeGlobal(exam.name, section.name, tagged);
    return tagged.slice(0, section.count);
  }
  const size = section.passageSize || section.count;
  const groups = Math.min(MOCK_MAX_PASSAGES, Math.max(1, Math.ceil(section.count / size)));
  const needs = [];
  for (let g = 0, rem = section.count; g < groups; g++) { const n = Math.min(size, rem); if (n <= 0) break; needs.push(n); rem -= n; }
  // Passage sections also learn globally: steer with the crowd's avoid-list (and
  // style exemplars), and contribute the questions back for everyone.
  const { exemplars, avoid } = await mockDrawGlobal(exam.name, section.name);
  const results = await Promise.all(needs.map((n) => callMockSection(exam, section, tilt, exemplars, avoid, n).catch(() => null)));
  // Retry any passage group that came back empty, once, so a transient failure on
  // one passage doesn't silently drop a chunk of the section. Fail-soft.
  const failed = results.map((r, i) => (!r || !r.questions?.length) ? i : -1).filter((i) => i >= 0);
  if (failed.length) {
    const retried = await Promise.all(failed.map((i) => callMockSection(exam, section, tilt, exemplars, avoid, needs[i]).catch(() => null)));
    failed.forEach((i, k) => { if (retried[k]?.questions?.length) results[i] = retried[k]; });
  }
  const out = [];
  results.forEach((r, g) => {
    if (!r || !r.questions.length) return;
    let qs = r.questions;
    // English: keep at most as many questions as there are <u> underlines so the
    // question<->underline mapping stays 1:1.
    const uCount = fmt === "english" ? (r.passage.match(/<u>/gi) || []).length : 0;
    if (fmt === "english" && uCount) qs = qs.slice(0, uCount);
    qs.forEach((q, i) => out.push({ ...q, _passage: r.passage, _psvg: r.svg, _pIdx: g, _uIdx: fmt === "english" ? i : null }));
  });
  mockContributeGlobal(exam.name, section.name, out);
  return out.slice(0, section.count);
}

// Thin best-effort calls to the /api/study mock endpoints. Every one fails soft:
// the mock flow must never break because the shared bank is unreachable. Keyed
// by exam + section names (general test knowledge, never user material).
export async function mockDrawGlobal(exam, section) {
  try {
    const res = await fetch("/api/study", { method:"POST", headers:{"Content-Type":"application/json", ...(await authHeader())},
      body: JSON.stringify({ action:"mockDraw", exam, section }) });
    if (!res.ok) return { exemplars: [], avoid: [] };
    const j = await res.json().catch(() => ({}));
    return { exemplars: Array.isArray(j.exemplars) ? j.exemplars : [], avoid: Array.isArray(j.avoid) ? j.avoid : [] };
  } catch { return { exemplars: [], avoid: [] }; }
}

export async function mockContributeGlobal(exam, section, questions) {
  try {
    // Send LEAN, FLAT items (the shape the server validates). We deliberately
    // drop passage text and per-question layout fields: the bank only needs the
    // question, so this keeps the payload small and stores no passage material.
    const items = (questions || [])
      .filter((q) => q && q.question && Array.isArray(q.options) && q.options.length >= 2)
      .map((q) => ({ qhash: qhashOf(q.question), question: q.question, options: q.options, correct: q.correct, explanation: q.explanation, svg: q.svg }))
      .slice(0, 60);
    if (!items.length) return;
    await fetch("/api/study", { method:"POST", headers:{"Content-Type":"application/json", ...(await authHeader())},
      body: JSON.stringify({ action:"mockContribute", exam, section, items }) });
  } catch { /* best effort */ }
}

export async function mockFlagGlobal(exam, section, question) {
  try {
    await fetch("/api/study", { method:"POST", headers:{"Content-Type":"application/json", ...(await authHeader())},
      body: JSON.stringify({ action:"mockFlag", exam, section, qhash: qhashOf(question) }) });
  } catch { /* best effort */ }
}

export async function arenaDrawGlobal() {
  try {
    const res = await fetch("/api/study", { method:"POST", headers:{"Content-Type":"application/json", ...(await authHeader())}, body: JSON.stringify({ action:"arenaDraw" }) });
    if (!res.ok) return [];
    const j = await res.json().catch(() => ({}));
    // Sort ascending by difficulty so a run ramps easy -> hard.
    return (Array.isArray(j.questions) ? j.questions : []).slice().sort((a, b) => (a.difficulty || 0) - (b.difficulty || 0));
  } catch { return []; }
}

export async function arenaSubmitGlobal(result) {
  try {
    const res = await fetch("/api/study", { method:"POST", headers:{"Content-Type":"application/json", ...(await authHeader())}, body: JSON.stringify({ action:"arenaSubmit", ...result }) });
    if (!res.ok) return null;
    return await res.json().catch(() => null);
  } catch { return null; }
}

export async function arenaBoardGlobal() {
  try {
    const res = await fetch("/api/study", { method:"POST", headers:{"Content-Type":"application/json", ...(await authHeader())}, body: JSON.stringify({ action:"arenaBoard" }) });
    if (!res.ok) return null;
    return await res.json().catch(() => null);
  } catch { return null; }
}

export async function arenaSeasonGlobal() {
  try {
    const res = await fetch("/api/study", { method:"POST", headers:{"Content-Type":"application/json", ...(await authHeader())}, body: JSON.stringify({ action:"arenaSeason" }) });
    if (!res.ok) return null;
    return await res.json().catch(() => null);
  } catch { return null; }
}

// Convert a generated MCQ into the Endless-Arena question shape: the fixed
// correct answer + a small distractor pool, plus a per-question difficulty that
// ramps up with position so a subject run gets harder as it goes. Null if malformed.
export function toArenaQ(q, i, total, category) {
  const opts = Array.isArray(q?.options) ? q.options.filter((o) => typeof o === "string" && o.trim()) : [];
  const ci = Number(q?.correct);
  if (opts.length < 3 || !Number.isInteger(ci) || ci < 0 || ci >= opts.length) return null;
  const correct = opts[ci];
  const distractors = opts.filter((_, idx) => idx !== ci).map((text) => ({ text, close: 0.55 }));
  const difficulty = Math.max(1, Math.min(5, 1.6 + (total > 1 ? i / (total - 1) : 0) * 2.8)); // ~1.6 -> ~4.4 ramp
  return { id: "subj_" + i, category: category || "", question: String(q?.question || ""), correct, distractors, difficulty: Math.round(difficulty * 100) / 100 };
}

// One call for any social action; returns the parsed JSON or {error}.
export async function socialApi(action, payload = {}) {
  try {
    const res = await fetch("/api/study", { method:"POST", headers:{"Content-Type":"application/json", ...(await authHeader())}, body: JSON.stringify({ action, ...payload }) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) return { error: j.error || "Something went wrong." };
    return j;
  } catch { return { error: "Network error, try again." }; }
}

// The sender's challenge activity: quizzes they shared that others have taken.
export async function fetchMyChallenges() {
  try {
    const res = await fetch("/api/study", { method:"POST", headers:{"Content-Type":"application/json", ...(await authHeader())},
      body: JSON.stringify({ action:"myChallenges" }) });
    if (!res.ok) return [];
    const j = await res.json().catch(() => ({}));
    return Array.isArray(j.challenges) ? j.challenges : [];
  } catch { return []; }
}
