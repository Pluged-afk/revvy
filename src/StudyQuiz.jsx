import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { LANGS } from "./i18n.js";
import { useAuth } from "./context/AuthContext.jsx";
import { useLang } from "./context/LanguageContext.jsx";
import { useDev, DevBadge } from "./context/DevContext.jsx";
import { useClerk } from "@clerk/clerk-react";
import { useNavigate } from "react-router-dom";
import { upload as blobUpload } from "@vercel/blob/client";
import { useAdUnlocks } from "./lib/adUnlocks.js";
import { useSRS, toCard } from "./lib/srs.js";
import { useStudyStats } from "./lib/stats.js";
import { usePlans } from "./context/StudyContext.jsx";
import { buildPlan, parseChapters, planProgress, nextDayIndex, isPlanComplete, dayState } from "./lib/planner.js";
import { computeReadiness, weakTopics, topicMastery } from "./lib/insights.js";
import { recommendDifficulty, buildLearnerBrief, resultNudge } from "./lib/studentModel.js";
import { makeBankItem, bankPick, buildAvoidNote, qhashOf } from "./lib/questionBank.js";
import { makeLibraryDoc, buildLibraryMaterial, librarySize } from "./lib/studyLibrary.js";
import { MOCK_EXAMS, getMock, mockTotalMinutes, mockTotalQuestions, scoreMock, routeFor, routeTilt, stage1IndexFor } from "./lib/mockExams.js";
import Icon from "./components/Icon.jsx";

// Clean line icons for the home "what you can upload" grid, matched to the
// fixed feature order (PDF, Images, Text, Quiz types, Explanations, Languages)
// so we don't depend on the emoji stored in the translation data.
const FEAT_ICONS = ["notes", "camera", "pencil", "layers", "chat", "globe"];

// Strip a leading emoji (and its trailing space) from a translated label so we
// can show a clean SVG icon in front of it instead. Leaves the words intact.
const stripEmoji = (s) => String(s ?? "").replace(/^[\u{1F000}-\u{1FAFF}☀-➿⬀-⯿←-⇿️‍\s]+/u, "").trim();
// Icon per upload tab id (labels come from the translation data with emoji).
const TAB_ICONS = { file: "folder", text: "pencil", photo: "camera", media: "play" };
// Parse a pasted Quizlet export into flashcards. Quizlet separates term from
// definition with a Tab (or comma) and cards with a newline (or semicolon); we
// split on the FIRST separator per row so definitions keep their own commas.
// Pure string work, no URL, no network, no fetch: none of the link-import risk.
function parseQuizlet(text) {
  const raw = String(text || "").trim();
  if (!raw) return [];
  const rows = raw.includes("\n") ? raw.split(/\r?\n+/) : raw.split(/;+/);
  const cards = [];
  for (const row of rows) {
    const line = row.trim();
    if (!line) continue;
    let m = line.match(/^([^\t]+)\t+(.+)$/);      // term<TAB>definition
    if (!m) m = line.match(/^(.+?) {2,}(.+)$/);    // term<2+ spaces>definition
    if (!m) m = line.match(/^([^,]+),\s*(.+)$/);   // term,definition
    if (!m) continue;
    const term = m[1].trim(), def = m[2].trim();
    if (term && def) cards.push({ question: term, answer: def, topic: "" });
    if (cards.length >= 300) break; // sane cap
  }
  return cards;
}
// Audio / video containers we accept for lecture transcription (Pro). Broad on
// purpose; the transcriber pulls the audio out of whatever container it gets.
const MEDIA_MAX_MB = 100;

// Phone-style light/dark toggle: moon on the left, sun on the right, a knob that
// slides to the side you're on (left = dark, right = light). `onDark` styles it
// for a dark surface (the app hero); otherwise it uses theme tokens.
function ThemeSwitch({ isDark, onToggle, onDark }) {
  const track = onDark
    ? { background: "rgba(255,255,255,0.16)", border: "1px solid rgba(255,255,255,0.32)" }
    : { background: "var(--color-background-secondary)", border: "1px solid var(--color-border-secondary)" };
  const dim = onDark ? "rgba(255,255,255,0.6)" : "var(--color-text-tertiary)";
  return (
    <button type="button" role="switch" aria-checked={isDark} aria-label="Toggle dark mode"
      title={isDark ? "Switch to light mode" : "Switch to dark mode"} onClick={onToggle}
      style={{ position: "relative", width: 54, height: 30, borderRadius: 999, padding: 0, cursor: "pointer", flexShrink: 0, ...track }}>
      <span style={{ position: "absolute", left: 8, top: "50%", transform: "translateY(-50%)", display: "flex", color: dim, pointerEvents: "none" }}><Icon name="moon" size={13} /></span>
      <span style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", display: "flex", color: dim, pointerEvents: "none" }}><Icon name="sun" size={13} /></span>
      <span style={{ position: "absolute", top: 3, left: isDark ? 3 : 27, width: 24, height: 24, borderRadius: "50%", background: "#fff", color: "#4338ca", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 1px 3px rgba(0,0,0,0.28)", transition: "left .2s ease" }}>
        <Icon name={isDark ? "moon" : "sun"} size={13} />
      </span>
    </button>
  );
}

// ── Limits ────────────────────────────────────────────────────────────
const FREE_MAX_Q   = 20;
const AD_MAX_Q     = 50;
const PRO_MAX_Q    = 100;
const FREE_FILE_MB = 5;
const AD_FILE_MB   = 10;
const PRO_FILE_MB  = 999;
// How many files one quiz / exam may draw from. Free stays tight (1 for a quiz,
// 5 for an exam); Pro can attach many, capped at a generous-but-realistic number
// so a single generation can't balloon past sane context limits.
const QUIZ_FILES_PRO  = 20;
const EXAM_FILES_FREE = 5;
const EXAM_FILES_PRO  = 20;
const AD_HOURS     = 1;
const FREE_DAILY   = 50;  // free daily QUESTION allowance (shown in plan lists)
const Q_FREE       = [5, 10, 15, 20];
const Q_EXTRA      = [25, 30, 40, 50];
const QUIZ_TYPES   = ["mcq","cards","fill","match"];
const LETTERS      = ["A","B","C","D","E","F"];
// Phase 2: how many of a 10-question weak-spot drill may be reused from the
// learner's vetted bank (rest are freshly generated). Caps API cost saving at
// half so drills still feel fresh.
const DRILL_REUSE_MAX = 5;
// Model for all generation/grading. Haiku 4.5: cheap + fast, plenty for
// question writing. ($0.80/1M in, $4/1M out vs Sonnet's $3/$15.)
const AI_MODEL     = "claude-haiku-4-5-20251001";
// Difficulty rubric (index 0/1/2 = Easy/Normal/Hard). The label alone barely
// moves the model, the per-level guidance is what actually changes output.
// Calibrated from what students say they mean by each level: Easy = genuinely
// easy, Normal = the standard exam question they expect, Hard = deep and
// demanding but never tricky/gotcha/tedious. Difficulty comes from depth of
// reasoning and number of concepts connected, not from trap wording.
const DIFFICULTY = [
  { name:"Easy",   guide:"Genuinely easy. One core fact or definition per question, tested directly, in plain everyday wording. Recall or simple recognition (Bloom: Remember or Understand). One step, no calculation chains, no traps. The correct answer is obvious to anyone who read the material, and the other options are clearly wrong. Never obscure." },
  { name:"Normal", guide:"A standard, fair exam question, the level most students expect by default. Test real understanding and straightforward application (Bloom: Understand or Apply): connect two related ideas, apply a concept to a clear example, or take one clear reasoning step. Distractors should be genuinely plausible and reflect common honest misconceptions, not word games. Solid but not punishing." },
  { name:"Hard",   guide:"Genuinely hard through DEPTH, not trickery. Require multi-step reasoning, connecting several concepts, applying ideas to a NEW or unfamiliar scenario, or analysing and evaluating relationships and trade-offs (Bloom: Apply, Analyze or Evaluate). Distractors are close and demand careful discrimination by someone who truly understands. The challenge must come from how much thinking and how many concepts are needed, NEVER from gotcha wording, deliberate ambiguity, obscure trivia, or tedious busywork. A well-prepared student should still get it by reasoning carefully." },
];
const STRIPE_MONTHLY_PRICE = import.meta.env.VITE_STRIPE_MONTHLY_PRICE;
const STRIPE_YEARLY_PRICE  = import.meta.env.VITE_STRIPE_YEARLY_PRICE;

function getTodayStr() { return new Date().toLocaleDateString("en-US"); }
function fmtMB(bytes)  { return (bytes/1024/1024).toFixed(1)+"MB"; }
function fmtDate(iso)  {
  if (!iso) return "";
  try { return new Date(iso).toLocaleDateString(undefined,{year:"numeric",month:"long",day:"numeric"}); }
  catch { return ""; }
}
function msUntil(ts)   {
  const d = ts - Date.now();
  if (d <= 0) return null;
  const h = Math.floor(d/3600000), m = Math.floor((d%3600000)/60000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// Haptic feedback. navigator.vibrate exists only where the Vibration API is
// implemented, Android phones/tablets. iOS Safari and virtually all desktop
// browsers don't implement it, so this is a silent no-op there (exactly the
// "mobile/tablets only" behaviour we want). `.on` mirrors the user setting.
const Haptics = { on:false, buzz(ms=35){ try{ if(this.on && navigator.vibrate) navigator.vibrate(ms); }catch{ /* ignore */ } } };

// ── Translations ───────────────────────────────────────────────────────
// Strings live in ./i18n.js. `t` is resolved per-render from the `lang`
// state inside StudyQuiz via getTranslations(lang).

// ── Sound engine (Web Audio API) ─────────────────────────────────────
const SoundEngine = (() => {
  let ctx = null, master = null;
  const ac = () => {
    if (!ctx) {
      ctx = new (window.AudioContext||window.webkitAudioContext)();
      master = ctx.createGain(); master.gain.value = 0.7;
      master.connect(ctx.destination);
    }
    // Browsers start the context suspended until a user gesture; resume it (this
    // runs inside click handlers) or no tone ever plays.
    if (ctx.state === "suspended") { try { ctx.resume(); } catch { /* ignore */ } }
    return ctx;
  };
  let enabled = true; // mirrors the user's sound setting so any caller self-gates
  const tone = (freq, type='sine', dur=0.08, vol=0.18, start=0) => {
    if (!enabled) return;
    try {
      const c=ac(), o=c.createOscillator(), g=c.createGain();
      o.connect(g); g.connect(master);
      o.type=type; o.frequency.setValueAtTime(freq, c.currentTime+start);
      g.gain.setValueAtTime(0, c.currentTime+start);
      g.gain.linearRampToValueAtTime(vol, c.currentTime+start+0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime+start+dur);
      o.start(c.currentTime+start); o.stop(c.currentTime+start+dur+0.01);
    } catch(e) {}
  };
  return {
    click:     ()=>tone(780,'sine',0.05,0.12),
    tick:      ()=>tone(520,'sine',0.03,0.10),
    correct:   ()=>{ tone(523,'sine',0.12,0.18); tone(659,'sine',0.12,0.18,0.08); tone(784,'sine',0.15,0.18,0.16); },
    wrong:     ()=>{ tone(220,'sawtooth',0.12,0.14); tone(196,'sawtooth',0.10,0.10,0.07); },
    submit:    ()=>{ tone(440,'sine',0.15,0.15); tone(370,'sine',0.15,0.12,0.12); },
    pass:      ()=>{ tone(523,'sine',0.18,0.18); tone(659,'sine',0.20,0.18,0.14); },
    fail:      ()=>tone(280,'sine',0.25,0.15),
    celebrate: ()=>[[523,0],[659,.08],[784,.16],[1047,.26],[784,.42],[1047,.52],[1319,.62]].forEach(([f,d])=>tone(f,'sine',0.18,0.22,d)),
    setVolume:(v)=>{ if(master) master.gain.value = Math.max(0,Math.min(1,v/100)); },
    setEnabled:(v)=>{ enabled = !!v; },
  };
})();

const THEME_LIGHT = `
  :root,[data-theme="light"] {
    --color-background-primary:#fffdf9 !important;
    --color-background-secondary:#f6f2ea !important;
    --color-background-tertiary:#f2ede2 !important;
    --color-background-success:#edf6f0 !important;
    --color-text-primary:#231f1a !important;
    --color-text-secondary:#6a6357 !important;
    --color-text-tertiary:#9c9482 !important;
    --color-text-success:#2f7355 !important;
    --color-border-primary:#d9d0be !important;
    --color-border-secondary:#e6dfd2 !important;
    --color-border-tertiary:#efe9de !important;
    --color-border-success:#bcdcc9 !important;
    --color-hover-tint:#f4efe4 !important;
    --color-sel-tint:#ece8f6 !important;
    --color-accent:#4338ca !important;
  }
`;
const THEME_DARK = `
  :root,[data-theme="dark"] {
    --color-background-primary:#201f26 !important;
    --color-background-secondary:#292833 !important;
    --color-background-tertiary:#17161b !important;
    --color-background-success:#13291c !important;
    --color-text-primary:#eceaf2 !important;
    --color-text-secondary:#a6a3ad !important;
    --color-text-tertiary:#78757f !important;
    --color-text-success:#63c08c !important;
    --color-border-primary:#3a3946 !important;
    --color-border-secondary:#302f3a !important;
    --color-border-tertiary:#262530 !important;
    --color-border-success:#2c5540 !important;
    --color-hover-tint:#2a2935 !important;
    --color-sel-tint:#332d55 !important;
    --color-accent:#a5b4fc !important;
  }
`;

// ── Claude API ────────────────────────────────────────────────────────
// The AI proxy + file upload spend the server's Anthropic key, so both require
// a signed-in user. StudyQuiz registers Clerk's getToken here so these
// module-level request helpers can attach a fresh bearer token to every call.
let _getToken = null;
async function authHeader() {
  try { const t = await _getToken?.(); return t ? { Authorization: `Bearer ${t}` } : {}; }
  catch { return {}; }
}
async function callClaude({ blocks, numQ, diff, type, uiLangName, learnerBrief, withSummary }) {
  const typeMap = {
    mcq:   `Multiple choice: exactly 4 options. "correct" is 0-based index of the right answer.`,
    cards: `Flashcards: "question" = front (term/concept), "answer" = back (full explanation). Set options:[] correct:0.`,
    fill:  `Fill in the blank: each "question" has exactly one blank written as ___. "answer" = the missing word or phrase. Set options:[] correct:0.`,
    match: `Matching pairs: "question" = term, "answer" = definition. Set options:[] correct:0.`,
  };
  // `diff` is the 0/1/2 index; map to the difficulty rubric.
  const d = DIFFICULTY[typeof diff === "number" ? diff : 1] || DIFFICULTY[1];
  const prompt = `Generate EXACTLY ${numQ} study questions from the material, not ${numQ-1}, not ${numQ+1}, EXACTLY ${numQ}. This is a strict requirement: the "questions" array MUST contain exactly ${numQ} items. Do not stop early; produce all ${numQ}, then count them before responding.\nQuiz type: ${typeMap[type]}\nDIFFICULTY: ${d.name}. ${d.guide} Calibrate every question to this ${d.name} level.\nFAIRNESS: whatever the level, difficulty must come from the depth of thinking and the number of concepts a learner must connect, NEVER from trick wording, deliberate ambiguity, obscure trivia, or gotchas. Every question must be clearly answerable from a genuine understanding of the material and have exactly ONE defensible correct answer.\nLANGUAGE: Write the ENTIRE quiz, every question, all answer options, the answer, the explanation, and the title/subject/topic, in the SAME language as the study material above. Match the material's language exactly; do NOT translate it into English.${uiLangName?` If the material is too short to tell its language, use ${uiLangName}.`:""}${learnerBrief?`\n${learnerBrief}`:""}\nReturn ONLY raw JSON (no markdown, no backticks):\n{"title":"Short title","subject":"Subject","questions":[{"question":"...","options":["A","B","C","D"],"correct":0,"answer":"...","explanation":"One sentence","topic":"2-4 word sub-topic","source":"..."}]${withSummary?`,"summary":"a compact digest of this material for the study library"`:""}}\nSet "topic" to the specific concept each question tests (2-4 words, e.g. "Photosynthesis", "Supply and demand"), used to track weak areas. Set "source" to SHORT verbatim words copied straight from the study material (a phrase or one sentence, max ~25 words, exact wording, no paraphrasing) that back up the correct answer, so the learner can see exactly where it came from; if a question leans on general knowledge NOT stated in the material, set "source" to an empty string "". Make all 4 options plausible. Vary question styles across the set. The "questions" array length MUST equal ${numQ}.${withSummary?`\nALSO add a top-level "summary" field LAST: a compact digest (max 120 words) of the KEY concepts, definitions and facts this material covers, in the SAME language as the material, so the learner's study library can remember what it was about later. Cover the material as a whole, not any single question.`:""}`;

  // Scale output budget with the question count so big sets aren't truncated
  // (each Q ≈ 160 tokens, +generous headroom). Haiku 4.5 allows up to 64k
  // output and the proxy streams, so a high ceiling is safe; capped at 48k.
  // max_tokens is a ceiling, not a charge, you're billed only for tokens
  // actually generated. Generous per-question budget so a 100-question set
  // never truncates mid-generation.
  const maxTokens = Math.min(Math.max(Math.round(numQ * 300) + 3000, 4000), 48000);

  const res = await fetch("/api/anthropic", {
    method:"POST", headers:{"Content-Type":"application/json", ...(await authHeader())},
    body: JSON.stringify({ model:AI_MODEL, max_tokens:maxTokens,
      system:"You are an expert educator. Return ONLY valid raw JSON, no markdown.",
      messages:[{ role:"user", content:[...blocks,{type:"text",text:prompt}] }] }),
  });
  if (!res.ok) { const e=await res.json().catch(()=>({})); throw new Error(e.error?.message||`Error ${res.status}`); }
  const raw = stripFences(await readStream(res));
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch {
    // Truncated on a big set (hit the token ceiling): salvage the questions that
    // completed by closing the array + object after the last complete object,
    // so the generate loop keeps a partial set instead of losing everything.
    const cut = raw.lastIndexOf("}");
    if (cut > 0) { try { parsed = JSON.parse(raw.slice(0, cut + 1) + "]}"); } catch { /* fall through */ } }
    if (!parsed) throw new Error("Unexpected format");
  }
  // Bound the per-question "source" excerpt (feature A: show the learner where
  // each answer came from in their own material). A blank/missing source means
  // the question leaned on general knowledge, which the UI flags to double-check.
  if (parsed && Array.isArray(parsed.questions)) {
    parsed.questions = parsed.questions.map((q) =>
      q && typeof q === "object"
        ? shuffleMCQOptions({ ...q, source: typeof q.source === "string" ? q.source.trim().slice(0, 240) : "" })
        : q
    );
  }
  // Phase 3: cap the optional material summary (study library "memory"). Absent
  // on a truncated response, which is fine, the library just skips that upload.
  if (parsed && typeof parsed.summary === "string") parsed.summary = parsed.summary.trim().slice(0, 1200);
  return parsed;
}

// Read the streamed plain-text response from /api/anthropic into one string.
async function readStream(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let out = "";
  for (;;) { const { done, value } = await reader.read(); if (done) break; out += dec.decode(value, { stream: true }); }
  out += dec.decode();
  return out;
}
function stripFences(t) {
  return (t||"").trim().replace(/^```json\s*/i,"").replace(/^```\s*/i,"").replace(/\s*```$/i,"").trim();
}

// One-shot plain-text tutor completion via the same proxy (no JSON). Used by
// the "Explain why" feature on wrong answers.
async function callClaudeText(prompt, max = 400) {
  const res = await fetch("/api/anthropic", {
    method:"POST", headers:{"Content-Type":"application/json", ...(await authHeader())},
    body: JSON.stringify({ model:AI_MODEL, max_tokens:max,
      system:"You are a warm, encouraging tutor. Keep replies SHORT and to the point, usually 1-3 sentences; only write more when the concept genuinely needs it. Plain text, no markdown, no headings, no preamble or filler, get straight to the point.",
      messages:[{ role:"user", content:[{type:"text",text:prompt}] }] }),
  });
  if (!res.ok) throw new Error("explain failed");
  return (await readStream(res)).trim();
}
function explainAnswer({ question, correct, picked, subject }) {
  return callClaudeText(
    `A student just answered a study question wrong.\nQuestion: ${question}\nCorrect answer: ${correct}\nStudent's answer: ${picked || "(left blank)"}${subject ? `\nSubject: ${subject}` : ""}\nIn 1-2 short sentences, say why the correct answer is right and gently name the likely misunderstanding. Be concise and concrete, no filler.`
  );
}
function followupAnswer({ question, correct, prior, ask }) {
  return callClaudeText(
    `A student is reviewing a quiz question they got wrong.\nQuestion: ${question}\nCorrect answer: ${correct}\nYour earlier explanation: ${prior}\nThe student now asks: "${ask}"\nAnswer concisely in 1-2 sentences; expand only if the question truly needs it. If they go off-topic, answer in ONE short friendly line and steer back, do not lecture.`
  );
}

// Randomize which position holds the correct option, so the key isn't clustered
// (models tend to over-use one letter, e.g. every answer "B"). No-op for
// non-MCQ questions (empty options) and safe against duplicate option text.
function shuffleMCQOptions(q) {
  if (!q || !Array.isArray(q.options) || q.options.length < 2 || !Number.isInteger(q.correct) || q.correct < 0 || q.correct >= q.options.length) return q;
  const correctVal = q.options[q.correct];
  const opts = q.options.map((text, i) => ({ text, wasCorrect: i === q.correct }));
  for (let i = opts.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [opts[i], opts[j]] = [opts[j], opts[i]]; }
  const correct = opts.findIndex((o) => o.wasCorrect);
  return { ...q, options: opts.map((o) => o.text), correct: correct >= 0 ? correct : q.correct, answer: correctVal ?? q.answer };
}

// Shape a model-returned MCQ into the app's question object, or null if it is
// malformed. Shared by flag/fix regeneration and flag verification.
function normalizeQuestion(parsed, orig) {
  const options = Array.isArray(parsed?.options) ? parsed.options.filter((o)=>typeof o==="string"&&o.trim()) : [];
  if (options.length < 2 || !Number.isInteger(parsed.correct) || parsed.correct < 0 || parsed.correct >= options.length) return null;
  return {
    question: String(parsed.question || "").trim(),
    options,
    correct: parsed.correct,
    answer: options[parsed.correct] || "",
    explanation: String(parsed.explanation || "").trim().slice(0, 400),
    topic: String(parsed.topic || orig?.topic || "").trim().slice(0, 60),
    source: typeof parsed.source === "string" ? parsed.source.trim().slice(0, 240) : "",
  };
}

// Feature B: write ONE replacement multiple-choice question when the learner
// flags one as confusing / off-material (or as a fallback after verification).
// Reuses the ORIGINAL study material (blocks) so the fix stays grounded.
async function regenerateQuestion({ blocks, q, subject, reason, uiLangName, diff }) {
  const d = DIFFICULTY[typeof diff === "number" ? diff : 1] || DIFFICULTY[1];
  const reasonLine = {
    wrong:   "The learner says the marked correct answer looks wrong.",
    unclear: "The learner says it was confusing or badly worded.",
    offnotes:"The learner says it was not covered in their material.",
  }[reason] || "The learner flagged a problem with it.";
  const topic = q.topic || subject || "the same concept";
  const optLine = Array.isArray(q.options) ? q.options.join(" / ") : "(none)";
  const prompt = `A study question was flagged as having a problem. ${reasonLine}
Flagged question: ${q.question}
Its options were: ${optLine}
Write ONE brand-new multiple-choice question that tests the SAME concept (${topic}) but fixes the problem: exactly 4 options, exactly ONE clearly correct answer, plausible distractors, and clear unambiguous wording. Work the answer out yourself first and make sure "correct" is the index of that answer. Do not repeat the flagged question.
DIFFICULTY: ${d.name}. ${d.guide}
Base it on the study material above. In "source", copy SHORT verbatim words from that material that back up the answer (max ~25 words, exact wording, no paraphrasing); if it must rely on general knowledge not in the material, set "source" to "".
LANGUAGE: write the question, every option, the explanation and the source in the SAME language as the study material.${uiLangName ? ` If that is unclear, use ${uiLangName}.` : ""}
Return ONLY raw JSON, no markdown: {"question":"...","options":["A","B","C","D"],"correct":0,"answer":"...","explanation":"One sentence","topic":"${topic}","source":"..."}`;
  const res = await fetch("/api/anthropic", {
    method:"POST", headers:{"Content-Type":"application/json", ...(await authHeader())},
    body: JSON.stringify({ model:AI_MODEL, max_tokens:1200,
      system:"You are an expert educator. Return ONLY valid raw JSON, no markdown.",
      messages:[{ role:"user", content:[...(blocks||[]),{type:"text",text:prompt}] }] }),
  });
  if (!res.ok) { const e=await res.json().catch(()=>({})); throw new Error(e.error?.message||`Error ${res.status}`); }
  const nq = normalizeQuestion(JSON.parse(stripFences(await readStream(res))), q);
  if (!nq) throw new Error("Malformed replacement");
  return nq;
}

// Feature B (verify): when the learner says the marked answer is WRONG, don't
// blindly rewrite. Re-check the question against their material plus the model's
// own knowledge and return a verdict: the answer holds up (with the reason and a
// supporting quote), the learner is right (with a corrected question), or it was
// genuinely ambiguous (with a clearer one).
async function verifyFlaggedQuestion({ blocks, q, uiLangName, diff }) {
  const d = DIFFICULTY[typeof diff === "number" ? diff : 1] || DIFFICULTY[1];
  const marked = Array.isArray(q.options) ? (q.options[q.correct] ?? "") : (q.answer || "");
  const optLine = Array.isArray(q.options) ? q.options.map((o,i)=>`${i}: ${o}`).join(" | ") : "(none)";
  const prompt = `A learner thinks this quiz question is mis-keyed, that the marked "correct" answer is actually wrong. Check carefully whether the marked answer is truly correct, using the study material above plus your own reliable knowledge. Reason it out before deciding.
Question: ${q.question}
Options (index: text): ${optLine}
Marked correct answer: index ${q.correct} = "${marked}"
Choose ONE verdict:
- "answer_correct": the marked answer is right. Briefly explain why for the learner, and if the material states it, quote the exact supporting words in "answerSource". Set "replacement" to null.
- "student_right": the marked answer is genuinely wrong. Give a corrected replacement question (with the right answer keyed) in "replacement".
- "ambiguous": the question is unclear or has more than one defensible answer. Give a clearer replacement question in "replacement".
Keep any replacement at a similar difficulty (${d.name}) and grounded in the material, with a "source" quote where possible.
Write every learner-facing string in the SAME language as the study material.${uiLangName ? ` If unclear, use ${uiLangName}.` : ""}
Return ONLY raw JSON, no markdown: {"verdict":"answer_correct","explanation":"...","answerSource":"...","replacement":{"question":"...","options":["A","B","C","D"],"correct":0,"answer":"...","explanation":"One sentence","topic":"${q.topic || ""}","source":"..."}}`;
  const res = await fetch("/api/anthropic", {
    method:"POST", headers:{"Content-Type":"application/json", ...(await authHeader())},
    body: JSON.stringify({ model:AI_MODEL, max_tokens:1400,
      system:"You are a meticulous fact-checker and educator. Return ONLY valid raw JSON, no markdown.",
      messages:[{ role:"user", content:[...(blocks||[]),{type:"text",text:prompt}] }] }),
  });
  if (!res.ok) { const e=await res.json().catch(()=>({})); throw new Error(e.error?.message||`Error ${res.status}`); }
  const parsed = JSON.parse(stripFences(await readStream(res)));
  const verdict = ["answer_correct","student_right","ambiguous"].includes(parsed.verdict) ? parsed.verdict : "answer_correct";
  return {
    verdict,
    explanation: String(parsed.explanation || "").trim().slice(0, 500),
    answerSource: typeof parsed.answerSource === "string" ? parsed.answerSource.trim().slice(0, 240) : "",
    replacement: verdict === "answer_correct" ? null : normalizeQuestion(parsed.replacement || {}, q),
  };
}

// Content gate (feature F, safety). Before generating, judge the uploaded
// material by INTENT, not surface keywords, so factual/educational content on
// ANY subject passes (Wikipedia, articles, studies, and sensitive-but-academic
// topics like anatomy, war or toxicology) and only genuine porn / CSAM / hate /
// weapon-instructions / junk is blocked. Runs on the same blocks (image / pdf /
// text) as generation, so it sees the real content. Errs toward allowing, and
// FAILS OPEN on any error so an infra hiccup never blocks a real learner.
async function gateContent({ blocks, uiLangName }) {
  const prompt = `You gate uploads for a study app. A student wants to make a quiz from this material. Judge it and return ONLY JSON: {"decision":"allow"|"block","category":"ok"|"explicit"|"harmful"|"nonstudy","reason":"a few words"}.

ALLOW anything a person could genuinely learn from or be tested on, on ANY subject and in ANY format: textbooks, notes, transcripts, slides, articles, encyclopedia or Wikipedia pages, news, research papers or abstracts, documentation, study guides. Informational content counts fully; it does NOT need to be a textbook. A factual article about space, a medical study, or a Wikipedia page IS valid study material. Sensitive topics treated factually (anatomy, reproduction, medicine, drugs, mental health, war, toxicology, weapons in a historical or scientific context, religion, politics) are ALLOWED.

BLOCK only when it is clearly NOT for learning:
- "explicit": pornographic or erotic content meant for arousal, or ANY sexual content involving minors.
- "harmful": gratuitous gore, content promoting hatred or harassment of a group, or operational step-by-step instructions to build weapons or seriously harm people.
- "nonstudy": no learnable substance, e.g. spam, advertising, a private personal conversation, a shopping list, pure gibberish, or too little text to quiz on.

When unsure, choose "allow". A real student's material must never be blocked for being informational or for factually covering a hard topic. Only "block" when it clearly matches a block category.${uiLangName ? ` Write "reason" in ${uiLangName}.` : ""}`;
  try {
    const res = await fetch("/api/anthropic", {
      method:"POST", headers:{"Content-Type":"application/json", ...(await authHeader())},
      body: JSON.stringify({ model:AI_MODEL, max_tokens:120,
        system:"You are a precise, fair content classifier for an educational app. Return ONLY valid raw JSON.",
        messages:[{ role:"user", content:[...(blocks||[]),{type:"text",text:prompt}] }] }),
    });
    if (!res.ok) return { decision:"allow", category:"ok" }; // fail open
    const parsed = JSON.parse(stripFences(await readStream(res)));
    const category = ["ok","explicit","harmful","nonstudy"].includes(parsed.category) ? parsed.category : "ok";
    const decision = (parsed.decision === "block" && category !== "ok") ? "block" : "allow";
    return { decision, category, reason: String(parsed.reason || "").slice(0, 120) };
  } catch { return { decision:"allow", category:"ok" }; } // fail open on any error
}
// Map a gate block category to the localized message shown to the learner.
const gateMessage = (category, t) =>
  category === "explicit" ? t.gateExplicit :
  category === "harmful"  ? t.gateHarmful  :
  t.gateNonstudy;

// Keep a figure only if it is a clean, self-contained <svg> (rendered inside an
// <img> data-URI, which can't run scripts; this strips anything scriptable too).
// An SVG shown via <img> MUST carry the SVG namespace or the browser shows a
// broken image, so add xmlns when the model leaves it off.
function safeSvg(s) {
  s = typeof s === "string" ? s.trim() : "";
  if (!(/^<svg[\s>]/i.test(s) && s.length < 12000 && !/<script|<foreignobject|\son\w+\s*=|javascript:/i.test(s))) return "";
  if (!/\sxmlns\s*=/i.test(s)) s = s.replace(/^<svg/i, "<svg xmlns='http://www.w3.org/2000/svg'");
  return s;
}
// Crash-safe mock-exam resume. An in-progress mock (any of the 8 exams) is
// mirrored to device storage in two keys: the heavy question set (rewritten only
// when it changes) and the light progress that changes often (answers, position,
// clock). A refresh, crash, or accidental exit can then be resumed. Cleared the
// instant the exam finishes or the user starts over. Stays on-device, never uploaded.
const MOCK_LS_Q = "revyy_mock_q_v1";
const MOCK_LS_P = "revyy_mock_p_v1";
const MOCK_RESUME_TTL = 3 * 24 * 3600 * 1000; // stop offering a stale exam after 3 days
function clearMockResume() {
  try { localStorage.removeItem(MOCK_LS_Q); localStorage.removeItem(MOCK_LS_P); } catch { /* ignore */ }
}
// Light record only (which exam + where they are), enough for the "Continue" card.
function readMockProgress() {
  try {
    if (!localStorage.getItem(MOCK_LS_Q)) return null;
    const p = JSON.parse(localStorage.getItem(MOCK_LS_P) || "null");
    if (!p || typeof p.secIdx !== "number") return null;
    if (p.savedAt && Date.now() - p.savedAt > MOCK_RESUME_TTL) { clearMockResume(); return null; }
    return p;
  } catch { return null; }
}
// Full record (question set + progress), for actually continuing.
function readMockResume() {
  try {
    const e = JSON.parse(localStorage.getItem(MOCK_LS_Q) || "null");
    const p = JSON.parse(localStorage.getItem(MOCK_LS_P) || "null");
    if (!e || !e.mock || !Array.isArray(e.mock.sections) || !e.mock.sections.length || !p) return null;
    if (p.savedAt && Date.now() - p.savedAt > MOCK_RESUME_TTL) { clearMockResume(); return null; }
    return { mock: e.mock, tilt: e.tilt, p };
  } catch { return null; }
}
// Keep only well-formed MCQs (a ballooning explanation signals the model could
// not solve it cleanly, drop those rather than ship a mis-keyed question).
function sanitizeMockQs(qs) {
  return (Array.isArray(qs) ? qs : []).filter((q) =>
    q && typeof q.question === "string" && q.question.length > 2 &&
    Array.isArray(q.options) && q.options.length >= 2 &&
    q.options.every((o) => typeof o === "string" && o.trim().length) &&
    Number.isInteger(q.correct) && q.correct >= 0 && q.correct < q.options.length &&
    String(q.explanation || "").length <= 400
  ).map((q) => {
    const svg = safeSvg(q.svg);
    const base = { question: q.question, options: q.options, correct: q.correct, explanation: q.explanation };
    return svg ? { ...base, svg } : base;
  });
}

// Generate one chunk of a standardized mock section (no upload), authentic
// style. Standalone sections return { format:"standalone", questions }.
// Passage / English sections return { format, passage, svg, questions } where
// the questions all belong to that ONE passage; English passages carry the
// revised portions wrapped in <u>…</u> in reading order (one per question),
// which the runner renders as real underlines. `n` = how many questions to write.
async function callMockSection(exam, section, tilt, exemplars = [], avoid = [], n) {
  const fmt = section.format || "standalone";
  const nOpt = section.options || 4;
  const count = n || section.count;
  const optTemplate = Array(nOpt).fill('"..."').join(",");
  // Universal mock learning: a few good crowd-generated questions as STYLE
  // exemplars (never to copy) + recent flagged-bad stems to avoid.
  const exBlock = (exemplars && exemplars.length)
    ? `\nSTYLE EXAMPLES from our question bank of authentic ${exam.name} ${section.name} questions. Study their phrasing, difficulty, structure and format, then write BRAND NEW questions of the same quality. Do NOT copy, translate, or lightly reword them, they are references only:\n${exemplars.slice(0,3).map((q,i)=>`Example ${i+1}: ${JSON.stringify({question:String(q.question||"").slice(0,700),options:(Array.isArray(q.options)?q.options:[]).map(o=>String(o).slice(0,200))})}`).join("\n")}`
    : "";
  const avoidBlock = (avoid && avoid.length)
    ? `\nAVOID: learners flagged questions like these as flawed, mis-keyed or ambiguous. Do NOT produce anything similar:\n- ${avoid.slice(0,4).map(s=>String(s).slice(0,160)).join("\n- ")}`
    : "";
  const tiltLine = tilt === "easier"
    ? "OVERALL DIFFICULTY: an easier form, lean toward approachable questions but still include a few genuinely hard ones."
    : tilt === "harder"
    ? "OVERALL DIFFICULTY: a harder form, lean toward challenging questions with subtle, close distractors."
    : "OVERALL DIFFICULTY: an authentic form spanning the full real range, including several genuinely hard questions.";
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
Each question has "options" (EXACTLY ${nOpt} choices), "correct" (the 0-based index of the ONE correct option, which you work out carefully first), and "explanation" (one short sentence). Make distractors close and genuinely ${exam.name}-hard, not trivial.
${figRule}${exBlock}${avoidBlock}
Return ONLY raw JSON, no markdown: {"passage":"the full passage text${fmt==="english"?", with the revised portions wrapped in <u>...</u> in reading order":""}","svg":"OPTIONAL inline <svg>…</svg>","questions":[{"question":"...","options":[${optTemplate}],"correct":0,"explanation":"..."}]}`;
    maxTokens = Math.min(count * 450 + 7000, 40000);
  } else {
    prompt = `You are assembling a realistic ${exam.name} ${section.name} section that should feel indistinguishable from a genuine ${exam.name} form. Draw on your knowledge of actual ${exam.name} exams, real past papers and official practice tests. Match the authentic topics, difficulty spread, phrasing and formats faithfully.
${instr}
Provide EXACTLY ${count} multiple-choice questions.
${wantsFigures ? `\nFIGURES ARE MANDATORY: a real ${exam.name} ${section.name} form is full of diagrams. AT LEAST ${kFig} of the ${count} questions MUST be geometry, coordinate-geometry, trigonometry, or data-interpretation questions, and EACH of those MUST carry an accurate inline "svg" figure the question genuinely depends on (a triangle/circle/polygon with labelled sides or angles, a coordinate plane with plotted points/lines/parabolas, a number line, or a bar/line/scatter chart). Draw each figure to the EXACT numbers in the question and consistent with the correct answer. Fewer than ${kFig} figures does NOT look like a real ${exam.name} and is unacceptable. Purely algebraic or arithmetic questions need no figure.\n${svgRules}\n` : ""}
${tiltLine} Vary difficulty like the real exam.
Each question object: "question" (the full stem, with any context written into it), "options" (EXACTLY ${nOpt} choices), "correct" (0-based index of the ONE correct option), "explanation" (one short sentence)${wantsFigures ? `, and "svg" (the figure, or omit it for a figure-free question)` : ""}. CRITICAL: work every calculation out FIRST, then key the matching option; double-check numbers and units. Exactly ONE correct option each; discard any you are not certain of.${exBlock}${avoidBlock}
Return ONLY raw JSON, no markdown: {"questions":[{"question":"...","options":[${optTemplate}],"correct":0,"explanation":"..."${wantsFigures ? `,"svg":"<svg viewBox='0 0 200 200'>…</svg> only when the question needs a figure"` : ""}}]}
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
    return { format: fmt, passage: String(parsed.passage || "").slice(0, 9000), svg: safeSvg(parsed.svg), questions };
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
const MOCK_CHUNK = 25;      // standalone questions per parallel call
const MOCK_MAX_PASSAGES = 6; // cap passages per section so the load stays bounded
async function buildMockSection(exam, section, tilt) {
  const fmt = section.format || "standalone";
  if (fmt === "standalone") {
    const nChunks = Math.max(1, Math.ceil(section.count / MOCK_CHUNK));
    const sizes = [];
    for (let i = 0, rem = section.count; i < nChunks; i++) { const n = Math.min(MOCK_CHUNK, rem); if (n <= 0) break; sizes.push(n); rem -= n; }
    const { exemplars, avoid } = await mockDrawGlobal(exam.name, section.name);
    const results = await Promise.all(sizes.map((n) => callMockSection(exam, section, tilt, exemplars, avoid, n).catch(() => ({ questions: [] }))));
    const seen = new Set(); const out = [];
    for (const r of results) for (const q of (r.questions || [])) { const k = String(q.question || "").toLowerCase().trim(); if (k && !seen.has(k)) { seen.add(k); out.push(q); } }
    mockContributeGlobal(exam.name, section.name, out);
    return out.slice(0, section.count);
  }
  const size = section.passageSize || section.count;
  const groups = Math.min(MOCK_MAX_PASSAGES, Math.max(1, Math.ceil(section.count / size)));
  const needs = [];
  for (let g = 0, rem = section.count; g < groups; g++) { const n = Math.min(size, rem); if (n <= 0) break; needs.push(n); rem -= n; }
  // Passage sections also learn globally: steer with the crowd's avoid-list (and
  // style exemplars), and contribute the questions back for everyone.
  const { exemplars, avoid } = await mockDrawGlobal(exam.name, section.name);
  const results = await Promise.all(needs.map((n) => callMockSection(exam, section, tilt, exemplars, avoid, n).catch(() => null)));
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

// ── Global mock-learning bank (client) ──
// Thin best-effort calls to the /api/study mock endpoints. Every one fails soft:
// the mock flow must never break because the shared bank is unreachable. Keyed
// by exam + section names (general test knowledge, never user material).
async function mockDrawGlobal(exam, section) {
  try {
    const res = await fetch("/api/study", { method:"POST", headers:{"Content-Type":"application/json", ...(await authHeader())},
      body: JSON.stringify({ action:"mockDraw", exam, section }) });
    if (!res.ok) return { exemplars: [], avoid: [] };
    const j = await res.json().catch(() => ({}));
    return { exemplars: Array.isArray(j.exemplars) ? j.exemplars : [], avoid: Array.isArray(j.avoid) ? j.avoid : [] };
  } catch { return { exemplars: [], avoid: [] }; }
}
async function mockContributeGlobal(exam, section, questions) {
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
async function mockFlagGlobal(exam, section, question) {
  try {
    await fetch("/api/study", { method:"POST", headers:{"Content-Type":"application/json", ...(await authHeader())},
      body: JSON.stringify({ action:"mockFlag", exam, section, qhash: qhashOf(question) }) });
  } catch { /* best effort */ }
}

// The sender's challenge activity: quizzes they shared that others have taken.
async function fetchMyChallenges() {
  try {
    const res = await fetch("/api/study", { method:"POST", headers:{"Content-Type":"application/json", ...(await authHeader())},
      body: JSON.stringify({ action:"myChallenges" }) });
    if (!res.ok) return [];
    const j = await res.json().catch(() => ({}));
    return Array.isArray(j.challenges) ? j.challenges : [];
  } catch { return []; }
}

function readText(f)   { return new Promise((res,rej)=>{ const r=new FileReader(); r.onload=e=>res(e.target.result); r.onerror=()=>rej(new Error("Read failed")); r.readAsText(f); }); }

function Logo({ size=28 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg" style={{flexShrink:0}}>
      <rect width="28" height="28" rx="8" fill="url(#lg)"/>
      <defs>
        <linearGradient id="lg" x1="0" y1="0" x2="28" y2="28" gradientUnits="userSpaceOnUse">
          <stop stopColor="#6366f1"/>
          <stop offset="1" stopColor="#4338ca"/>
        </linearGradient>
      </defs>
      <path d="M9.7 7.4 V20.6 M9.7 7.4 H14.6 A3.95 3.95 0 0 1 14.6 15.3 H9.7" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M11 15.3 L14.9 20.6 L20.7 11" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

// ── Sub-components ────────────────────────────────────────────────────
function PBar({ v, max }) {
  return <div style={{height:4,background:"var(--color-border-tertiary)",borderRadius:2}}><div style={{height:"100%",borderRadius:2,background:"#4338ca",width:`${(v/max)*100}%`,transition:"width 0.35s"}}/></div>;
}

// Sliding countdown bar shown while auto-advance waits before the next
// question. Fills 0→100% over `sec` seconds via CSS animation. The `runId`
// key restarts the animation cleanly on each new question.
function AutoAdvanceBar({ sec, runId, t }) {
  return (
    <div style={{marginTop:16}}>
      <div style={{fontSize:11,color:"var(--color-text-tertiary)",marginBottom:5,textAlign:"center"}}>{t?.autoAdvancing||"Next question in a moment…"}</div>
      <div style={{height:4,background:"var(--color-border-tertiary)",borderRadius:2,overflow:"hidden"}}>
        <div key={runId} style={{height:"100%",background:"#4338ca",borderRadius:2,animation:`rvAutoBar ${sec}s linear forwards`}}/>
      </div>
    </div>
  );
}

function Chip({ label, active, onClick, locked, small, hideBadge, rec }) {
  return (
    <button onClick={onClick} style={{
      padding:small?"4px 10px":"6px 14px", borderRadius:20,
      fontSize:small?11:12, fontWeight:600, cursor:"pointer", fontFamily:"inherit",
      border:locked?"1.5px solid #f59e0b":"1px solid",
      transition:"all 0.15s",
      background:active?"#4338ca":"transparent",
      color:active?"#fff":locked?"#92400e":"var(--color-text-secondary)",
      borderColor:active?"#4338ca":locked?"#f59e0b":"var(--color-border-secondary)",
      boxShadow:locked?"0 0 0 1px #f59e0b33, inset 0 0 0 1px #f59e0b22":undefined,
    }}>
      {label}
      {rec && !active && <span style={{marginLeft:5,display:"inline-block",width:6,height:6,borderRadius:"50%",background:"var(--color-accent)",verticalAlign:"middle"}}/>}
      {locked && !hideBadge && <span style={{marginLeft:4,fontSize:7,background:"#f59e0b",color:"#fff",borderRadius:8,padding:"1px 4px",fontWeight:700,verticalAlign:"middle"}}>PRO</span>}
    </button>
  );
}

// ── Pro Upgrade Modal ─────────────────────────────────────────────────
function ProModal({ onClose, onMonthly, onYearly, busy, error, t }) {
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.6)",zIndex:500,display:"flex",alignItems:"flex-end"}} onClick={()=>!busy&&onClose()}>
      <div className="slide-up" onClick={e=>e.stopPropagation()} style={{background:"var(--color-background-primary)",borderRadius:"20px 20px 0 0",padding:"28px 20px 36px",width:"100%",maxHeight:"88vh",overflowY:"auto",boxSizing:"border-box"}}>
        <div style={{textAlign:"center",marginBottom:14}}>
          <div style={{marginBottom:8,display:"flex",justifyContent:"center",color:"#f59e0b"}}><Icon name="spark" size={38} stroke={1.6}/></div>
          <h3 style={{margin:"0 0 4px",fontSize:21,fontWeight:700,fontFamily:"'Fraunces',Georgia,serif",color:"var(--color-text-primary)"}}>{t.upgradeToPro}</h3>
        </div>
        <div style={{background:"linear-gradient(135deg,var(--color-sel-tint),var(--color-sel-tint))",borderRadius:12,padding:"12px 14px",marginBottom:14,fontSize:12.5,color:"var(--color-accent)",lineHeight:1.6,textAlign:"center"}}>{t.proDesc}</div>
        {error && <div style={{background:"#fef2f2",border:"1px solid #fecaca",color:"#b91c1c",borderRadius:10,padding:"9px 12px",fontSize:12.5,marginBottom:14}}>{error}</div>}
        <div style={{display:"flex",gap:12,marginBottom:14}}>
          {/* Monthly, subtle gold ring (less prominent than yearly) */}
          <div style={{flex:1,border:"1.5px solid #fcd34d",borderRadius:14,padding:"16px 12px",textAlign:"center"}}>
            <div style={{fontSize:12,fontWeight:700,letterSpacing:1,textTransform:"uppercase",color:"var(--color-text-secondary)",marginBottom:6}}>{t.planMonthly}</div>
            <div style={{fontSize:22,fontWeight:800,color:"var(--color-text-primary)"}}>€4.99</div>
            <button onClick={onMonthly} disabled={!!busy} style={{...Sb.btnPrimary,width:"100%",marginTop:14,background:"#4338ca",fontFamily:"inherit",fontSize:13,opacity:busy?0.7:1}}>
              {busy==="monthly" ? "Starting…" : t.upgradeToPro}
            </button>
          </div>
          {/* Yearly, the standout: stronger gold ring + glow */}
          <div style={{flex:1,border:"2px solid #f59e0b",background:"#fffbeb",borderRadius:14,padding:"16px 12px",textAlign:"center",boxShadow:"0 4px 16px rgba(245,158,11,0.25)"}}>
            <div style={{fontSize:12,fontWeight:700,letterSpacing:1,textTransform:"uppercase",color:"#92400e",marginBottom:6}}>{t.planYearly}</div>
            <div style={{fontSize:22,fontWeight:800,color:"#92400e"}}>€39.99</div>
            <div style={{fontSize:10,fontWeight:700,color:"#b45309",marginTop:4}}>Save 33% · {t.bestValue}</div>
            <button onClick={onYearly} disabled={!!busy} style={{...Sb.btnPrimary,width:"100%",marginTop:8,background:"#f59e0b",fontFamily:"inherit",fontSize:13,opacity:busy?0.7:1}}>
              {busy==="yearly" ? "Starting…" : t.upgradeToPro}
            </button>
          </div>
        </div>
        <p style={{fontSize:11,color:"var(--color-text-tertiary)",textAlign:"center",margin:"0 0 14px",lineHeight:1.6}}>{t.cancelAnytime}</p>
        <button onClick={onClose} disabled={!!busy} style={{...Sb.btnGhost,width:"100%",fontSize:13}}>{t.notNow}</button>
      </div>
    </div>
  );
}

// ── Question Packs popup (Pro) ────────────────────────────────────────
// One-time top-ups added to the bonus balance (never expire, used after the
// daily allowance). Shown from the "limit reached" message and from Settings.
const QUESTION_PACKS = [
  { id:"A", q:"500",   price:"€1.99", blurbKey:"packBlurbA" },
  { id:"B", q:"1,500", price:"€4.99", blurbKey:"packBlurbB", best:true },
  { id:"C", q:"3,000", price:"€8.99", blurbKey:"packBlurbC" },
];
function PacksModal({ onClose, buyPack, t }) {
  const [busy, setBusy] = useState("");
  const buy = async (id) => { if (busy) return; setBusy(id); const r = await buyPack?.(id); if (r?.error) setBusy(""); };
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.6)",zIndex:500,display:"flex",alignItems:"flex-end"}} onClick={()=>!busy&&onClose()}>
      <div className="slide-up" onClick={e=>e.stopPropagation()} style={{background:"var(--color-background-primary)",borderRadius:"20px 20px 0 0",padding:"26px 20px 36px",width:"100%",maxHeight:"88vh",overflowY:"auto",boxSizing:"border-box"}}>
        <div style={{textAlign:"center",marginBottom:16}}>
          <div style={{marginBottom:8,display:"flex",justifyContent:"center",color:"var(--color-accent)"}}><Icon name="gem" size={32} stroke={1.7}/></div>
          <h3 style={{margin:"0 0 6px",fontSize:20,fontWeight:700,fontFamily:"'Fraunces',Georgia,serif",color:"var(--color-text-primary)"}}>{t.questionPacks || "Question packs"}</h3>
          <p style={{margin:0,fontSize:12.5,color:"var(--color-text-secondary)",lineHeight:1.55}}>{t.questionPacksDesc || "One-time top-ups for everyone. They never expire and are used once your daily allowance runs out. Your other plan limits (quiz types, per-quiz max, file size) still apply."}</p>
        </div>
        {QUESTION_PACKS.map((p) => (
          <div key={p.id} style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,
            border:p.best?"2px solid #f59e0b":"0.5px solid var(--color-border-tertiary)",
            background:p.best?"#fffbeb":"var(--color-background-secondary)",
            borderRadius:14,padding:"13px 14px",marginBottom:10}}>
            <div style={{flex:1}}>
              <div style={{fontSize:15,fontWeight:800,color:p.best?"#92400e":"var(--color-text-primary)"}}>
                {p.q} {t.questionsLow}
                {p.best && <span style={{marginLeft:8,fontSize:9,fontWeight:800,letterSpacing:0.6,background:"#f59e0b",color:"#fff",borderRadius:8,padding:"2px 7px",verticalAlign:"middle"}}>{t.bestValue || "BEST VALUE"}</span>}
              </div>
              <div style={{fontSize:11.5,color:p.best?"#b45309":"var(--color-text-secondary)",marginTop:2}}>{t[p.blurbKey]}</div>
            </div>
            <button onClick={()=>buy(p.id)} disabled={!!busy} style={{...Sb.btnPrimary,margin:0,padding:"10px 16px",fontSize:14,minWidth:78,background:p.best?"#f59e0b":"#4338ca",opacity:(busy&&busy!==p.id)?0.5:1}}>
              {busy===p.id ? "…" : p.price}
            </button>
          </div>
        ))}
        <button onClick={()=>!busy&&onClose()} disabled={!!busy} style={{...Sb.btnGhost,width:"100%",fontSize:13,marginTop:4}}>{t.notNow || "Not now"}</button>
      </div>
    </div>
  );
}

// ── Per-feature ad-unlock modal ───────────────────────────────────────
// One modal per feature; watching a (placeholder) ad starts a 1-hour window.
const UNLOCK_META = {
  flashcard:   { icon:"layers", title:"Flashcards",        gives:"the Flashcards quiz type",        daily:false },
  fillinblank: { icon:"pencil", title:"Fill in the blank", gives:"the Fill-in-the-blank quiz type", daily:true  },
  matchterms:  { icon:"link",   title:"Match terms",        gives:"the Match-terms quiz type",        daily:true  },
  questions:   { icon:"list",   title:"50 questions",       gives:"up to 50 questions per quiz",      daily:true  },
  filesize:    { icon:"folder", title:"10 MB uploads",      gives:"file uploads up to 10 MB",         daily:true  },
};

function UnlockModal({ feature, unlocks, onClose, onUpgrade, t }) {
  const [busy, setBusy] = useState(false);
  if (!feature) return null;
  const m = { ...UNLOCK_META[feature], ...(t.unlockMeta?.[feature]||{}) };
  const active = unlocks.isUnlocked(feature);
  const canU = unlocks.canUnlock(feature);
  const usedUp = !active && !canU; // once-daily already used today
  const doWatch = async () => { if (busy) return; setBusy(true); await unlocks.unlock(feature); setBusy(false); };
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.55)",zIndex:300,display:"flex",alignItems:"flex-end"}} onClick={onClose}>
      <div className="slide-up" onClick={e=>e.stopPropagation()} style={{background:"var(--color-background-primary)",borderRadius:"20px 20px 0 0",padding:"24px 20px 36px",width:"100%",maxHeight:"80vh",overflowY:"auto",boxSizing:"border-box"}}>
        <div style={{textAlign:"center",marginBottom:18}}>
          <div style={{marginBottom:10,display:"flex",justifyContent:"center",color:active?"#16a34a":"var(--color-text-tertiary)"}}><Icon name={active?"check":"lock"} size={32} stroke={1.9}/></div>
          <h3 style={{margin:"0 0 6px",fontSize:18,fontWeight:700,color:"var(--color-text-primary)",fontFamily:"'Fraunces',Georgia,serif"}}>{m.title}</h3>
          <p style={{margin:0,fontSize:13,color:"var(--color-text-secondary)",lineHeight:1.5}}>
            {(()=>{const [a,b=""]=t.unlockWatchLine.split("{gives}");return <>{a}<strong style={{color:"var(--color-text-primary)"}}>{m.gives}</strong>{b}</>;})()} {m.daily ? t.unlockDaily : t.unlockUnlimited}
          </p>
        </div>
        {active && (
          <div style={{background:"var(--color-background-success)",border:"0.5px solid var(--color-border-success)",borderRadius:10,padding:"10px 14px",marginBottom:12,fontSize:13,color:"var(--color-text-success)",textAlign:"center"}}>
            {(()=>{const [a,b=""]=t.unlockedLeft.split("{label}");return <>{a}<strong>{unlocks.remainingLabel(feature)}</strong>{b}</>;})()}
          </div>
        )}
        {!active && canU && (
          <button onClick={doWatch} disabled={busy} style={{width:"100%",marginBottom:10,background:"#fefce8",border:"1.5px solid #f59e0b",color:"#92400e",borderRadius:12,padding:"13px 14px",fontSize:13.5,fontWeight:700,cursor:busy?"default":"pointer",fontFamily:"inherit",lineHeight:1.5,textAlign:"center",opacity:busy?0.6:1}}>
            {busy ? t.loadingAd : t.unlockWatchBtn}<br/>
            <span style={{fontSize:11,fontWeight:500,opacity:0.85}}>{t.unlockGivesFor.replace("{gives}",m.gives)}</span>
          </button>
        )}
        {usedUp && (
          <div style={{background:"var(--color-background-secondary)",borderRadius:10,padding:"10px 14px",marginBottom:12,fontSize:12,color:"var(--color-text-secondary)",textAlign:"center",lineHeight:1.5}}>
            {t.unlockUsedUp}
          </div>
        )}
        <button onClick={onUpgrade} style={{...Sb.btnPrimary,width:"100%",marginBottom:10,fontFamily:"inherit",fontSize:14,background:"#4338ca"}}>
          ✦ {t.upgradeToPro}
        </button>
        <button onClick={onClose} style={{...Sb.btnGhost,width:"100%",fontSize:13}}>{t.notNow || "Not now"}</button>
      </div>
    </div>
  );
}

// ── Flashcard ─────────────────────────────────────────────────────────
function Flashcard({ q, onNext, isLast, t }) {
  const [flipped,setFlipped] = useState(false);
  const ans = q.answer || (q.options&&q.options[q.correct]) || "";
  return (
    <div>
      <div onClick={()=>setFlipped(f=>!f)} style={{cursor:"pointer"}}>
        <div style={{background:flipped?"var(--color-background-secondary)":"var(--color-background-primary)",border:`1.5px solid ${flipped?"#4338ca":"var(--color-border-tertiary)"}`,borderRadius:16,padding:"40px 24px",textAlign:"center",minHeight:200,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",transition:"all 0.25s"}}>
          <div style={{fontSize:10,fontWeight:700,color:"var(--color-text-tertiary)",letterSpacing:1.5,marginBottom:16}}>{flipped?t.fcAnswer:t.fcQuestion}</div>
          <div style={{fontFamily:"'Fraunces',Georgia,serif",fontSize:18,fontWeight:700,color:"var(--color-text-primary)",lineHeight:1.5}}>{flipped?ans:q.question}</div>
          <div style={{marginTop:20,fontSize:12,color:"var(--color-text-tertiary)"}}>{flipped?t.flipBack:t.flip}</div>
        </div>
      </div>
      {flipped && (
        <div style={{display:"flex",gap:10,marginTop:14}} className="slide-up">
          <button onClick={()=>{Haptics.buzz();setFlipped(false);setTimeout(()=>onNext(false),200);}} style={{flex:1,background:"#fef2f2",border:"1px solid #fca5a5",color:"#b91c1c",borderRadius:12,padding:"12px",fontSize:14,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>{t.fcDidntKnow}</button>
          <button onClick={()=>{Haptics.buzz();setFlipped(false);setTimeout(()=>onNext(true),200);}} style={{flex:1,background:"#f0fdf4",border:"1px solid #86efac",color:"#15803d",borderRadius:12,padding:"12px",fontSize:14,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>{t.gotIt}</button>
        </div>
      )}
    </div>
  );
}

// ── Fill in Blank ─────────────────────────────────────────────────────
function FillBlank({ q, onNext, isLast, t, feedback="immediate", autoAdvance=false, autoSec=5 }) {
  const [val,setVal]         = useState("");
  const [checked,setChecked] = useState(false);
  const correct = (q.answer||"").toLowerCase().trim();
  const isRight = val.toLowerCase().trim()===correct || correct.includes(val.toLowerCase().trim().slice(0,5));
  const parts = q.question.split("___");
  const instant = feedback==="immediate";
  const submit = () => {
    if(!val.trim()) return;
    Haptics.buzz();
    if(instant) setChecked(true);   // reveal right/wrong
    else onNext(isRight,val);           // "at end": record and move on, no reveal
  };
  // Instant + auto-advance: once revealed, move on after the configured delay.
  useEffect(()=>{
    if(!checked||!autoAdvance) return;
    const id=setTimeout(()=>onNext(isRight,val),autoSec*1000);
    return ()=>clearTimeout(id);
  },[checked]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div>
      <div style={{fontFamily:"'Fraunces',Georgia,serif",fontSize:18,fontWeight:700,color:"var(--color-text-primary)",lineHeight:1.6,marginBottom:20}}>
        {parts[0]}
        <span style={{display:"inline-block",borderBottom:"2px solid #4338ca",minWidth:80,margin:"0 4px",padding:"0 6px",color:"var(--color-accent)",fontStyle:"italic"}}>
          {checked?(q.answer||""):(val||"\u00a0\u00a0\u00a0\u00a0\u00a0\u00a0\u00a0\u00a0")}
        </span>
        {parts[1]||""}
      </div>
      {!checked && <input value={val} onChange={e=>setVal(e.target.value)} onKeyDown={e=>e.key==="Enter"&&submit()} placeholder={t.typeIn} style={{width:"100%",borderRadius:12,border:"1.5px solid var(--color-border-secondary)",background:"var(--color-background-primary)",color:"var(--color-text-primary)",fontSize:14,padding:"12px 14px",fontFamily:"inherit",outline:"none",boxSizing:"border-box",marginBottom:10}}/>}
      {!checked && <button disabled={!val.trim()} onClick={submit} style={{...Sb.btnPrimary,width:"100%",opacity:val.trim()?1:0.35}}>{instant?t.check:(isLast?t.finish:t.next)}</button>}
      {checked && (
        <div style={{borderRadius:10,padding:"12px 14px",background:isRight?"#f0fdf4":"#fef2f2",border:`0.5px solid ${isRight?"#86efac":"#fca5a5"}`,color:isRight?"#15803d":"#b91c1c",marginBottom:14}} className="slide-up">
          <strong>{isRight?t.correct:t.incorrect}</strong>
          {!isRight && <div style={{fontSize:13,marginTop:4}}>{t.fbAnswerLabel} <strong>{q.answer}</strong></div>}
          {q.explanation && <p style={{margin:"6px 0 0",fontSize:13,lineHeight:1.5}}>{q.explanation}</p>}
        </div>
      )}
      {checked && autoAdvance && <AutoAdvanceBar sec={autoSec} runId={q.question} t={t}/>}
      {checked && <button onClick={()=>onNext(isRight,val)} style={{...Sb.btnPrimary,width:"100%",marginTop:autoAdvance?12:0}}>{autoAdvance?(t.skip||t.next):(isLast?t.finish:t.next)}</button>}
    </div>
  );
}

// ── Match Quiz ────────────────────────────────────────────────────────
// Distinct colors so each matched pair is visually linked by both a numbered
// badge and its border color (term on the left ↔ its definition on the right).
const PAIR_COLORS = ["#6366f1","#ec4899","#f59e0b","#10b981","#06b6d4","#8b5cf6","#ef4444","#f43f5e","#0ea5e9","#84cc16"];
const pairColor = n => PAIR_COLORS[((n||1)-1)%PAIR_COLORS.length];
function PairBadge({ n, color }) {
  return <span style={{display:"inline-flex",alignItems:"center",justifyContent:"center",minWidth:18,height:18,padding:"0 5px",borderRadius:9,background:color,color:"#fff",fontSize:10,fontWeight:700,flexShrink:0,marginTop:1}}>{n}</span>;
}

function MatchQuiz({ questions, onDone, t }) {
  const terms = questions.map(q=>q.question);
  const defs  = useRef(questions.map(q=>q.answer||"").sort(()=>Math.random()-0.5)).current;
  const [sel,setSel]         = useState(null);
  const [matches,setMatches] = useState({});
  const [pairNo,setPairNo]   = useState({}); // termIndex -> 1-based pair number
  const [defUsed,setDefUsed] = useState({});
  const [checked,setChecked] = useState(false);
  const [results,setResults] = useState({});
  // Tapping a matched term unpairs it (frees its definition); tapping an
  // unmatched term selects/deselects it. So a learner can always change a match.
  const pickTerm = i => {
    if (checked) return;
    if (matches[i] !== undefined) {
      const di = matches[i];
      setMatches(m => { const c = { ...m }; delete c[i]; return c; });
      setDefUsed(d => ({ ...d, [di]: false }));
      setPairNo(p => { const c = { ...p }; delete c[i]; return c; });
      setSel(null);
      return;
    }
    setSel(s => s === i ? null : i);
  };
  const pickDef = i => {
    if (checked) return;
    // Tapping an already-used definition unpairs it so it can be re-matched.
    if (defUsed[i]) {
      const ti = termForDef(i);
      if (ti !== null) {
        setMatches(m => { const c = { ...m }; delete c[ti]; return c; });
        setPairNo(p => { const c = { ...p }; delete c[ti]; return c; });
      }
      setDefUsed(d => ({ ...d, [i]: false }));
      return;
    }
    if (sel === null) return;
    Haptics.buzz();
    // Smallest free pair number, so colors never collide after an unpair.
    const usedNums = new Set(Object.keys(matches).map(k => pairNo[k]).filter(Boolean));
    let n = 1; while (usedNums.has(n)) n++;
    setPairNo(p=>({...p,[sel]:n}));
    setMatches(m=>({...m,[sel]:i})); setDefUsed(d=>({...d,[i]:true})); setSel(null);
  };
  const check = () => {
    const r={}; const detail=[];
    terms.forEach((_,i)=>{
      const chosen=defs[matches[i]];
      const ok=chosen===questions[i].answer;
      r[i]=ok; detail[i]={isCorrect:ok,chosen};
    });
    setResults(r); setChecked(true);
    setTimeout(()=>onDone(Object.values(r).filter(Boolean).length,terms.length,detail),1800);
  };
  // Which term (if any) a given definition is paired with.
  const termForDef = di => { const k=Object.keys(matches).find(k=>matches[k]===di); return k===undefined?null:Number(k); };
  const allMatched = Object.keys(matches).length===terms.length;
  return (
    <div>
      <p style={{fontSize:13,color:"var(--color-text-secondary)",marginBottom:14,lineHeight:1.5}}>{t.matchTitle}</p>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:14}}>
        <div style={{display:"flex",flexDirection:"column",gap:6}}>
          {terms.map((term,i)=>{
            const matched=matches[i]!==undefined,isSel=sel===i,isOk=checked&&results[i],isBad=checked&&!results[i]&&matched;
            const pc=pairColor(pairNo[i]);
            const bc=isOk?"#22c55e":isBad?"#ef4444":isSel?"#4338ca":matched?pc:"var(--color-border-tertiary)";
            return <button key={i} onClick={()=>pickTerm(i)} style={{display:"flex",alignItems:"flex-start",gap:8,padding:"10px 12px",borderRadius:10,border:"1.5px solid",borderColor:bc,background:isSel?"var(--color-sel-tint)":matched?"var(--color-background-secondary)":"var(--color-background-primary)",fontSize:12,fontWeight:600,cursor:checked?"default":"pointer",color:"var(--color-text-primary)",fontFamily:"inherit",textAlign:"left",transition:"all 0.15s"}}>
              {matched && <PairBadge n={pairNo[i]} color={pc}/>}
              <span style={{flex:1,display:"inline-flex",alignItems:"center",gap:6}}>{isOk&&<Icon name="check" size={14} stroke={2.6} style={{color:"#16a34a",flexShrink:0}}/>}{isBad&&<Icon name="x" size={14} stroke={2.6} style={{color:"#dc2626",flexShrink:0}}/>}{term}</span>
            </button>;
          })}
        </div>
        <div style={{display:"flex",flexDirection:"column",gap:6}}>
          {defs.map((def,i)=>{
            const used=defUsed[i]; const ti=used?termForDef(i):null; const n=ti!==null?pairNo[ti]:null;
            const pc=n?pairColor(n):null;
            return <button key={i} onClick={()=>pickDef(i)} style={{display:"flex",alignItems:"flex-start",gap:8,padding:"10px 12px",borderRadius:10,border:"1.5px solid",borderColor:used?pc:"var(--color-border-tertiary)",background:used?"var(--color-background-secondary)":"var(--color-background-primary)",fontSize:11,cursor:checked?"default":(used||sel!==null)?"pointer":"default",color:"var(--color-text-primary)",fontFamily:"inherit",textAlign:"left",lineHeight:1.4,transition:"all 0.15s"}}>
              {used && n && <PairBadge n={n} color={pc}/>}
              <span style={{flex:1}}>{def}</span>
            </button>;
          })}
        </div>
      </div>
      {!checked && <button disabled={!allMatched} onClick={check} style={{...Sb.btnPrimary,width:"100%",opacity:allMatched?1:0.35}}>{t.checkAll}</button>}
      {checked && <div style={{textAlign:"center",fontSize:14,color:"var(--color-text-secondary)",marginTop:8}}>{t.matchDone}{Object.values(results).filter(Boolean).length}/{terms.length}</div>}
    </div>
  );
}

// ── "Explain why", AI tutor on a wrong answer ────────────────────────
function ExplainBox({ ctx, t }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [turns, setTurns] = useState([]);
  const [ask, setAsk] = useState("");
  const [asking, setAsking] = useState(false);
  const load = async () => {
    setOpen(true);
    if (text || loading) return;
    setLoading(true); setErr("");
    try { setText(await explainAnswer(ctx)); } catch { setErr(t.explainErr); }
    setLoading(false);
  };
  const doAsk = async () => {
    const q = ask.trim(); if (!q || asking) return;
    setAsk(""); setAsking(true);
    try { const a = await followupAnswer({ question: ctx.question, correct: ctx.correct, prior: text, ask: q }); setTurns((p)=>[...p,{q,a}]); }
    catch { setTurns((p)=>[...p,{q,a:t.explainErr}]); }
    setAsking(false);
  };
  if (!open) return (
    <button onClick={load} style={{marginTop:8,marginLeft:23,background:"none",border:"none",color:"var(--color-accent)",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit",padding:0,display:"inline-flex",alignItems:"center",gap:5}}><Icon name="chat" size={13}/>{t.explainWhy}</button>
  );
  return (
    <div style={{marginTop:8,marginLeft:23,background:"var(--color-background-secondary)",border:"0.5px solid var(--color-border-tertiary)",borderRadius:10,padding:"10px 12px"}} className="fade-in">
      {loading && <div style={{fontSize:12.5,color:"var(--color-text-secondary)",display:"inline-flex",alignItems:"center",gap:5}}><Icon name="chat" size={13}/>{t.explainLoading}</div>}
      {err && <div style={{fontSize:12.5,color:"#b91c1c"}}>{err}</div>}
      {text && <div style={{fontSize:12.5,color:"var(--color-text-primary)",lineHeight:1.55,whiteSpace:"pre-wrap"}}>{text}</div>}
      {turns.map((turn,i)=>(
        <div key={i} style={{marginTop:8,paddingTop:8,borderTop:"0.5px solid var(--color-border-tertiary)"}}>
          <div style={{fontSize:12,fontWeight:700,color:"var(--color-text-secondary)",display:"flex",alignItems:"center",gap:5}}><Icon name="chat" size={12} stroke={2}/>{turn.q}</div>
          <div style={{fontSize:12.5,color:"var(--color-text-primary)",lineHeight:1.55,marginTop:3,whiteSpace:"pre-wrap"}}>{turn.a}</div>
        </div>
      ))}
      {text && !loading && (
        <div style={{display:"flex",gap:6,marginTop:10}}>
          <input value={ask} onChange={(e)=>setAsk(e.target.value)} onKeyDown={(e)=>e.key==="Enter"&&doAsk()} placeholder={t.explainAsk} disabled={asking}
            style={{flex:1,borderRadius:8,border:"1px solid var(--color-border-secondary)",background:"var(--color-background-primary)",color:"var(--color-text-primary)",fontSize:12.5,padding:"7px 10px",fontFamily:"inherit",outline:"none",boxSizing:"border-box"}}/>
          <button onClick={doAsk} disabled={asking||!ask.trim()} style={{background:"#4338ca",color:"#fff",border:"none",borderRadius:8,padding:"7px 12px",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit",opacity:(asking||!ask.trim())?0.5:1}}>{asking?"…":t.explainAskBtn}</button>
        </div>
      )}
    </div>
  );
}

// Feature A: a small marker placed at the end of a question (and, in the review,
// next to the answer). Hover tells you what it is; click reveals the exact words
// in the learner's OWN material that the question/answer came from. When nothing
// was found in their notes, it says so, so they know to double-check. Revyy's
// edge: because quizzes come from YOUR notes, we can show the receipt.
function SourceMark({ source, label, quoteLabel, t }) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const has = typeof source === "string" && source.trim().length > 0;
  const ql = quoteLabel || t.srcQuoteLabel;
  return (
    <span style={{position:"relative",display:"inline-flex",verticalAlign:"middle",marginLeft:5}}>
      <button
        type="button"
        onClick={()=>setOpen((o)=>!o)}
        onMouseEnter={()=>setHover(true)}
        onMouseLeave={()=>setHover(false)}
        onBlur={()=>setHover(false)}
        aria-label={label}
        aria-expanded={open}
        style={{display:"inline-flex",alignItems:"center",justifyContent:"center",width:19,height:19,padding:0,borderRadius:"50%",border:"none",cursor:"pointer",background:open?"var(--color-accent)":"var(--color-sel-tint)",color:open?"#fff":"var(--color-accent)",flexShrink:0,lineHeight:0}}>
        <Icon name="help" size={13} stroke={2.2}/>
      </button>
      {hover && !open && (
        <span style={{position:"absolute",bottom:"calc(100% + 6px)",right:0,whiteSpace:"nowrap",background:"var(--color-text-primary)",color:"var(--color-background-primary)",fontSize:10.5,fontWeight:600,padding:"4px 8px",borderRadius:6,pointerEvents:"none",zIndex:60,boxShadow:"0 4px 14px rgba(0,0,0,0.18)"}}>{label}</span>
      )}
      {open && (
        // Fixed, bottom-centered card (not an absolute popover) so it is never
        // clipped by a scroll container and never overlaps the explanation text
        // it sits next to. Tap the dim backdrop to close.
        <>
          <span onClick={()=>setOpen(false)} style={{position:"fixed",inset:0,display:"block",zIndex:70,background:"rgba(0,0,0,0.12)"}}/>
          <span className="fade-in" style={{position:"fixed",left:"50%",bottom:"20px",transform:"translateX(-50%)",display:"block",zIndex:71,width:"max-content",maxWidth:"min(360px,90vw)",background:"var(--color-background-primary)",border:"0.5px solid var(--color-border-tertiary)",borderLeft:`3px solid ${has?"var(--color-accent)":"var(--color-border-secondary)"}`,borderRadius:10,padding:"12px 14px",textAlign:"left",boxShadow:"0 12px 34px rgba(0,0,0,0.24)"}}>
            <span style={{display:"block",fontSize:9.5,fontWeight:800,letterSpacing:0.5,textTransform:"uppercase",color:"var(--color-text-tertiary)",marginBottom:4}}>{has?ql:t.srcVerify}</span>
            <span style={{display:"block",fontSize:12.5,color:"var(--color-text-secondary)",lineHeight:1.55,fontStyle:has?"italic":"normal"}}>{has?`“${source}”`:t.srcUngroundedNote}</span>
          </span>
        </>
      )}
    </span>
  );
}

// Feature B: flag a bad question. If the learner says the answer is WRONG, Revyy
// first VERIFIES the claim against their material + its own knowledge and tells
// them the verdict (the answer holds up, with proof, or they were right and it
// gets corrected). Confusing / off-material flags just rewrite the question. The
// swap goes through onReplace.
function FlagFix({ q, subject, blocks, uiLangName, diff, onReplace, t }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState("");        // "" | "checking" | "writing"
  const [err, setErr] = useState("");
  const [done, setDone] = useState("");        // success message shown after a swap
  const [verdict, setVerdict] = useState(null);// {explanation, source} when the answer holds up
  const doRegen = async (reason) => {
    setBusy("writing"); setErr("");
    try { const nq = await regenerateQuestion({ blocks, q, subject, reason, uiLangName, diff }); onReplace(nq, reason); setVerdict(null); setDone(t.flagReplaced); setOpen(false); }
    catch { setErr(t.flagFailed); }
    finally { setBusy(""); }
  };
  const act = async (reason) => {
    SoundEngine.click(); // acknowledge the report (self-gates on the sound setting)
    if (reason !== "wrong") return doRegen(reason);
    setBusy("checking"); setErr("");
    try {
      const v = await verifyFlaggedQuestion({ blocks, q, uiLangName, diff });
      if (v.verdict === "answer_correct") { setVerdict({ explanation: v.explanation, source: v.answerSource }); setOpen(false); }
      else if (v.replacement) { onReplace(v.replacement, "wrong"); setDone(v.verdict === "student_right" ? t.flagGoodCatch : t.flagClearer); setOpen(false); }
      else { setBusy(""); return doRegen("wrong"); }
    } catch { setErr(t.flagFailed); }
    finally { setBusy((b)=> b === "checking" ? "" : b); }
  };
  if (done) return (
    <div style={{marginTop:10,fontSize:12,color:"#16a34a",fontWeight:700,display:"inline-flex",alignItems:"flex-start",gap:6,textAlign:"left"}}>
      <Icon name="check" size={14} stroke={2.4}/><span>{done}</span>
    </div>
  );
  if (verdict) return (
    <div className="fade-in" style={{marginTop:10,textAlign:"left",background:"var(--color-background-secondary)",border:"0.5px solid var(--color-border-tertiary)",borderLeft:"3px solid #16a34a",borderRadius:10,padding:"11px 12px"}}>
      <div style={{fontSize:12.5,fontWeight:700,color:"var(--color-text-primary)",display:"inline-flex",alignItems:"center",gap:6,marginBottom:5}}><Icon name="check" size={14} stroke={2.4} style={{color:"#16a34a"}}/>{t.flagVerifiedTitle}</div>
      {verdict.explanation && <div style={{fontSize:12.5,color:"var(--color-text-secondary)",lineHeight:1.55}}>{verdict.explanation}</div>}
      {verdict.source && <div style={{marginTop:6,fontSize:12,color:"var(--color-text-secondary)",fontStyle:"italic",borderLeft:"2px solid var(--color-border-secondary)",paddingLeft:8}}>{`“${verdict.source}”`}</div>}
      <button onClick={()=>doRegen("wrong")} style={{marginTop:9,background:"none",border:"none",color:"var(--color-accent)",fontSize:11.5,fontWeight:700,cursor:"pointer",fontFamily:"inherit",padding:0,textDecoration:"underline",textUnderlineOffset:2}}>{t.flagRewriteAnyway}</button>
    </div>
  );
  if (!open) return (
    <button onClick={()=>setOpen(true)} style={{marginTop:10,background:"none",border:"none",color:"var(--color-text-tertiary)",fontSize:11.5,fontWeight:600,cursor:"pointer",fontFamily:"inherit",display:"inline-flex",alignItems:"center",gap:5,padding:0}}>
      <Icon name="alert" size={13} stroke={2}/><span style={{textDecoration:"underline",textUnderlineOffset:2}}>{t.flagBtn}</span>
    </button>
  );
  return (
    <div className="fade-in" style={{marginTop:10,textAlign:"left",background:"var(--color-background-secondary)",border:"0.5px solid var(--color-border-tertiary)",borderRadius:10,padding:"11px 12px"}}>
      {busy ? (
        <div style={{fontSize:12.5,color:"var(--color-text-secondary)",fontWeight:600,display:"inline-flex",alignItems:"center",gap:6}}><Icon name={busy==="checking"?"target":"repeat"} size={13}/>{busy==="checking"?t.flagChecking:t.flagWriting}</div>
      ) : (
        <>
          <div style={{fontSize:11.5,color:"var(--color-text-secondary)",marginBottom:8,fontWeight:600}}>{t.flagPrompt}</div>
          <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
            {[["wrong",t.flagWrong],["unclear",t.flagUnclear],["offnotes",t.flagNotInNotes]].map(([r,label])=>(
              <button key={r} onClick={()=>act(r)} style={{background:"var(--color-background-primary)",border:"1px solid var(--color-border-tertiary)",borderRadius:8,padding:"6px 10px",fontSize:11.5,fontWeight:600,color:"var(--color-text-primary)",cursor:"pointer",fontFamily:"inherit"}}>{label}</button>
            ))}
            <button onClick={()=>{setOpen(false);setErr("");}} style={{background:"none",border:"none",color:"var(--color-text-tertiary)",fontSize:11.5,cursor:"pointer",fontFamily:"inherit",padding:"6px 4px"}}>{t.cancel}</button>
          </div>
          {err && <div style={{fontSize:11.5,color:"#dc2626",marginTop:8}}>{err}</div>}
        </>
      )}
    </div>
  );
}

// Universal mock learning: on the mock review screen, let a learner flag a bad
// question. The flag is aggregated GLOBALLY (by exam + section) so future mock
// generations for everyone avoid questions like it. Best-effort, fires once.
function MockReport({ exam, section, question, t }) {
  const [state, setState] = useState(""); // "" | "busy" | "done"
  if (state === "done") return <div style={{marginTop:6,paddingLeft:22,fontSize:11,color:"#16a34a",fontWeight:600}}>{t.mockReported}</div>;
  return (
    <button disabled={state==="busy"} onClick={async()=>{ setState("busy"); await mockFlagGlobal(exam, section, question); setState("done"); }}
      style={{marginTop:6,marginLeft:22,background:"none",border:"none",color:"var(--color-text-tertiary)",fontSize:11,cursor:state==="busy"?"default":"pointer",fontFamily:"inherit",display:"inline-flex",alignItems:"center",gap:5,padding:0,opacity:state==="busy"?0.6:1}}>
      <Icon name="alert" size={12} stroke={2}/><span style={{textDecoration:"underline",textUnderlineOffset:2}}>{t.flagBtn}</span>
    </button>
  );
}

// ── Share-a-quiz sheet ─────────────────────────────────────────────────
function ShareModal({ link, err, copied, onCopy, onClose, challengeScore, t }) {
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.6)",zIndex:500,display:"flex",alignItems:"flex-end"}} onClick={onClose}>
      <div className="slide-up" onClick={(e)=>e.stopPropagation()} style={{background:"var(--color-background-primary)",borderRadius:"20px 20px 0 0",padding:"26px 20px 36px",width:"100%",maxWidth:520,margin:"0 auto",boxSizing:"border-box"}}>
        <div style={{textAlign:"center",marginBottom:16}}>
          <div style={{marginBottom:8,display:"flex",justifyContent:"center"}}><Icon name="trophy" size={32} style={{color:"var(--color-clay,#b5502f)"}}/></div>
          <h3 style={{margin:"0 0 6px",fontSize:19,fontWeight:700,fontFamily:"'Fraunces',Georgia,serif",color:"var(--color-text-primary)"}}>{challengeScore?t.challengeTitle:t.shareTitle}</h3>
          <p style={{margin:0,fontSize:12.5,color:"var(--color-text-secondary)",lineHeight:1.5}}>{challengeScore?t.challengeDesc.replace("{s}",challengeScore):t.shareDesc}</p>
        </div>
        {err && <div style={{background:"#fef2f2",border:"0.5px solid #fecaca",color:"#b91c1c",borderRadius:10,padding:"9px 12px",fontSize:12.5,marginBottom:12}}>{err}</div>}
        {link && (
          <>
            <div style={{display:"flex",gap:8,marginBottom:12}}>
              <input readOnly value={link} onFocus={(e)=>e.target.select()} style={{flex:1,borderRadius:10,border:"1px solid var(--color-border-secondary)",background:"var(--color-background-secondary)",color:"var(--color-text-primary)",fontSize:12.5,padding:"11px 12px",fontFamily:"inherit",outline:"none",boxSizing:"border-box"}}/>
              <button onClick={onCopy} style={{...Sb.btnPrimary,padding:"11px 16px",fontSize:13,minWidth:96}}>{copied?t.shareCopied:t.shareCopy}</button>
            </div>
            {typeof navigator!=="undefined"&&navigator.share && <button onClick={()=>navigator.share({title:"Revyy quiz",url:link}).catch(()=>{})} style={{...Sb.btnOutline,width:"100%"}}>{t.shareNative}</button>}
          </>
        )}
        <button onClick={onClose} style={{...Sb.btnGhost,width:"100%",marginTop:10}}>{t.notNow||"Close"}</button>
      </div>
    </div>
  );
}

// ── In-app contact / bug report ───────────────────────────────────────
// Posts to the same /api/contact endpoint as the marketing contact form, so a
// user can reach us without leaving the app. Pre-fills the signed-in email and
// attaches lightweight diagnostics (path, language, user agent) to the message.
function ContactModal({ defaultEmail, onClose, t }) {
  const [email, setEmail] = useState(defaultEmail || "");
  const [msg, setMsg] = useState("");
  const [state, setState] = useState("idle"); // idle | sending | sent | error
  const [err, setErr] = useState("");
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) && msg.trim().length > 0;
  const submit = async () => {
    if (!valid || state === "sending") return;
    setState("sending"); setErr("");
    const ctx = `\n\n, sent from the app, \npath: ${location.pathname} · lang: ${document.documentElement.lang} · ${navigator.userAgent}`;
    try {
      const r = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: email.trim(), email: email.trim(), message: msg.trim() + ctx }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(d.error || t.reportError); setState("error"); return; }
      setState("sent");
    } catch { setErr(t.reportError); setState("error"); }
  };
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.6)",zIndex:600,display:"flex",alignItems:"flex-end"}} onClick={onClose}>
      <div className="slide-up" onClick={e=>e.stopPropagation()} style={{background:"var(--color-background-primary)",borderRadius:"20px 20px 0 0",padding:"26px 20px 36px",width:"100%",maxWidth:520,margin:"0 auto",boxSizing:"border-box"}}>
        <div style={{textAlign:"center",marginBottom:16}}>
          <div style={{marginBottom:8,display:"flex",justifyContent:"center",color:"var(--color-accent)"}}><Icon name="chat" size={30} stroke={1.7}/></div>
          <h3 style={{margin:"0 0 6px",fontSize:19,fontWeight:700,fontFamily:"'Fraunces',Georgia,serif",color:"var(--color-text-primary)"}}>{t.reportTitle}</h3>
          <p style={{margin:0,fontSize:12.5,color:"var(--color-text-secondary)",lineHeight:1.5}}>{t.reportSub}</p>
        </div>
        {state === "sent" ? (
          <div style={{textAlign:"center",padding:"14px 0 4px"}}>
            <div style={{marginBottom:10,display:"flex",justifyContent:"center",color:"#16a34a"}}><Icon name="check" size={36} stroke={2}/></div>
            <p style={{fontSize:14,color:"var(--color-text-primary)",fontWeight:600,margin:"0 0 16px",lineHeight:1.5}}>{t.reportSuccess}</p>
            <button onClick={onClose} style={{...Sb.btnPrimary,width:"100%"}}>{t.reportDone}</button>
          </div>
        ) : (
          <>
            {err && <div style={{background:"#fef2f2",border:"0.5px solid #fecaca",color:"#b91c1c",borderRadius:10,padding:"9px 12px",fontSize:12.5,marginBottom:12}}>{err}</div>}
            <label style={{display:"block",fontSize:12,fontWeight:600,color:"var(--color-text-secondary)",marginBottom:5}}>{t.reportEmail}</label>
            <input type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="you@example.com" style={{width:"100%",borderRadius:10,border:"1px solid var(--color-border-secondary)",background:"var(--color-background-secondary)",color:"var(--color-text-primary)",fontSize:13,padding:"11px 12px",fontFamily:"inherit",outline:"none",boxSizing:"border-box",marginBottom:12}}/>
            <label style={{display:"block",fontSize:12,fontWeight:600,color:"var(--color-text-secondary)",marginBottom:5}}>{t.reportMessage}</label>
            <textarea value={msg} onChange={e=>setMsg(e.target.value)} placeholder={t.reportPlaceholder} rows={5} style={{width:"100%",borderRadius:10,border:"1px solid var(--color-border-secondary)",background:"var(--color-background-secondary)",color:"var(--color-text-primary)",fontSize:13,padding:"11px 12px",fontFamily:"inherit",outline:"none",boxSizing:"border-box",resize:"vertical",marginBottom:14}}/>
            <button onClick={submit} disabled={!valid||state==="sending"} style={{...Sb.btnPrimary,width:"100%",opacity:(!valid||state==="sending")?0.5:1}}>{state==="sending"?t.reportSending:t.reportSend}</button>
            <button onClick={onClose} style={{...Sb.btnGhost,width:"100%",fontSize:13,marginTop:8}}>{t.notNow}</button>
          </>
        )}
      </div>
    </div>
  );
}

// ── Settings helpers ──────────────────────────────────────────────────
function Toggle({ on, onChange, disabled }) {
  return (
    <div onClick={()=>!disabled&&onChange(!on)} style={{
      width:44,height:24,borderRadius:12,cursor:disabled?"not-allowed":"pointer",
      background:on?"#4338ca":"var(--color-border-secondary)",
      position:"relative",transition:"background 0.2s",opacity:disabled?0.45:1,
    }}>
      <div style={{position:"absolute",top:2,left:on?22:2,width:20,height:20,
        borderRadius:"50%",background:"#fff",transition:"left 0.18s",
        boxShadow:"0 1px 4px rgba(0,0,0,0.25)"}}/>
    </div>
  );
}

function Seg({ options, value, onChange }) {
  return (
    <div style={{display:"flex",background:"var(--color-background-tertiary)",
      borderRadius:8,padding:2,gap:2}}>
      {options.map(([v,label])=>(
        <button key={v} onClick={()=>onChange(v)} style={{
          padding:"5px 9px",borderRadius:6,border:"none",cursor:"pointer",
          display:"inline-flex",alignItems:"center",justifyContent:"center",minHeight:26,
          fontSize:12,fontWeight:600,fontFamily:"inherit",transition:"all 0.15s",
          background:value===v?"var(--color-background-primary)":"transparent",
          color:value===v?"var(--color-text-primary)":"var(--color-text-secondary)",
          boxShadow:value===v?"0 1px 3px rgba(0,0,0,0.12)":"none",
        }}>{label}</button>
      ))}
    </div>
  );
}

function SettingRow({ label, desc, children, last }) {
  return (
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",
      padding:"12px 18px",borderBottom:last?"none":"0.5px solid var(--color-border-tertiary)",gap:12}}>
      <div style={{flex:1,minWidth:0}}>
        <div style={{fontSize:14,fontWeight:600,color:"var(--color-text-primary)"}}>{label}</div>
        {desc&&<div style={{fontSize:11,color:"var(--color-text-tertiary)",marginTop:2,lineHeight:1.4}}>{desc}</div>}
      </div>
      <div style={{flexShrink:0}}>{children}</div>
    </div>
  );
}

function SectionLabel({ label }) {
  return (
    <div style={{fontSize:10,fontWeight:700,letterSpacing:1.5,textTransform:"uppercase",
      color:"var(--color-text-tertiary)",padding:"16px 18px 6px"}}>
      {label}
    </div>
  );
}

// Usage + question packs (rendered next to the Subscription section).
function UsageSection({ isPro, usage, s, adBusy, onWatchAd, onBuyPack, packBusy, startCheckout, onOpenPacks }) {
  const u = usage || {};
  const used = u.questions_used_today ?? 0;
  const limit = u.daily_limit ?? (isPro ? 250 : 50);
  const pct = Math.min(100, Math.round((used / Math.max(1, limit)) * 100));
  const adsLeft = (u.max_ad_watches ?? 2) - (u.ad_watches_today ?? 0);
  return (
    <>
      <SectionLabel label={s.secUsage || "USAGE"}/>
      <div style={{padding:"4px 18px 14px"}}>
        <div style={{display:"flex",justifyContent:"space-between",fontSize:12.5,color:"var(--color-text-primary)",marginBottom:6}}>
          <span>{s.usageToday || "Questions today"}</span>
          <span style={{fontWeight:700}}>{used} / {limit}{u.remaining != null ? ` · ${u.remaining} ${s.leftWord || "left"}` : ""}</span>
        </div>
        <div style={{height:8,background:"var(--color-background-tertiary)",borderRadius:4,overflow:"hidden"}}>
          <div style={{height:"100%",width:pct + "%",background:pct >= 100 ? "#ef4444" : "#4338ca",borderRadius:4,transition:"width .3s"}}/>
        </div>
        {/* Additional (pack) questions, shown to everyone who has any. */}
        <div style={{fontSize:12,color:"var(--color-text-secondary)",marginTop:8}}>{s.usageBonus || "Extra questions (packs)"}: <strong style={{color:(u.bonus_questions_remaining > 0) ? "#16a34a" : "var(--color-text-primary)"}}>{u.bonus_questions_remaining ?? 0}</strong></div>

        {!isPro && <>
          {/* The X/2 here is scoped to the +questions ad, it's not all ads. */}
          {adsLeft > 0
            ? <button disabled={adBusy} onClick={onWatchAd} style={{marginTop:10,width:"100%",background:"#f59e0b",color:"#fff",border:"none",borderRadius:10,padding:"10px",fontSize:13,fontWeight:700,cursor:adBusy ? "default" : "pointer",fontFamily:"inherit",opacity:adBusy ? 0.6 : 1}}>
                {adBusy ? (s.loadingAd || "Loading ad…") : `${(s.watchAdForQuestions || "Watch ad for +{n} questions").replace("{n}", u.ad_question_bonus ?? 10)} · ${u.ad_watches_today ?? 0}/${u.max_ad_watches ?? 2}`}
              </button>
            : <div style={{marginTop:10,width:"100%",background:"var(--color-background-tertiary)",color:"var(--color-text-tertiary)",borderRadius:10,padding:"10px",fontSize:12.5,fontWeight:600,display:"flex",alignItems:"center",justifyContent:"center",gap:6,boxSizing:"border-box"}}>
                <Icon name="alert" size={13} style={{flexShrink:0}}/><span>{(s.adLimitReached || "Daily ad limit reached")} · {u.max_ad_watches ?? 2}/{u.max_ad_watches ?? 2}</span>
              </div>}
          <button onClick={() => startCheckout?.(STRIPE_MONTHLY_PRICE)} style={{marginTop:8,width:"100%",background:"#4338ca",color:"#fff",border:"none",borderRadius:10,padding:"10px",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>
            <span style={{display:"inline-flex",alignItems:"center",gap:7,justifyContent:"center"}}><Icon name="spark" size={15}/>{s.upgradeForMore || "Upgrade to Pro, 250 questions/day"}</span>
          </button>
        </>}

        {/* Question packs, available to all users; other limits still apply. */}
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",margin:"14px 0 6px"}}>
          <span style={{fontSize:12,fontWeight:700,color:"var(--color-text-primary)"}}>{s.buyPacks || "Question packs"}</span>
          {onOpenPacks && <button onClick={onOpenPacks} style={{fontSize:11,color:"var(--color-accent)",background:"none",border:"none",cursor:"pointer",fontFamily:"inherit",fontWeight:700,padding:0}}>{s.comparePacks || "View all →"}</button>}
        </div>
        {QUESTION_PACKS.map((p) => (
          <div key={p.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",border:"0.5px solid var(--color-border-tertiary)",borderRadius:10,padding:"9px 12px",marginBottom:6}}>
            <span style={{fontSize:13,color:"var(--color-text-primary)"}}><strong>{p.q}</strong> {s.questionsWord || "questions"} · {p.price}</span>
            <button disabled={!!packBusy} onClick={() => onBuyPack(p.id)} style={{background:"#4338ca",color:"#fff",border:"none",borderRadius:8,padding:"6px 14px",fontSize:12,fontWeight:700,cursor:packBusy ? "default" : "pointer",fontFamily:"inherit",opacity:(packBusy && packBusy !== p.id) ? 0.5 : 1}}>
              {packBusy === p.id ? (s.opening || "…") : (s.buyBtn || "Buy")}
            </button>
          </div>
        ))}
      </div>
    </>
  );
}

function SettingsPanel({ draft, update, onApply, onCancel, onSignOut, onDeleteAccount, requiresPassword, onReauthenticate, isPro, onManageSubscription, signedIn = true, t }) {
  const s = t.set || {};
  const { user, subPlan, periodEnd, cancelAtPeriodEnd, openPortal, startCheckout, refreshProfile, usage, refreshUsage, watchAd, buyPack } = useAuth();
  // Language is edited on the draft (like every other setting) and applied on Save.
  const acctSrs = useSRS();                 // review-deck stats for the header
  const acctStats = useStudyStats();        // streak + accuracy
  const clerk = useClerk();                 // "manage login & security"
  const [adBusy, setAdBusy] = useState(false);
  const [packBusy, setPackBusy] = useState("");
  const [showPacks, setShowPacks] = useState(false);
  const [showContact, setShowContact] = useState(false);
  useEffect(() => { refreshUsage?.(); }, [refreshUsage]);
  const onWatchAd = async () => { if (adBusy) return; setAdBusy(true); await watchAd?.(); setAdBusy(false); };
  const onBuyPack = async (pack) => { if (packBusy) return; setPackBusy(pack); const r = await buyPack?.(pack); if (r?.error) setPackBusy(""); };
  const [checkingSub, setCheckingSub] = useState(false);
  const doRefreshSub = async () => { setCheckingSub(true); try { await refreshProfile?.(); } finally { setCheckingSub(false); } };
  const [confirmDel, setConfirmDel] = useState(false);
  const [delBusy,    setDelBusy]    = useState(false);
  const [delErr,     setDelErr]     = useState("");
  const [delPwd,     setDelPwd]     = useState("");
  const [portalBusy, setPortalBusy] = useState("");        // "" | "manage" | "cancel"
  const [portalErr,  setPortalErr]  = useState("");
  const [showUpgrade,setShowUpgrade]= useState(false);
  const [coBusy,     setCoBusy]     = useState("");        // "" | "monthly" | "yearly"
  const [coErr,      setCoErr]      = useState("");
  const doManage = async () => {
    setPortalErr(""); setPortalBusy("manage");
    const res = await (onManageSubscription ? onManageSubscription() : openPortal()); // redirects on success
    if (res?.error) { setPortalBusy(""); setPortalErr(res.error); }
  };
  const doCancel = async () => {
    setPortalErr(""); setPortalBusy("cancel");
    const res = await openPortal("cancel");        // deep-link to Stripe cancellation
    if (res?.error) { setPortalBusy(""); setPortalErr(res.error); }
  };
  const doUpgrade = async (priceId, which) => {
    setCoErr(""); setCoBusy(which);
    const res = await startCheckout(priceId);      // redirects to Stripe Checkout
    if (res?.error) { setCoBusy(""); setCoErr(res.error); }
  };
  const closeConfirm = () => { if (!delBusy) { setConfirmDel(false); setDelErr(""); setDelPwd(""); } };
  const runDelete = async () => {
    if (requiresPassword && !delPwd) { setDelErr("Please enter your password to confirm."); return; }
    setDelBusy(true); setDelErr("");
    // Re-authenticate first so deletion requires a valid password.
    if (requiresPassword) {
      const { error } = await onReauthenticate(delPwd);
      if (error) { setDelBusy(false); setDelErr("Incorrect password. Please try again."); return; }
    }
    const res = await onDeleteAccount?.();
    // On success the app navigates away and this panel unmounts; on failure show why.
    if (res?.error) { setDelBusy(false); setDelErr(res.error); }
  };
  if (!draft) return null;
  const DEFAULTS = {theme:'system',fontSize:'medium',animations:true,sound:true,
    volume:70,haptics:false,feedback:'immediate',autoAdvance:false,autoAdvanceSec:5,defaultDiff:1,defaultQCount:10};
  return (
    <div style={{position:"fixed",inset:0,zIndex:600,display:"flex",pointerEvents:"all"}}>
      <div onClick={onCancel} style={{flex:1,background:"rgba(0,0,0,0.45)",backdropFilter:"blur(1px)"}}/>
      <div className="settings-panel" style={{
        width:"min(340px,88vw)",height:"100%",
        background:"var(--color-background-primary, #ffffff)",
        display:"flex",flexDirection:"column",
        boxShadow:"-6px 0 28px rgba(0,0,0,0.22)",
        borderLeft:"0.5px solid var(--color-border-secondary)",
      }}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",
          padding:"16px 18px 14px",borderBottom:"0.5px solid var(--color-border-tertiary)",flexShrink:0}}>
          {signedIn && user ? (
            <div style={{display:"flex",alignItems:"center",gap:11,minWidth:0}}>
              <div style={{width:40,height:40,borderRadius:"50%",background:"linear-gradient(135deg,#4338ca,#6366f1)",color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",fontSize:17,fontWeight:700,flexShrink:0}}>{(((draft.nickname||"").trim())||user.email||"?").charAt(0).toUpperCase()}</div>
              <div style={{minWidth:0}}>
                <div style={{fontSize:13.5,fontWeight:700,color:"var(--color-text-primary)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:170}}>{((draft.nickname||"").trim())||user.email||"Your account"}</div>
                <span style={{fontSize:9.5,fontWeight:800,letterSpacing:0.5,padding:"2px 8px",borderRadius:999,color:isPro?"#422006":"var(--color-text-secondary)",background:isPro?"linear-gradient(135deg,#fde68a,#f59e0b)":"var(--color-background-tertiary)",border:isPro?"none":"0.5px solid var(--color-border-secondary)",display:"inline-block",marginTop:3}}>{isPro?"✦ PRO":t.freePlanBadge}</span>
              </div>
            </div>
          ) : (
            <span style={{fontSize:18,fontWeight:700,fontFamily:"'Fraunces',Georgia,serif",color:"var(--color-text-primary)"}}>{s.title||"Settings"}</span>
          )}
          <button onClick={onCancel} style={{background:"none",border:"none",fontSize:20,
            cursor:"pointer",color:"var(--color-text-secondary)",lineHeight:1,padding:"2px 6px",flexShrink:0}}>✕</button>
        </div>

        <div style={{flex:1,overflowY:"auto"}}>
          {/* Your progress, makes the account a study home, not just billing */}
          <div style={{padding:"16px 18px 6px"}}>
            <div style={{fontSize:10.5,fontWeight:800,letterSpacing:0.8,color:"var(--color-text-tertiary)",textTransform:"uppercase",marginBottom:10}}>{t.progressTitle}</div>
            <div style={{display:"flex",gap:8}}>
              {[
                { v: <span style={{display:"inline-flex",alignItems:"center",gap:5,justifyContent:"center"}}><Icon name="flame" size={16} stroke={1.8} style={{color:"#f97316"}}/>{acctStats.streak}</span>, l: t.dayStreak },
                { v: acctStats.accuracy != null ? `${acctStats.accuracy}%` : "0%", l: t.accuracyLbl },
                { v: acctSrs.totalCount, l: t.inReviewLbl },
              ].map(({ v, l }, i) => (
                <div key={i} style={{flex:1,background:"var(--color-background-secondary)",borderRadius:12,padding:"12px 4px",textAlign:"center",border:"0.5px solid var(--color-border-tertiary)"}}>
                  <div style={{fontSize:15.5,fontWeight:800,color:"var(--color-text-primary)"}}>{v}</div>
                  <div style={{fontSize:10,color:"var(--color-text-secondary)",marginTop:3}}>{l}</div>
                </div>
              ))}
            </div>
            {acctSrs.dueCount > 0 && <div style={{fontSize:11.5,color:"var(--color-accent)",fontWeight:600,marginTop:9,display:"flex",alignItems:"center",justifyContent:"center",gap:4}}><Icon name="repeat" size={13}/>{acctSrs.dueCount} card{acctSrs.dueCount>1?"s":""} due for review today</div>}
          </div>

          {signedIn && user && (
            <div style={{padding:"14px 18px 6px"}}>
              <div style={{fontSize:13,fontWeight:600,color:"var(--color-text-primary)",marginBottom:6}}>{t.nickLabel}</div>
              <input value={draft.nickname||""} maxLength={24} onChange={e=>update("nickname",e.target.value)} placeholder={(user.email||"").split("@")[0]||t.nickLabel}
                style={{width:"100%",borderRadius:10,border:"1px solid var(--color-border-secondary)",background:"var(--color-background-primary)",color:"var(--color-text-primary)",fontSize:14,padding:"10px 12px",fontFamily:"inherit",outline:"none",boxSizing:"border-box"}}/>
              <div style={{fontSize:11,color:"var(--color-text-tertiary)",marginTop:5,lineHeight:1.4}}>{t.nickHint}</div>
            </div>
          )}

          <SectionLabel label={s.secAppearance}/>
          <SettingRow label={s.theme} desc={draft.theme==="light"?s.themeLight:draft.theme==="dark"?s.themeDark:s.themeFollows}>
            <Seg options={[["system",s.segAuto],["light",<Icon name="sun" size={15}/>],["dark",<Icon name="moon" size={15}/>]]} value={draft.theme} onChange={v=>update("theme",v)}/>
          </SettingRow>
          <SettingRow label={s.fontSize} desc={draft.fontSize==="small"?s.fontCompact:""}>
            <Seg options={[["small","S"],["medium","M"],["large","L"]]} value={draft.fontSize} onChange={v=>update("fontSize",v)}/>
          </SettingRow>
          <SettingRow label={s.animations} desc={s.animationsDesc}>
            <Toggle on={draft.animations} onChange={v=>update("animations",v)}/>
          </SettingRow>
          <SettingRow label={<span style={{display:"inline-flex",alignItems:"center",gap:6}}><Icon name="globe" size={14}/>{s.language||"Language"}</span>} desc={LANGS[draft.lang]?.name}>
            <select value={draft.lang} onChange={e=>update("lang",e.target.value)} style={{border:"0.5px solid var(--color-border-secondary)",borderRadius:8,background:"var(--color-background-tertiary)",color:"var(--color-text-primary)",fontSize:13,padding:"6px 8px",fontFamily:"inherit",outline:"none",maxWidth:150,cursor:"pointer"}}>
              {Object.entries(LANGS).map(([code,l])=><option key={code} value={code}>{l.name}</option>)}
            </select>
          </SettingRow>

          <SectionLabel label={s.secSound}/>
          <SettingRow label={s.soundEffects}>
            <Toggle on={draft.sound} onChange={v=>update("sound",v)}/>
          </SettingRow>
          <SettingRow label={s.volume+"  "+draft.volume+"%"} desc={!draft.sound?s.volumeNeedSound:undefined}>
            <div style={{display:"flex",alignItems:"center",gap:6,width:130}}>
              <Icon name="volume" size={14} style={{color:"var(--color-text-tertiary)",flexShrink:0}}/>
              <input type="range" min={0} max={100} step={5} value={draft.volume}
                onChange={e=>update("volume",parseInt(e.target.value))}
                disabled={!draft.sound}
                style={{flex:1,accentColor:"#4338ca",cursor:draft.sound?"pointer":"not-allowed",opacity:draft.sound?1:0.4}}/>
              <Icon name="volume" size={17} style={{color:"var(--color-text-secondary)",flexShrink:0}}/>
            </div>
          </SettingRow>

          <SectionLabel label={s.secHaptics}/>
          <SettingRow label={s.vibration} desc={s.vibrationDesc}>
            <Toggle on={draft.haptics} onChange={v=>update("haptics",v)}/>
          </SettingRow>

          <SectionLabel label={s.secBehaviour}/>
          <SettingRow label={s.feedback}
            desc={draft.feedback==="immediate"?s.feedbackImmediate:s.feedbackEnd}>
            <Seg options={[["immediate",s.segInstant],["end",s.segAtEnd]]} value={draft.feedback} onChange={v=>update("feedback",v)}/>
          </SettingRow>
          <SettingRow label={s.autoAdvance} desc={s.autoAdvanceDesc}>
            <Toggle on={draft.autoAdvance} onChange={v=>update("autoAdvance",v)}/>
          </SettingRow>
          {draft.autoAdvance && (
            <SettingRow label={s.autoAdvanceTime+"  "+(draft.autoAdvanceSec||5)+"s"} desc={s.autoAdvanceTimeDesc}>
              <div style={{display:"flex",alignItems:"center",gap:6,width:130}}>
                <span style={{fontSize:11,color:"var(--color-text-tertiary)"}}>1s</span>
                <input type="range" min={1} max={15} step={1} value={draft.autoAdvanceSec||5}
                  onChange={e=>update("autoAdvanceSec",parseInt(e.target.value))}
                  style={{flex:1,accentColor:"#4338ca",cursor:"pointer"}}/>
                <span style={{fontSize:11,color:"var(--color-text-tertiary)"}}>15s</span>
              </div>
            </SettingRow>
          )}
          <SettingRow label={s.defaultDiff} desc={s.defaultDiffDesc}>
            <Seg options={[["0",s.segEasy],["1",s.segMed],["2",s.segHard]]} value={String(draft.defaultDiff)} onChange={v=>update("defaultDiff",parseInt(v))}/>
          </SettingRow>
          <SettingRow label={s.defaultQ} desc={s.defaultQDesc} last>
            <Seg options={[["5","5"],["10","10"],["15","15"],["20","20"]]} value={String(draft.defaultQCount)} onChange={v=>update("defaultQCount",parseInt(v))}/>
          </SettingRow>

          <div style={{margin:"14px 18px 4px",padding:"12px 14px",background:"var(--color-background-secondary)",
            borderRadius:10,border:"0.5px solid var(--color-border-tertiary)"}}>
            <div style={{fontSize:12,fontWeight:600,color:"var(--color-text-primary)",marginBottom:3}}>{s.comingTitle}</div>
            <div style={{fontSize:11,color:"var(--color-text-secondary)",lineHeight:1.5}}>{s.comingDesc}</div>
          </div>

          <button onClick={()=>Object.entries(DEFAULTS).forEach(([k,v])=>update(k,v))}
            style={{margin:"8px 18px 8px",width:"calc(100% - 36px)",background:"none",
              border:"1px solid var(--color-border-secondary)",borderRadius:12,padding:"9px",
              fontSize:12,color:"var(--color-text-tertiary)",cursor:"pointer",fontFamily:"inherit",display:"block"}}>
            {s.resetAll}
          </button>

          <SectionLabel label={s.secHelp}/>
          <button onClick={()=>setShowContact(true)}
            style={{margin:"4px 18px 8px",width:"calc(100% - 36px)",display:"flex",alignItems:"center",justifyContent:"space-between",
              background:"var(--color-background-secondary)",border:"0.5px solid var(--color-border-tertiary)",borderRadius:12,padding:"13px 16px",
              fontSize:13.5,fontWeight:600,color:"var(--color-text-primary)",cursor:"pointer",fontFamily:"inherit"}}>
            <span style={{display:"inline-flex",alignItems:"center",gap:8}}><Icon name="chat" size={16}/>{s.reportBug}</span><span style={{color:"var(--color-text-tertiary)",fontSize:18}}>›</span>
          </button>

          {signedIn ? (<>
          <UsageSection isPro={isPro} usage={usage} s={s} adBusy={adBusy} onWatchAd={onWatchAd} onBuyPack={onBuyPack} packBusy={packBusy} startCheckout={startCheckout} onOpenPacks={()=>setShowPacks(true)}/>

          <SectionLabel label={s.secSubscription}/>
          <div style={{margin:"4px 18px 6px",padding:"14px 16px",borderRadius:12,
            border:isPro?"1px solid #86efac":"0.5px solid var(--color-border-tertiary)",
            background:isPro?"var(--color-background-success)":"var(--color-background-secondary)"}}>
            {isPro ? (
              <>
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:8,marginBottom:8}}>
                  <span style={{fontSize:15,fontWeight:700,color:"var(--color-text-primary)",display:"inline-flex",alignItems:"center",gap:6}}><Icon name="spark" size={15} style={{color:"var(--color-accent)"}}/>Revyy Pro</span>
                  <span style={{fontSize:10,fontWeight:700,background:"#dcfce7",color:"#15803d",border:"0.5px solid #86efac",borderRadius:8,padding:"3px 9px"}}>{s.proActive}</span>
                </div>
                <div style={{fontSize:12.5,color:"var(--color-text-secondary)",lineHeight:1.7}}>
                  {subPlan && <div>{s.planWord}: <strong style={{color:"var(--color-text-primary)"}}>{subPlan==="yearly"?`${t.planYearly} · €39.99/yr`:`${t.planMonthly} · €4.99/mo`}</strong></div>}
                  {periodEnd && !cancelAtPeriodEnd && <div>{s.nextBilling}: <strong style={{color:"var(--color-text-primary)"}}>{fmtDate(periodEnd)}</strong></div>}
                </div>
                {cancelAtPeriodEnd && periodEnd && (
                  <div style={{marginTop:10,background:"#fffbeb",border:"0.5px solid #fcd34d",borderRadius:10,padding:"9px 12px",fontSize:12,color:"#92400e",lineHeight:1.5}}>
                    {s.accessUntil} <strong>{fmtDate(periodEnd)}</strong>.
                  </div>
                )}
                <button onClick={doManage} disabled={!!portalBusy}
                  style={{width:"100%",marginTop:12,background:"var(--color-background-primary)",
                    border:"1px solid var(--color-border-secondary)",borderRadius:12,padding:"11px",
                    fontSize:13,fontWeight:600,color:"var(--color-text-primary)",cursor:portalBusy?"default":"pointer",fontFamily:"inherit",opacity:portalBusy?0.6:1}}>
                  {portalBusy==="manage" ? s.opening : <span style={{display:"inline-flex",alignItems:"center",gap:7,justifyContent:"center"}}><Icon name="card" size={15}/>{t.manageSubscription}</span>}
                </button>
                {!cancelAtPeriodEnd && (
                  <button onClick={doCancel} disabled={!!portalBusy}
                    style={{width:"100%",marginTop:8,background:"none",
                      border:"1px solid var(--color-border-secondary)",borderRadius:12,padding:"11px",
                      fontSize:13,fontWeight:500,color:"#dc2626",cursor:portalBusy?"default":"pointer",fontFamily:"inherit",opacity:portalBusy?0.6:1}}>
                    {portalBusy==="cancel" ? s.opening : s.cancelSub}
                  </button>
                )}
                {portalErr && <div style={{marginTop:8,background:"#fef2f2",border:"1px solid #fecaca",color:"#b91c1c",borderRadius:10,padding:"8px 11px",fontSize:12,lineHeight:1.4}}>{portalErr}</div>}
                <button onClick={doRefreshSub} disabled={checkingSub}
                  style={{width:"100%",marginTop:8,background:"none",border:"none",
                    fontSize:12,fontWeight:500,color:"var(--color-text-tertiary)",cursor:checkingSub?"default":"pointer",fontFamily:"inherit"}}>
                  {checkingSub ? "Checking…" : <span style={{display:"inline-flex",alignItems:"center",gap:6,justifyContent:"center"}}><Icon name="repeat" size={13}/>Refresh subscription status</span>}
                </button>
              </>
            ) : (
              <>
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:8,marginBottom:8}}>
                  <span style={{fontSize:15,fontWeight:700,color:"var(--color-text-primary)"}}>{s.freePlan}</span>
                  <span style={{fontSize:10,fontWeight:700,background:"var(--color-background-tertiary)",color:"var(--color-text-secondary)",border:"0.5px solid var(--color-border-secondary)",borderRadius:8,padding:"3px 9px"}}>{s.freeBadge}</span>
                </div>
                <ul style={{margin:"0 0 2px",padding:0,listStyle:"none",fontSize:12.5,color:"var(--color-text-secondary)",lineHeight:1.9}}>
                  <li>· {FREE_DAILY} {s.freeLimQuizzes}</li>
                  <li>· {s.freeLimMcq}</li>
                  <li>· {s.freeLimAds}</li>
                </ul>
                <button onClick={()=>{setCoErr("");setShowUpgrade(true);}}
                  style={{width:"100%",marginTop:10,background:"#4338ca",color:"#fff",
                    border:"none",borderRadius:12,padding:"12px",fontSize:14,fontWeight:700,
                    cursor:"pointer",fontFamily:"'Fraunces',Georgia,serif",boxShadow:"0 2px 12px #4338ca44"}}>
                  {t.upgradeToPro} →
                </button>
                <p style={{fontSize:11,color:"var(--color-text-tertiary)",textAlign:"center",margin:"9px 0 0",lineHeight:1.5}}>{t.cancelAnytime}</p>
                <button onClick={doRefreshSub} disabled={checkingSub}
                  style={{width:"100%",marginTop:8,background:"none",border:"none",
                    fontSize:12,fontWeight:500,color:"var(--color-text-tertiary)",cursor:checkingSub?"default":"pointer",fontFamily:"inherit"}}>
                  {checkingSub ? "Checking…" : <span style={{display:"inline-flex",alignItems:"center",gap:6,justifyContent:"center"}}><Icon name="repeat" size={13}/>Already paid? Refresh status</span>}
                </button>
              </>
            )}
          </div>

          <SectionLabel label={s.secAccount}/>
          <div style={{padding:"4px 18px 6px",display:"flex",flexDirection:"column",gap:9}}>
            <button onClick={()=>{ try { clerk.openUserProfile(); } catch { /* Clerk not ready */ } }}
              style={{width:"100%",background:"var(--color-background-secondary)",
                border:"1px solid var(--color-border-secondary)",borderRadius:12,padding:"11px",
                fontSize:13,fontWeight:600,color:"var(--color-text-primary)",cursor:"pointer",fontFamily:"inherit"}}>
              <span style={{display:"inline-flex",alignItems:"center",gap:8,justifyContent:"center"}}><Icon name="lock" size={15}/>Manage login &amp; security</span>
            </button>
            <button onClick={onSignOut}
              style={{width:"100%",background:"var(--color-background-secondary)",
                border:"1px solid var(--color-border-secondary)",borderRadius:12,padding:"11px",
                fontSize:13,fontWeight:600,color:"var(--color-text-primary)",cursor:"pointer",fontFamily:"inherit"}}>
              ↩ {s.signOut}
            </button>
          </div>

          {/* Danger Zone */}
          <div style={{margin:"14px 18px 22px",padding:"16px",borderRadius:12,
            border:"1.5px solid #ef4444",background:"rgba(239,68,68,0.07)"}}>
            <div style={{fontSize:12,fontWeight:700,color:"#ef4444",marginBottom:8}}>{s.deletionTitle}</div>
            <div style={{fontSize:12,color:"var(--color-text-secondary)",lineHeight:1.55,marginBottom:13}}>
              {s.deletionDesc}
            </div>
            <button onClick={()=>{setDelErr("");setConfirmDel(true);}}
              style={{width:"100%",background:"#dc2626",border:"none",borderRadius:10,padding:"11px",
                fontSize:13,fontWeight:700,color:"#fff",cursor:"pointer",fontFamily:"inherit"}}>
              {s.deleteAccount}
            </button>
          </div>
          </>) : (
          <div style={{padding:"18px"}}>
            <div style={{padding:"16px",borderRadius:12,border:"0.5px solid var(--color-border-secondary)",background:"var(--color-background-secondary)",textAlign:"center"}}>
              <div style={{fontSize:13,color:"var(--color-text-secondary)",lineHeight:1.6,marginBottom:12}}>{t.loginPrompt}</div>
              <button onClick={()=>window.location.assign("/login")}
                style={{width:"100%",background:"#4338ca",color:"#fff",border:"none",borderRadius:12,padding:"12px",fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:"'Fraunces',Georgia,serif",boxShadow:"0 2px 12px #4338ca44"}}>
                {t.loginOrSignup}
              </button>
            </div>
          </div>
          )}
        </div>

        <div style={{padding:"12px 18px 18px",borderTop:"0.5px solid var(--color-border-tertiary)",
          background:"var(--color-background-primary)",flexShrink:0,display:"flex",gap:10}}>
          <button onClick={onCancel} style={{flex:1,background:"var(--color-background-secondary)",
            border:"0.5px solid var(--color-border-secondary)",borderRadius:12,padding:"12px",
            fontSize:13,fontWeight:500,cursor:"pointer",fontFamily:"inherit",
            color:"var(--color-text-secondary)"}}>{s.cancel}</button>
          <button onClick={onApply} style={{flex:2,background:"#4338ca",color:"#fff",
            border:"none",borderRadius:12,padding:"12px",fontSize:14,fontWeight:700,
            cursor:"pointer",fontFamily:"'Fraunces',Georgia,serif",
            boxShadow:"0 2px 12px #4338ca44"}}>✓ {s.applySave}</button>
        </div>
      </div>

      {confirmDel && (
        <div style={{position:"fixed",inset:0,zIndex:700,background:"rgba(0,0,0,0.6)",display:"flex",alignItems:"center",justifyContent:"center",padding:"20px"}} onClick={closeConfirm}>
          <div className="slide-up" onClick={e=>e.stopPropagation()} style={{background:"var(--color-background-primary)",borderRadius:16,padding:"26px 22px",maxWidth:340,width:"100%",textAlign:"center",boxShadow:"0 8px 32px rgba(0,0,0,0.28)"}}>
            <div style={{marginBottom:12,display:"flex",justifyContent:"center",color:"#dc2626"}}><Icon name="alert" size={34} stroke={1.9}/></div>
            <h3 style={{margin:"0 0 8px",fontSize:18,fontWeight:700,color:"var(--color-text-primary)",fontFamily:"'Fraunces',Georgia,serif"}}>{s.confirmTitle}</h3>
            <p style={{margin:"0 0 16px",fontSize:13,color:"var(--color-text-secondary)",lineHeight:1.55}}>{s.confirmDesc}</p>
            {requiresPassword ? (
              <div style={{textAlign:"left",marginBottom:14}}>
                <label style={{display:"block",fontSize:12.5,fontWeight:600,color:"var(--color-text-primary)",marginBottom:6}}>{s.confirmPwdLabel}</label>
                <input
                  type="password" autoFocus value={delPwd} disabled={delBusy}
                  onChange={e=>setDelPwd(e.target.value)}
                  onKeyDown={e=>{ if(e.key==="Enter" && delPwd && !delBusy) runDelete(); }}
                  placeholder={s.pwdPlaceholder}
                  autoComplete="current-password"
                  style={{width:"100%",boxSizing:"border-box",padding:"11px 13px",fontSize:14,fontFamily:"inherit",borderRadius:11,border:"1px solid var(--color-border-secondary)",background:"var(--color-background-primary)",color:"var(--color-text-primary)",outline:"none"}}
                />
              </div>
            ) : (
              <div style={{textAlign:"left",background:"var(--color-background-secondary)",border:"0.5px solid var(--color-border-secondary)",borderRadius:10,padding:"10px 12px",fontSize:12,color:"var(--color-text-secondary)",lineHeight:1.5,marginBottom:14}}>
                {s.noPwdNote}
              </div>
            )}
            {delErr && <div style={{background:"#fef2f2",border:"1px solid #fecaca",color:"#b91c1c",borderRadius:10,padding:"9px 12px",fontSize:12.5,lineHeight:1.4,marginBottom:14,textAlign:"left"}}>{delErr}</div>}
            <div style={{display:"flex",gap:10}}>
              <button onClick={closeConfirm} disabled={delBusy} style={{flex:1,background:"var(--color-background-secondary)",color:"var(--color-text-primary)",border:"1px solid var(--color-border-secondary)",borderRadius:12,padding:"12px",fontSize:14,fontWeight:500,cursor:delBusy?"default":"pointer",fontFamily:"inherit",opacity:delBusy?0.6:1}}>{s.cancel}</button>
              <button onClick={runDelete} disabled={delBusy || (requiresPassword && !delPwd)} style={{flex:1,background:"#dc2626",color:"#fff",border:"none",borderRadius:12,padding:"12px",fontSize:14,fontWeight:700,cursor:(delBusy||(requiresPassword&&!delPwd))?"default":"pointer",fontFamily:"inherit",opacity:(delBusy||(requiresPassword&&!delPwd))?0.6:1}}>{delBusy?s.deleting:s.delete}</button>
            </div>
          </div>
        </div>
      )}

      {showUpgrade && (
        <ProModal
          onClose={()=>{ setShowUpgrade(false); setCoErr(""); }}
          onMonthly={()=>doUpgrade(STRIPE_MONTHLY_PRICE,"monthly")}
          onYearly={()=>doUpgrade(STRIPE_YEARLY_PRICE,"yearly")}
          busy={coBusy} error={coErr} t={t}
        />
      )}
      {showPacks && <PacksModal onClose={()=>setShowPacks(false)} buyPack={buyPack} t={t}/>}
      {showContact && <ContactModal defaultEmail={user?.email||""} onClose={()=>setShowContact(false)} t={t}/>}
    </div>
  );
}

function ExitModal({ show, onStay, onLeave, message, title, stayLabel, leaveLabel, stayGreen }) {
  const lc = useLang(); const t = (lc && lc.t) || {};
  if (!show) return null;
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.55)",zIndex:550,display:"flex",alignItems:"center",justifyContent:"center",padding:"20px"}}>
      <div className="slide-up" style={{background:"var(--color-background-primary)",borderRadius:16,padding:"28px 22px",maxWidth:320,width:"100%",textAlign:"center",boxShadow:"0 8px 32px rgba(0,0,0,0.2)"}}>
        <div style={{marginBottom:12,display:"flex",justifyContent:"center",color:"#f59e0b"}}><Icon name="alert" size={32} stroke={1.9}/></div>
        <h3 style={{margin:"0 0 8px",fontSize:17,fontWeight:700,color:"var(--color-text-primary)",fontFamily:"'Fraunces',Georgia,serif"}}>{title||t.exitTitle||"Leave this page?"}</h3>
        <p style={{margin:"0 0 22px",fontSize:13,color:"var(--color-text-secondary)",lineHeight:1.5}}>{message||t.exitMsg||"Your progress will be lost and cannot be recovered."}</p>
        <div style={{display:"flex",gap:10}}>
          <button onClick={onStay}  style={{flex:1,background:stayGreen?"#16a34a":"var(--color-background-secondary)",color:stayGreen?"#fff":"var(--color-text-primary)",border:stayGreen?"none":"1px solid var(--color-border-secondary)",borderRadius:12,padding:"12px",fontSize:14,fontWeight:stayGreen?700:500,cursor:"pointer",fontFamily:"inherit"}}>{stayLabel||t.stayBtn||"Stay"}</button>
          <button onClick={onLeave} style={{flex:1,background:"#ef4444",color:"#fff",border:"none",borderRadius:12,padding:"12px",fontSize:14,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>{leaveLabel||t.leaveBtn||"Leave"}</button>
        </div>
      </div>
    </div>
  );
}

// Pause overlay, strong blur over the whole exam so nothing is visible/clickable.
function PauseOverlay({ onResume }) {
  const lc=useLang(); const t=(lc&&lc.t)||{};
  return (
    <div style={{position:"fixed",inset:0,zIndex:900,display:"flex",alignItems:"center",justifyContent:"center",padding:"20px",background:"rgba(15,16,32,0.45)",backdropFilter:"blur(20px)",WebkitBackdropFilter:"blur(20px)"}}>
      <div className="slide-up" style={{textAlign:"center",maxWidth:340}}>
        <div style={{fontSize:30,fontWeight:800,color:"#fff",fontFamily:"'Fraunces',Georgia,serif",marginBottom:8}}>{t.examPausedTitle}</div>
        <div style={{fontSize:14,color:"rgba(255,255,255,0.85)",marginBottom:24}}>{t.progressSaved}</div>
        <button onClick={onResume} style={{background:"#4338ca",color:"#fff",border:"none",borderRadius:14,padding:"15px 40px",fontSize:16,fontWeight:700,cursor:"pointer",fontFamily:"inherit",boxShadow:"0 8px 24px rgba(67,56,202,0.4)"}}>{t.resumeExamBtn}</button>
      </div>
    </div>
  );
}

// Time's-up, non-dismissable, shown while the exam auto-submits.
function TimeUpModal() {
  const lc=useLang(); const t=(lc&&lc.t)||{};
  return (
    <div style={{position:"fixed",inset:0,zIndex:950,display:"flex",alignItems:"center",justifyContent:"center",padding:"20px",background:"rgba(15,16,32,0.7)",backdropFilter:"blur(8px)",WebkitBackdropFilter:"blur(8px)"}}>
      <div style={{background:"var(--color-background-primary)",borderRadius:18,padding:"32px 26px",maxWidth:320,width:"100%",textAlign:"center",boxShadow:"0 12px 40px rgba(0,0,0,0.4)"}}>
        <div style={{marginBottom:12,display:"flex",justifyContent:"center",color:"var(--color-accent)"}}><Icon name="clock" size={42} stroke={1.7}/></div>
        <h3 style={{margin:"0 0 6px",fontSize:22,fontWeight:800,color:"#dc2626",fontFamily:"'Fraunces',Georgia,serif"}}>{t.timesUp}</h3>
        <p style={{margin:"0 0 20px",fontSize:14,color:"var(--color-text-secondary)",lineHeight:1.5}}>{t.examSubmittingNow}</p>
        <div style={{width:36,height:36,margin:"0 auto",border:"3px solid var(--color-border-secondary)",borderTopColor:"#4338ca",borderRadius:"50%",animation:"spin 0.8s linear infinite"}}/>
      </div>
    </div>
  );
}

// Offered on a refresh that interrupted an exam.
function ResumeModal({ info, onResume, onDiscard, fmtClock }) {
  const lc=useLang(); const t=(lc&&lc.t)||{};
  if (!info) return null;
  const answered = info.examAns ? Object.values(info.examAns).filter(v=>v!==undefined&&v!=="").length : 0;
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.55)",zIndex:560,display:"flex",alignItems:"center",justifyContent:"center",padding:"20px"}}>
      <div className="slide-up" style={{background:"var(--color-background-primary)",borderRadius:16,padding:"28px 22px",maxWidth:330,width:"100%",textAlign:"center",boxShadow:"0 8px 32px rgba(0,0,0,0.25)"}}>
        <div style={{marginBottom:12,display:"flex",justifyContent:"center",color:"var(--color-accent)"}}><Icon name="exam" size={32} stroke={1.8}/></div>
        <h3 style={{margin:"0 0 8px",fontSize:18,fontWeight:700,color:"var(--color-text-primary)",fontFamily:"'Fraunces',Georgia,serif"}}>{t.examInProgressQ}</h3>
        <p style={{margin:"0 0 20px",fontSize:13,color:"var(--color-text-secondary)",lineHeight:1.5}}>
          {t.resumeQInfo.replace("{q}",info.examQs?.length||0).replace("{a}",answered)}{info.examTimerOn && info.examTimeLeft!=null ? " · "+fmtClock(info.examTimeLeft)+" left" : ""}
        </p>
        <div style={{display:"flex",gap:10}}>
          <button onClick={onDiscard} style={{flex:1,background:"var(--color-background-secondary)",color:"var(--color-text-primary)",border:"1px solid var(--color-border-secondary)",borderRadius:12,padding:"12px",fontSize:14,fontWeight:500,cursor:"pointer",fontFamily:"inherit"}}>{t.discardBtn}</button>
          <button onClick={onResume} style={{flex:2,background:"#4338ca",color:"#fff",border:"none",borderRadius:12,padding:"12px",fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>{t.continueExamBtn}</button>
        </div>
      </div>
    </div>
  );
}

function Confetti() {
  const pieces = Array.from({length:60},(_,i)=>({
    id:i, x:Math.random()*100, delay:Math.random()*2.5, dur:1.8+Math.random()*2,
    color:["#4338ca","#f59e0b","#22c55e","#ec4899","#3b82f6","#f97316","#8b5cf6","#06b6d4"][i%8],
    size:6+Math.random()*8, shape:i%3,
  }));
  return (
    <div style={{position:"fixed",inset:0,pointerEvents:"none",overflow:"hidden",zIndex:999}}>
      <style>{"@keyframes cfFall{0%{transform:translateY(-20px) rotate(0deg);opacity:1}100%{transform:translateY(110vh) rotate(720deg);opacity:0}}"}</style>
      {pieces.map(p=>(
        <div key={p.id} style={{position:"absolute",left:p.x+"%",top:0,width:p.size,height:p.size,background:p.color,borderRadius:p.shape===0?"50%":"2px",animation:"cfFall "+p.dur+"s "+p.delay+"s ease-in forwards"}}/>
      ))}
    </div>
  );
}

// ── Ad placeholders (free users only) ─────────────────────────────────
// Side 160x600 banners on desktop (where there's empty margin), a 320x50
// bottom banner on mobile. Visibility is controlled by CSS media queries.
// Placeholder ad boxes are OFF while pursuing AdSense approval (see lib/ads.jsx).
// Real ads come from AdSense Auto Ads via the loader in index.html once approved.
const ADS_ENABLED = false; // was: import.meta.env.VITE_ADS_ENABLED === "true"
// Side 160x600 banners (desktop margins) + a 320x50 bottom anchor (mobile).
// `bottom` can be turned off on screens that already have an in-content banner
// so mobile never shows two banners stacked at once.
function AdBanners({ isPro, bottom = true }) {
  const lc=useLang(); const t=(lc&&lc.t)||{};
  const dev = useDev();
  const adsOn = dev.devMode && dev.ads !== null ? dev.ads : ADS_ENABLED;
  if (isPro || !adsOn) return null;
  return (
    <>
      <div className="ad-placeholder rv-ad rv-ad-side rv-ad-left"><span className="rv-ad-label">{t.advertisement}</span></div>
      <div className="ad-placeholder rv-ad rv-ad-side rv-ad-right"><span className="rv-ad-label">{t.advertisement}</span></div>
      {bottom && <div className="ad-placeholder rv-ad rv-ad-bottom"><span className="rv-ad-label">{t.advertisement}</span></div>}
    </>
  );
}

// Full-screen overlay shown while we poll Supabase for Pro status after a
// successful Stripe checkout (the webhook writes is_pro asynchronously).
function ActivatingOverlay({ show }) {
  const lc=useLang(); const t=(lc&&lc.t)||{};
  if (!show) return null;
  return (
    <div style={{position:"fixed",inset:0,zIndex:1000,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:18,padding:24,textAlign:"center",background:"rgba(15,16,32,0.55)",backdropFilter:"blur(8px)",WebkitBackdropFilter:"blur(8px)"}}>
      <div style={{width:48,height:48,borderRadius:"50%",border:"4px solid rgba(255,255,255,0.25)",borderTopColor:"#fff",animation:"spin 0.8s linear infinite"}}/>
      <div style={{color:"#fff",fontSize:18,fontWeight:700,fontFamily:"'Fraunces',Georgia,serif"}}>{t.activatingPro}</div>
      <div style={{color:"rgba(255,255,255,0.8)",fontSize:13.5,maxWidth:320,lineHeight:1.5}}>{t.refreshingAccount}</div>
    </div>
  );
}

// Left-hand passage panel for a mock reading/English/science section. English
// passages carry <u>…</u> portions, rendered as numbered underlines with the
// current question's underline highlighted (like a real ACT English page). The
// passage stays on screen across all of its questions.
function MockPassagePanel({ passage, svg, activeU, label }) {
  const nodes = [];
  if (typeof passage === "string" && passage) {
    const re = /<u>([\s\S]*?)<\/u>/gi;
    let m, last = 0, uN = 0;
    while ((m = re.exec(passage)) !== null) {
      if (m.index > last) nodes.push({ t: passage.slice(last, m.index) });
      nodes.push({ u: ++uN, text: m[1] });
      last = re.lastIndex;
    }
    if (last < passage.length) nodes.push({ t: passage.slice(last) });
  }
  return (
    <div style={{background:"var(--color-background-primary)",border:"0.5px solid var(--color-border-tertiary)",borderRadius:12,padding:"16px 18px"}}>
      {label && <div style={{fontSize:10,fontWeight:800,letterSpacing:0.8,textTransform:"uppercase",color:"var(--color-text-tertiary)",marginBottom:10}}>{label}</div>}
      {svg && <div style={{margin:"0 0 14px",display:"flex",justifyContent:"center"}}><img alt="Figure" src={"data:image/svg+xml;charset=utf-8,"+encodeURIComponent(svg)} style={{maxWidth:"100%",maxHeight:320,background:"#fff",borderRadius:10,border:"0.5px solid var(--color-border-tertiary)",padding:10,boxSizing:"border-box"}}/></div>}
      <div style={{fontSize:14.5,lineHeight:1.75,color:"var(--color-text-primary)",whiteSpace:"pre-wrap"}}>
        {nodes.map((n,i)=> n.u!=null
          ? <span key={i} style={{borderBottom:n.u===activeU?"2px solid #4338ca":"1.5px solid var(--color-text-tertiary)",background:n.u===activeU?"var(--color-sel-tint)":"transparent",fontWeight:n.u===activeU?700:400,padding:"0 1px",borderRadius:2}}>{n.text}<sup style={{fontSize:9,fontWeight:800,color:n.u===activeU?"#4338ca":"var(--color-text-tertiary)",marginLeft:1}}>{n.u}</sup></span>
          : <span key={i}>{n.t}</span>)}
      </div>
    </div>
  );
}

export default function StudyQuiz() {
  const [screen,       setScreen]       = useState("home");
  const { t, lang, setLang } = useLang(); // language control now lives inside the account panel
  const dev = useDev();
  const { isPro, signOut, deleteAccount, reauthenticate, user, startCheckout, openPortal, refreshProfile, getToken, usage, refreshUsage, consumeQuestions, watchAd: watchAdQuestions, buyPack, consumeMock } = useAuth();
  // Expose Clerk's getToken to the module-level AI-proxy / upload helpers so
  // every request to /api/anthropic and /api/upload-file carries a bearer token.
  useEffect(() => { _getToken = getToken; return () => { _getToken = null; }; }, [getToken]);
  const navigate = useNavigate();
  // Approach B: the quiz app is browsable without an account, but generating a
  // quiz requires sign-in. Returns true (and sends the visitor to sign-up) when
  // they're logged out, so callers can bail early.
  const requireLogin = useCallback(() => {
    if (user) return false;
    navigate("/signup");
    return true;
  }, [user, navigate]);
  const [coBusy, setCoBusy] = useState("");   // "monthly" | "yearly" while redirecting to Stripe
  const [coErr,  setCoErr]  = useState("");
  const [upgraded, setUpgraded] = useState(false); // "Welcome to Pro!" banner after checkout
  const [activating, setActivating] = useState(false); // polling Supabase for Pro after checkout
  const doCheckout = async (priceId, which) => {
    setCoErr(""); setCoBusy(which);
    const { error } = await startCheckout(priceId);
    if (error) { setCoBusy(""); setCoErr(error); }
  };
  const [adBusy, setAdBusy] = useState(false); // watching the (placeholder) ad
  const [showPacks, setShowPacks] = useState(false); // question-packs popup
  const [limitHit, setLimitHit] = useState(false);   // last generate blocked by the daily limit
  const handleWatchAd = async () => {
    if (adBusy) return;
    setAdBusy(true);
    const r = await watchAdQuestions();
    setAdBusy(false);
    if (r && r.allowed === false) setError(t.errAdWatchesUsed);
    else setError("");
  };
  // Keep usage fresh when landing on the home / quiz-setup screens.
  useEffect(()=>{ if(screen==="home"||screen==="upload") refreshUsage?.(); },[screen,refreshUsage]);
  // Refresh the sender's challenge activity whenever the home screen opens.
  useEffect(()=>{
    if(!user || screen!=="home") return;
    let cancelled=false;
    (async()=>{ const c=await fetchMyChallenges(); if(!cancelled) setChallenges(c); })();
    return ()=>{ cancelled=true; };
  },[user,screen]);
  // Email/password accounts must re-enter their password to delete; OAuth-only
  // (e.g. Google) accounts have no password to verify.
  const requiresPassword = !!user?.identities?.some(i => i.provider === "email");
  const [tab,          setTab]          = useState("file");
  const [file,         setFile]         = useState(null);
  const [mediaFile,    setMediaFile]    = useState(null); // audio/video for transcription (Pro)
  const [extraFiles,   setExtraFiles]   = useState([]);   // Pro: extra files added to a quiz beyond the primary
  const [mediaStatus,  setMediaStatus]  = useState("");   // loading-screen sub-message while transcribing
  const [showQuizlet,  setShowQuizlet]  = useState(false); // Quizlet-import modal
  const [quizletText,  setQuizletText]  = useState("");
  const [quizletBusy,  setQuizletBusy]  = useState(false);
  const [quizletErr,   setQuizletErr]   = useState("");
  const [textVal,      setTextVal]      = useState("");
  const [numQ,         setNumQ]         = useState(10);
  const [customQ,      setCustomQ]      = useState("25");
  const [useCustomQ,   setUseCustomQ]   = useState(false);
  const [importCount,  setImportCount]  = useState(null); // count requested by the browser extension hand-off (wins over the default-count sync)
  const [diff,         setDiff]         = useState(1);
  // Adaptive difficulty (Phase 1): once the learner hand-picks a level we stop
  // auto-adjusting it for the rest of the session; `settingsReady` gates the
  // one-time auto-apply so it lands after the saved-default sync, not before.
  const [diffTouched,  setDiffTouched]  = useState(false);
  const [settingsReady,setSettingsReady]= useState(false);
  const [qType,        setQType]        = useState("mcq");
  const [quiz,         setQuiz]         = useState(null);
  const [qIdx,         setQIdx]         = useState(0);
  const [answers,      setAnswers]      = useState([]);
  const [selected,     setSelected]     = useState(null);
  // The material blocks the current quiz was built from, kept so "Report a
  // problem" (FlagFix) can regenerate a replacement grounded in the same notes.
  const genBlocksRef = useRef(null);
  const [error,        setError]        = useState("");
  const [drag,         setDrag]         = useState(false);
  const [showProModal, setShowProModal] = useState(false);
  const [unlockFeature, setUnlockFeature] = useState(null); // which feature's unlock modal is open
  const unlocks = useAdUnlocks(isPro);
  // Free exam mode: watch one ad to unlock a single 20-question exam for the
  // day. Pro users enter straight away; free users who've used today's exam
  // (or can't watch again) are blocked until tomorrow.
  const [examAdBusy, setExamAdBusy] = useState(false);
  const enterExamMode = async () => {
    if (requireLogin()) return;
    if (isPro || unlocks.examUnlocked()) { setScreen("exam_setup"); return; }
    if (!unlocks.examCanWatch()) return;   // already used today's free exam
    setExamAdBusy(true);
    await unlocks.unlockExam();
    setExamAdBusy(false);
    setScreen("exam_setup");
  };
  // Spaced-repetition review deck (missed questions resurface over time).
  const srs = useSRS();
  const stats = useStudyStats(); // streak + accuracy for the account panel

  // ── AI Study Coach: day-by-day exam plan (server-synced via StudyContext) ──
  const { plans, savePlan, deletePlan, completePlanDay, setPlanDayStatus } = usePlans();
  const [activePlanId, setActivePlanId] = useState(null);
  const [planSession, setPlanSession] = useState(null); // active coached quiz: {planId,dayIndex,format,numQ,label,kind}
  const [planForm, setPlanForm] = useState({ title:"", testDate:"", chapters:"6", chapterNames:"", mode:"selfpaced", reminderTime:"18:00" });
  const [planErr, setPlanErr] = useState("");
  const [confirmDelPlan, setConfirmDelPlan] = useState(false);
  const [notifPerm, setNotifPerm] = useState(typeof Notification!=="undefined" ? Notification.permission : "unsupported");
  const planDoneRef = useRef(null);
  // Share-a-quiz
  const [shareOpen, setShareOpen] = useState(false);
  const [shareLink, setShareLink] = useState("");
  const [shareBusy, setShareBusy] = useState(false);
  const [shareErr, setShareErr]   = useState("");
  const [shareCopied, setShareCopied] = useState(false);
  // ── Standardized mock exams (ACT), self-contained, per-section timed ──
  const [mockPresetId, setMockPresetId] = useState("act");
  const [mock, setMock] = useState(null);
  const [mockTilt, setMockTilt] = useState("standard"); // one difficulty tilt for the whole form, reused per section
  const [mockSecIdx, setMockSecIdx] = useState(0);
  const [mockQIdx, setMockQIdx] = useState(0);
  const [mockAns, setMockAns] = useState([]); // [secIdx] => [selected index per question]
  const [mockSecResults, setMockSecResults] = useState([]);
  const [mockSecTimeLeft, setMockSecTimeLeft] = useState(0);
  const [mockPaused, setMockPaused] = useState(false); // pause + blur when tabbing out of a mock
  const [mockPrev, setMockPrev] = useState(null);       // previous attempt's composite, for retake motivation
  const [mockResume, setMockResume] = useState(null);   // a saved, unfinished exam offered on the picker
  const mockScoredRef = useRef(null);
  const [mockGenErr, setMockGenErr] = useState("");
  const [showMockSubmit, setShowMockSubmit] = useState(false);
  const submittedSecRef = useRef(-1);
  const submitSectionRef = useRef(() => {});
  // Grade the current section, then lock it and advance (or finish the exam).
  const submitSection = () => {
    if (!mock || submittedSecRef.current === mockSecIdx) return;
    submittedSecRef.current = mockSecIdx;
    const sec = mock.sections[mockSecIdx];
    const ans = mockAns[mockSecIdx] || [];
    const raw = sec.questions.reduce((s, q, i) => s + (ans[i] === q.correct ? 1 : 0), 0);
    // Store the raw result per section; the grouped/scaled scoring is computed at
    // the end by scoreMock, which handles measures, ACT Science (STEM, excluded
    // from the composite) and the UCAT SJT band.
    setMockSecResults((prev) => { const n = [...prev]; n[mockSecIdx] = { sectionId: sec.id, name: sec.name, raw, count: sec.questions.length }; return n; });
    setShowMockSubmit(false);
    if (mockSecIdx + 1 < mock.sections.length) {
      setScreen("mock_break");   // pause between sections; the next timer only starts from the break screen
    } else {
      setScreen("mock_results");
    }
  };
  // Begin the next section from the between-section break, this is what starts
  // the next section's timer, so finishing one section never rolls straight into
  // the next with the clock already running.
  const startNextSection = async () => {
    if (!mock) return;
    const ni = mockSecIdx + 1;
    if (ni >= mock.sections.length) { setScreen("mock_results"); return; }
    // Already built (e.g. retry after a failed build), just start it.
    if (mock.sections[ni].questions.length) {
      setMockSecIdx(ni); setMockQIdx(0); setMockSecTimeLeft(mock.sections[ni].minutes * 60); setScreen("mock_run"); return;
    }
    // Build this section on demand, cheaper when a user stops early, and each
    // generation is small and focused instead of all sections at once.
    setMockGenErr(""); setScreen("mock_gen");
    try {
      const exam = getMock(mock.presetId) || MOCK_EXAMS[0];
      const spec = exam.sections[ni];
      // Adaptive routing: a stage-2 module's difficulty comes from how the taker
      // did on the paired stage-1 module; stage-1 and non-adaptive sections use
      // the form tilt. The chosen route is stored on the section so the final
      // scoring knows which band this measure landed in.
      let tilt = mockTilt, route = null;
      if (mock.adaptive) {
        if (spec.stage === 2) {
          const s1 = stage1IndexFor(mock.sections, ni);
          const r = mockSecResults[s1];
          route = routeFor(mock, r && r.count ? r.raw / r.count : 0);
          tilt = routeTilt(route);
        } else {
          tilt = "standard";
        }
      }
      const qs = await buildMockSection(exam, spec, tilt);
      if (!qs.length) throw new Error("section");
      setMock(m => ({ ...m, sections: m.sections.map((s, i) => i === ni ? { ...s, questions: qs, _route: route || s._route } : s) }));
      setMockSecIdx(ni); setMockQIdx(0); setMockSecTimeLeft(spec.minutes * 60);
      setScreen("mock_run");
    } catch {
      setMockGenErr(t.mockSectionGenFail); setScreen("mock_break");
    }
  };
  useEffect(() => { submitSectionRef.current = submitSection; }); // keep latest closure
  // Per-section countdown: one interval per section, auto-submits at 0. Frozen
  // while paused (tabbed out) so switching away can't run down the clock.
  useEffect(() => {
    if (screen !== "mock_run" || mockPaused) return;
    const id = setInterval(() => setMockSecTimeLeft((t) => { if (t <= 1) { clearInterval(id); return 0; } return t - 1; }), 1000);
    return () => clearInterval(id);
  }, [screen, mockSecIdx, mockPaused]);
  // Pause + blur a mock when the tab is hidden, so the question can't be read
  // off-screen (same anti-peek behaviour as exam mode).
  useEffect(() => {
    if (screen !== "mock_run") return;
    const onVis = () => { if (document.hidden) setMockPaused(true); };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [screen]);
  useEffect(() => { if (mockPaused) document.activeElement?.blur?.(); }, [mockPaused]);
  // On a finished mock: capture the PREVIOUS attempt for this exam (for the
  // retake cheer/encouragement), then record the new score. Runs once per result.
  useEffect(() => {
    if (screen !== "mock_results" || !mock || mockScoredRef.current === mockSecResults) return;
    mockScoredRef.current = mockSecResults;
    clearMockResume(); // the exam is finished, drop the saved-progress copy
    const sc = scoreMock(mock, mockSecResults);
    setMockPrev(srs.mockScores?.[mock.presetId]?.last || null);
    srs.recordMockScore(mock.presetId, sc.composite, sc.compositeMax);
  }, [screen, mock, mockSecResults, srs]);
  useEffect(() => {
    if (screen === "mock_run" && mockSecTimeLeft === 0 && mock && submittedSecRef.current !== mockSecIdx) submitSectionRef.current();
  }, [mockSecTimeLeft, screen, mockSecIdx, mock]);
  // Look for a resumable exam whenever the picker opens.
  useEffect(() => { if (screen === "mock_select") setMockResume(readMockProgress()); }, [screen]);
  // Mirror the in-progress exam to device storage so a crash/exit can resume it.
  // Heavy part (the generated question set) is rewritten only when it changes.
  useEffect(() => {
    if (!mock || !(screen === "mock_run" || screen === "mock_break")) return;
    try {
      // Store the WHOLE mock (incl scoreMode, adaptive, routing, per-module _route)
      // so a resumed exam scores identically to one taken in one sitting.
      localStorage.setItem(MOCK_LS_Q, JSON.stringify({ v: 1, tilt: mockTilt, mock }));
    } catch { /* quota / private mode: skip, resume just won't be offered */ }
  }, [mock, mockTilt, screen]);
  // Light part (position, answers, clock) is small and rewritten as they go.
  useEffect(() => {
    if (!mock || !(screen === "mock_run" || screen === "mock_break")) return;
    try {
      localStorage.setItem(MOCK_LS_P, JSON.stringify({
        v: 1, presetId: mock.presetId, name: mock.name, sectionsTotal: mock.sections.length,
        secIdx: mockSecIdx, secName: mock.sections[mockSecIdx]?.name || "",
        qIdx: mockQIdx, ans: mockAns, secResults: mockSecResults,
        secTimeLeft: mockSecTimeLeft, phase: screen === "mock_break" ? "break" : "run",
        savedAt: Date.now(),
      }));
    } catch { /* ignore */ }
  }, [mock, screen, mockSecIdx, mockQIdx, mockAns, mockSecResults, mockSecTimeLeft]);
  const sortedPlans = [...plans].sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));
  const homePlan = sortedPlans.find(p=>!isPlanComplete(p)) || sortedPlans[0] || null;
  const activePlan = plans.find(p=>p.id===activePlanId) || homePlan;
  const topicsWeak = weakTopics(srs.cards); // weak areas from the review deck
  const mastery = topicMastery(srs.topicStats); // per-topic mastery across all quizzes/exams
  // ── Student model + adaptive difficulty (Phase 1) ──
  // One object gathering the signals the model reads (lifetime stats, per-topic
  // mastery, the rolling perf log, the review deck). `diffRec` is the level the
  // learner should be quizzed at next; it drives the "Recommended for you"
  // affordance on setup and the one-time auto-apply below. Memoized so it only
  // recomputes when the underlying study data actually changes.
  const studyModel = useMemo(
    () => ({ stats, topicStats: srs.topicStats, perf: srs.perf, cards: srs.cards }),
    [stats, srs.topicStats, srs.perf, srs.cards]
  );
  const diffRec = useMemo(() => recommendDifficulty(studyModel), [studyModel]);
  // Learner hand-picks a level -> respect it (stop auto-adapting this session).
  const pickDiff = useCallback((i) => { setDiff(i); setDiffTouched(true); }, []);
  // Best-effort browser reminder, fires only while Revyy is open in the tab
  // (real push arrives with the mobile app). Schedules the plan's reminder time.
  useEffect(() => {
    if (typeof Notification==="undefined" || Notification.permission!=="granted") return;
    if (!homePlan || homePlan.mode!=="remind" || !homePlan.reminderTime) return;
    const nd = nextDayIndex(homePlan); if (nd===-1) return;
    const day = homePlan.days[nd];
    if (day.date !== new Date().toLocaleDateString("en-CA") || day.status==="done") return;
    const [h,m] = homePlan.reminderTime.split(":").map(Number);
    const when = new Date(); when.setHours(h||18, m||0, 0, 0);
    const delay = when.getTime() - Date.now();
    if (delay<=0 || delay>12*3600000) return;
    const id = setTimeout(()=>{ try { new Notification("Revyy · Study Coach", { body:`Time to study: ${day.label}` }); } catch { /* ignore */ } }, delay);
    return ()=>clearTimeout(id);
  }, [homePlan]);

  const [reviewQueue, setReviewQueue] = useState([]); // card ids for this session
  const [reviewPos,   setReviewPos]   = useState(0);
  const [reviewShown, setReviewShown] = useState(false); // answer revealed?
  const [srsAdded,    setSrsAdded]    = useState(0); // "+N added to review" note
  const startReview = () => {
    setReviewQueue(srs.dueCards.map((c) => c.id));
    setReviewPos(0); setReviewShown(false); setScreen("review");
  };
  // Feature E: "Quick 10", a commute-sized micro-session. Pulls the 10 most-due
  // review cards (due first, then soonest-due, so it works even when nothing is
  // strictly due yet), instant and free, no upload. If more are still due after,
  // the review-complete screen offers to keep going.
  const QUICK_N = 10;
  const startQuick10 = () => {
    const deck = [...srs.cards].sort((a, b) => a.due - b.due).slice(0, QUICK_N);
    if (!deck.length) return;
    setReviewQueue(deck.map((c) => c.id));
    setReviewPos(0); setReviewShown(false); setScreen("review");
  };
  const srsAddedRef = useRef(null);
  const fileRef  = useRef();
  const photoRef = useRef();
  const mediaRef = useRef();
  const extraRef = useRef();
  const examAddRef=useRef();
  const [examMode,    setExamMode]    = useState(null);
  const [examFiles,   setExamFiles]   = useState([]);
  const [examMCQCount,setExamMCQCount]= useState("20");
  const [examWrtCount,setExamWrtCount]= useState("10");
  const [examTotalQ,  setExamTotalQ]  = useState("20");
  const [examQs,      setExamQs]      = useState([]);
  const [examIdx,     setExamIdx]     = useState(0);
  const [examAns,     setExamAns]     = useState({});
  const [examEvals,   setExamEvals]   = useState(null);
  // When a quiz or exam finishes, add the missed questions to the review deck
  // (once per result set, keyed on the object identity).
  useEffect(() => {
    if (screen === "results" && quiz && srsAddedRef.current !== quiz && quiz.replay) {
      // A scrambled retry of already-seen questions: mark it handled but record
      // nothing, so stats, the review deck, the bank and the adaptive signal are
      // not double-counted.
      srsAddedRef.current = quiz; setSrsAdded(0);
    } else if (screen === "results" && quiz && srsAddedRef.current !== quiz) {
      srsAddedRef.current = quiz;
      const missed = quiz.questions.filter((_, i) => answers[i] && answers[i].isCorrect === false).map(toCard);
      setSrsAdded(missed.length ? srs.addMissed(missed) : 0);
      stats.recordSession(answers.length, answers.filter((a) => a && a.isCorrect).length);
      srs.recordTopics(quiz.questions.map((q, i) => ({ topic: q.topic, correct: answers[i]?.isCorrect === true })));
      // Adaptive difficulty: log this round only if it was a fresh, difficulty-
      // calibrated set (not a fix-your-misses re-drill or a retry of seen
      // questions), so the ability signal stays honest.
      if (quiz.fresh) srs.recordPerf({ type: quiz.type, diff: quiz.genDiff ?? diff, total: answers.length, correct: answers.filter((a) => a && a.isCorrect).length });
      // Phase 2: bank the well-formed MCQs the learner saw and did NOT flag as
      // vetted (reusable). leanQ inside makeBankItem drops non-MCQ types, and
      // any question that was flagged is already on the reject list, so
      // bankAddItems skips it. Only for MCQ quizzes.
      if (quiz.type === "mcq") {
        const items = quiz.questions.map((q) => makeBankItem({ q, diff: quiz.genDiff ?? diff, type: "mcq", quality: 1 })).filter(Boolean);
        if (items.length) srs.bankAdd(items);
      }
    } else if (screen === "exam_results" && examEvals && srsAddedRef.current !== examEvals) {
      srsAddedRef.current = examEvals;
      const missed = examQs.filter((_, i) => (examEvals[i]?.score ?? 0) < 1).map(toCard);
      setSrsAdded(missed.length ? srs.addMissed(missed) : 0);
      stats.recordSession(examEvals.length, examEvals.filter((e) => (e?.score ?? 0) >= 1).length);
      srs.recordTopics(examQs.map((q, i) => ({ topic: q.topic, correct: (examEvals[i]?.score ?? 0) >= 1 })));
      // Personalization for exam mode: feed the exam into the adaptive-difficulty
      // history and bank its well-formed MCQs (leanQ skips written/fill), same as
      // a quiz. Mock tests never reach this branch, so they stay untouched.
      srs.recordPerf({ type: "exam", diff, total: examEvals.length, correct: examEvals.filter((e) => (e?.score ?? 0) >= 1).length });
      const exItems = examQs.map((q) => makeBankItem({ q, diff, type: "mcq", quality: 1 })).filter(Boolean);
      if (exItems.length) srs.bankAdd(exItems);
    }
  }, [screen, quiz, answers, examEvals, examQs, srs, stats, diff]);
  // Play a finish sound once when a quiz result appears (celebrate / pass / fail).
  const resultSndRef = useRef(null);
  useEffect(() => {
    if (screen === "results" && quiz && resultSndRef.current !== quiz) {
      resultSndRef.current = quiz;
      const c = answers.filter(a => a && a.isCorrect).length;
      const p = quiz.questions.length ? Math.round(c / quiz.questions.length * 100) : 0;
      (p >= 90 ? SoundEngine.celebrate : p >= 60 ? SoundEngine.pass : SoundEngine.fail)();
    }
  }, [screen, quiz, answers]);
  // ── Exam timer ──
  const [examTimerOn,   setExamTimerOn]   = useState(false);
  const [examTimerMin,  setExamTimerMin]  = useState("60");
  const [examTotalSec,  setExamTotalSec]  = useState(0);     // total seconds for the exam
  const [examTimeLeft,  setExamTimeLeft]  = useState(null);  // seconds remaining (null = no timer)
  const [examPaused,    setExamPaused]    = useState(false);
  const [examTimeUp,    setExamTimeUp]    = useState(false);
  const [examReview,    setExamReview]    = useState(false); // reviewing answers before final submit
  const [showSubmitPrompt, setShowSubmitPrompt] = useState(false);
  const [examResume,    setExamResume]    = useState(null);  // saved in-progress exam to resume
  const [examTimeUsedSec,  setExamTimeUsedSec]  = useState(null);
  const [examAnsweredCount,setExamAnsweredCount]= useState(0);
  const [examTimeExpired,  setExamTimeExpired]  = useState(false);
  const timeLeftRef = useRef(null);
  const examSnapRef = useRef(null);
  const [showConfetti,setShowConfetti]= useState(false);
  const [soundOn,      setSoundOn]      = useState(true);
  const [showExitConfirm, setShowExitConfirm] = useState(false);
  const [showSettings,   setShowSettings]   = useState(false);
  const [showBugReport,  setShowBugReport]  = useState(false); // quick "report a bug" from the quiz screen
  const [settingsDraft,  setSettingsDraft]  = useState(null);
  const [challenges,     setChallenges]     = useState([]); // sender's shared-quiz activity
  const [settings, setSettings] = useState({
    theme:'system',      
    fontSize:'medium',   
    animations:true,
    sound:true,
    volume:70,
    haptics:false,
    feedback:'immediate',
    autoAdvance:false,
    autoAdvanceSec:5,
    defaultDiff:1,
    defaultQCount:10,
    nickname:'',
  });
  const [examSections, setExamSections] = useState([
    {id:0, type:'mcq',     count:'10', marksPerQ:'2'},
    {id:1, type:'written', count:'5',  marksPerQ:'3'},
  ]);

  // Load persisted settings
  useEffect(()=>{
    (async()=>{
      try {
        const ss = await window.storage.get("revyy_settings");
        if (ss) {
          const d = JSON.parse(ss.value);
          setSettings(prev=>({...prev,...d}));
          setSoundOn(d.sound!==false);
          if(d.volume!==undefined) SoundEngine.setVolume(d.volume);
        }
      } catch {}
      finally { setSettingsReady(true); } // unblocks the one-time adaptive apply
    })();
  },[]);

  // Sync settings changed in another tab (localStorage `storage` event).
  useEffect(()=>{
    const onStorage = (e) => {
      if (e.key === "revyy_settings" && e.newValue) {
        try { const d = JSON.parse(e.newValue); setSettings(prev=>({...prev,...d})); } catch { /* ignore */ }
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  },[]);

  useEffect(()=>{ SoundEngine.setVolume(settings.volume); },[settings.volume]);
  useEffect(()=>{ setSoundOn(settings.sound); },[settings.sound]);
  useEffect(()=>{ SoundEngine.setEnabled(soundOn); },[soundOn]);
  useEffect(()=>{ Haptics.on = settings.haptics; },[settings.haptics]);
  // Apply the saved "default difficulty / questions" to the quiz-setup controls
  // on load (and whenever the default changes) so they persist across reloads
  // and logout/login, not only when Apply is pressed.
  useEffect(()=>{ setDiff(settings.defaultDiff); },[settings.defaultDiff]);
  // Adaptive difficulty: once, after the saved default has synced, move the
  // picker to the level the student model recommends, but only with enough
  // signal to be confident and only if the learner hasn't hand-picked one. Runs
  // a single time (ref-guarded) so it never fights a manual choice; the setup
  // screen shows the reason so the change is never a surprise.
  const recAppliedRef = useRef(false);
  useEffect(()=>{
    if (recAppliedRef.current || !settingsReady) return;
    recAppliedRef.current = true;
    if (!diffTouched && diffRec.confidence >= 0.6) setDiff(diffRec.diff);
  },[settingsReady, diffRec, diffTouched]);
  // An extension-imported count (importCount) wins over the saved default, so a
  // count picked in the extension popup survives the async settings hydration.
  useEffect(()=>{ setNumQ(importCount ?? settings.defaultQCount); },[settings.defaultQCount, importCount]);

  // Browser-extension hand-off. The Revyy extension captures a page or
  // selection, drops it in localStorage (key "revyy_import"), then opens the
  // app. We read it once on mount (and on the "revyy-import" nudge the extension
  // fires if the app was already open), pre-fill the Text tab, and jump to the
  // setup screen. The extension sets localStorage before dispatching, so we
  // re-read from there rather than trusting the cross-world event detail.
  useEffect(()=>{
    const pull=()=>{
      let raw; try{ raw=localStorage.getItem("revyy_import"); }catch{ return; }
      if(!raw) return;
      try{ localStorage.removeItem("revyy_import"); }catch{ /* ignore */ }
      let p; try{ p=JSON.parse(raw); }catch{ p={ text:raw }; }
      const text=String(p?.text||"").trim();
      if(text.length<20) return;
      setTab("text"); setFile(null); setExtraFiles([]); setError(""); setLimitHit(false);
      setTextVal(text.slice(0,20000));
      if(["mcq","cards","fill","match"].includes(p?.qtype)) setQType(p.qtype);
      const c=parseInt(p?.count,10);
      if(!isNaN(c)&&c>0){ const n=Math.min(Math.max(c,1),qCap()); setImportCount(n); setCustomQ(String(n)); }
      setScreen("upload");
    };
    pull();
    const onEvt=()=>pull();
    window.addEventListener("revyy-import",onEvt);
    return ()=>window.removeEventListener("revyy-import",onEvt);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);

  // ── Theme injection into document.head ──
  // "system" resolves to light/dark via prefers-color-scheme so the CSS
  // colour variables are ALWAYS defined (otherwise the settings panel and
  // other surfaces using var(--color-*) would render transparent).
  useEffect(()=>{
    let el=document.getElementById("revyy-theme");
    if(!el){el=document.createElement("style");el.id="revyy-theme";document.head.appendChild(el);}
    const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    const resolved = settings.theme==="dark" ? "dark"
      : settings.theme==="light" ? "light"
      : (prefersDark ? "dark" : "light");
    el.textContent = resolved==="dark" ? THEME_DARK : THEME_LIGHT;
  },[settings.theme]);

  // ── Font size injection ──
  useEffect(()=>{
    // Scale the WHOLE app, not just body text: most of the UI uses inline pixel
    // sizes, so a plain font-size rule barely moved. `zoom` scales everything
    // (inline px included) and, unlike transform:scale, keeps fixed overlays put.
    const z = settings.fontSize==="small" ? "0.9" : settings.fontSize==="large" ? "1.12" : "1";
    try { document.body.style.zoom = z; } catch { /* ignore */ }
    return () => { try { document.body.style.zoom = "1"; } catch { /* ignore */ } };
  },[settings.fontSize]);

  useEffect(()=>{
    if(settings.animations) document.body.classList.remove("no-anim");
    else document.body.classList.add("no-anim");
  },[settings.animations]);

  const autoAdvanceSec = Math.min(Math.max(parseInt(settings.autoAdvanceSec)||5,1),15);
  // Auto-advance (normal MCQ quiz only, exam mode is separate): once an answer
  // is picked, move to the next question. With instant feedback we wait the
  // user-configured time (default 5s, up to 15s) so the result is readable and
  // a progress bar can count down; "at end" mode has nothing to read, so it
  // flips quickly.
  useEffect(()=>{
    if(screen!=="quiz"||!quiz||quiz.type!=="mcq") return;
    if(!settings.autoAdvance||selected===null) return;
    const isCorrect = selected===quiz.questions[qIdx]?.correct;
    const delay = settings.feedback==="immediate" ? autoAdvanceSec*1000 : 450;
    const id=setTimeout(()=>{
      setAnswers(a=>[...a,{isCorrect,selected}]);
      setSelected(null);
      if(qIdx+1>=quiz.questions.length) setScreen("results");
      else setQIdx(i=>i+1);
    },delay);
    return ()=>clearTimeout(id);
  },[selected,screen,quiz,qIdx,settings.autoAdvance,settings.feedback,autoAdvanceSec]);

  const updateSetting = (key,val) => {
    setSettings(prev=>{
      const next={...prev,[key]:val};
      window.storage.set("revyy_settings",JSON.stringify(next)).catch(()=>{});
      return next;
    });
  };

  // Live light/dark toggle (also reachable without an account, since full
  // settings are behind sign-in). Resolves "system" to the OS preference.
  const isDarkTheme = settings.theme==="dark"
    || (settings.theme!=="light" && typeof window!=="undefined" && window.matchMedia
        && window.matchMedia("(prefers-color-scheme: dark)").matches);
  const toggleTheme = () => updateSetting("theme", isDarkTheme ? "light" : "dark");

  // ── Feature access (free users unlock via 1-hour ad windows) ─────────
  const QTYPE_FEATURE = { cards:"flashcard", fill:"fillinblank", match:"matchterms" };
  const canUseQType = useCallback((type) => type==="mcq" || isPro || unlocks.isUnlocked(QTYPE_FEATURE[type]), [isPro, unlocks]);
  const canCustomQ  = useCallback(() => isPro, [isPro]);
  // Max questions per quiz: 100 (Pro) / 50 (ad-unlocked) / 20 (free).
  const qCap        = useCallback(() => isPro ? PRO_MAX_Q : (unlocks.isUnlocked("questions") ? AD_MAX_Q : FREE_MAX_Q), [isPro, unlocks]);
  // File size: 999 (Pro) / 10 (ad-unlocked) / 5 (free) MB.
  const fileLimitMB = useCallback(() => isPro ? PRO_FILE_MB : (unlocks.isUnlocked("filesize") ? AD_FILE_MB : FREE_FILE_MB), [isPro, unlocks]);

  const effectiveNumQ = useCallback(()=>{
    // Custom box value takes precedence when on; otherwise the slider's numQ.
    let n = numQ;
    if (useCustomQ && canCustomQ()) { const c=parseInt(customQ,10); if(!isNaN(c)) n=c; }
    return Math.min(Math.max(n,1), qCap());
  },[useCustomQ,canCustomQ,numQ,customQ,qCap]);

  // Banner-ads master switch (mirrors AdBanners), separate from feature unlocks.
  const adsOn = dev.devMode && dev.ads!==null ? dev.ads : ADS_ENABLED;
  const openUpgrade = () => { setUnlockFeature(null); setShowProModal(true); };

  // Append a file to the exam (free: up to EXAM_FILES_FREE, Pro: EXAM_FILES_PRO).
  const addExamFile=useCallback(async(f)=>{
    if(!f)return;
    const cap = isPro ? EXAM_FILES_PRO : EXAM_FILES_FREE;
    if(examFiles.filter(Boolean).length >= cap){ setError(t.errFilesMax.replace("{n}",cap)); return; }
    const lim=fileLimitMB();
    if(f.size/1024/1024>lim){setError(t.errFileTooLarge.replace("{n}",lim));return;}
    const isPdf=f.type==="application/pdf",isImg=f.type.startsWith("image/"),isTxt=f.type.startsWith("text/")||/\.(txt|md|csv)$/i.test(f.name);
    if(!isPdf&&!isImg&&!isTxt){setError(t.errFileType);return;}
    try{
      let p;
      if(isTxt){const text=await readText(f);p={type:"text",content:text,mime:null,name:f.name};}
      else{p={type:isPdf?"pdf":"image",raw:f,mime:f.type,name:f.name};}
      setExamFiles(prev=>{const cur=prev.filter(Boolean); return cur.length>=cap ? cur : [...cur, p];});
      setError("");
    }catch{setError(t.errReadFile);}
  },[fileLimitMB, isPro, examFiles]);

  const removeExamFile=useCallback(idx=>{setExamFiles(prev=>prev.filter((_,i)=>i!==idx));},[]);

  const addSection = useCallback(()=>{
    setExamSections(p=> p.length<5 ? [...p,{id:Date.now(),type:'mcq',count:'5',marksPerQ:'1'}] : p);
  },[]);
  const removeSection = useCallback(id => setExamSections(p=>p.filter(s=>s.id!==id)),[]);
  const updateSection = useCallback((id,field,val) =>
    setExamSections(p=>p.map(s=>s.id===id?{...s,[field]:val}:s))
  ,[]);
  const sectionTotalMarks = examSections.reduce((s,sec)=>s+(parseInt(sec.count)||0)*(parseFloat(sec.marksPerQ)||1),0);
  const sectionTotalQs    = examSections.reduce((s,sec)=>s+(parseInt(sec.count)||0),0);

  // Upload a raw File to the Anthropic Files API (via our server) → file_id.
  // Cached per File so re-generating with the same file doesn't re-upload.
  const fileIdCache = useRef(new WeakMap());
  // Files ≤ this go straight through our function; larger Pro files go via
  // Vercel Blob (direct browser→Blob upload) to bypass the 4.5 MB limit.
  const DIRECT_MAX = 4 * 1024 * 1024;
  const uploadFileToAnthropic = useCallback(async (f) => {
    if (fileIdCache.current.has(f)) return fileIdCache.current.get(f);

    let fileId;
    if (isPro && f.size > DIRECT_MAX) {
      // Pro large-file path: browser → Vercel Blob → server → Anthropic Files.
      const token = await getToken?.();
      const blob = await blobUpload(f.name, f, {
        access: "public",
        handleUploadUrl: "/api/blob-upload",
        clientPayload: token || "",
      });
      const res = await fetch("/api/upload-file", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(await authHeader()) },
        body: JSON.stringify({ blobUrl: blob.url, filename: f.name, contentType: f.type }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.file_id) throw new Error(data.error || "Could not process the uploaded file.");
      fileId = data.file_id;
    } else {
      // Direct path (free, and small Pro files).
      const res = await fetch("/api/upload-file", {
        method: "POST",
        headers: { "Content-Type": f.type || "application/octet-stream", "x-filename": encodeURIComponent(f.name), ...(await authHeader()) },
        body: f,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.file_id) {
        throw new Error(data.error || (res.status === 413
          ? "File too large. Upgrade to Pro to upload large files."
          : "Could not upload file. Please try again."));
      }
      fileId = data.file_id;
    }

    fileIdCache.current.set(f, fileId);
    return fileId;
  }, [isPro, getToken]);

  // Pick an audio/video file for transcription (Pro only; the Blob upload it
  // rides on is Pro-gated server-side too).
  const loadMedia = useCallback((f) => {
    if (!f) return;
    setError("");
    if (!isPro) { setError(t.mediaProOnly); return; }
    const mb = f.size / 1024 / 1024;
    if (mb > MEDIA_MAX_MB) { setError(t.errMediaTooLarge.replace("{max}", MEDIA_MAX_MB)); return; }
    setMediaFile({ raw: f, name: f.name, sizeMB: mb, mime: f.type });
  }, [isPro, t]);

  // Pro: attach an EXTRA file (any supported type) to the quiz, beyond the
  // primary one in the active tab. Generation combines the primary + all extras,
  // so one quiz can be built from several sources at once. Free users never see
  // this (their quiz stays single-file).
  const addExtraFile = useCallback(async (f) => {
    if (!f) return;
    if (!isPro) { setError(t.mediaProOnly); return; }
    setError("");
    const isPdf = f.type === "application/pdf";
    const isImg = f.type.startsWith("image/");
    const isMed = f.type.startsWith("audio/") || f.type.startsWith("video/");
    const isTxt = f.type.startsWith("text/") || /\.(txt|md|csv)$/i.test(f.name);
    if (!isPdf && !isImg && !isMed && !isTxt) { setError(t.errFileType); return; }
    const mb = f.size / 1024 / 1024;
    if (isMed && mb > MEDIA_MAX_MB) { setError(t.errMediaTooLarge.replace("{max}", MEDIA_MAX_MB)); return; }
    if (!isMed && mb > PRO_FILE_MB) { setError(t.errFileOverPro.replace("{size}", fmtMB(f.size)).replace("{max}", PRO_FILE_MB)); return; }
    try {
      let p;
      if (isTxt) { const text = await readText(f); p = { kind:"doc", type:"text", content:text, name:f.name }; }
      else if (isMed) { p = { kind:"media", type:"media", raw:f, name:f.name }; }
      else { p = { kind:"doc", type:isPdf?"pdf":"image", raw:f, name:f.name }; }
      setExtraFiles(prev => prev.length >= QUIZ_FILES_PRO - 1 ? prev : [...prev, p]);
    } catch { setError(t.errReadFile); }
  }, [isPro, t]);

  // Upload the media to Vercel Blob, kick off AssemblyAI transcription, and poll
  // until the transcript is ready. Returns the transcript text (which then flows
  // through the SAME content gate + generation as any pasted notes). The server
  // deletes the Blob right after pulling the bytes, so nothing lingers publicly.
  const transcribeMedia = useCallback(async (mf) => {
    setMediaStatus(t.mediaUploading);
    const token = await getToken?.();
    const blob = await blobUpload(mf.name, mf.raw, {
      access: "public",
      handleUploadUrl: "/api/blob-upload",
      clientPayload: token || "",
    });
    const sub = await fetch("/api/upload-file", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await authHeader()) },
      body: JSON.stringify({ transcribe: true, blobUrl: blob.url }),
    });
    const subData = await sub.json().catch(() => ({}));
    if (!sub.ok || !subData.transcriptId) throw new Error(subData.error || t.errTranscribe);
    setMediaStatus(t.mediaTranscribing);
    const deadline = Date.now() + 6 * 60000; // give up after 6 minutes
    for (;;) {
      await new Promise((r) => setTimeout(r, 3000));
      const p = await fetch(`/api/upload-file?transcript=${encodeURIComponent(subData.transcriptId)}`, { headers: { ...(await authHeader()) } });
      const d = await p.json().catch(() => ({}));
      if (d.status === "completed") { setMediaStatus(""); return String(d.text || "").trim(); }
      if (d.status === "error" || Date.now() > deadline) { setMediaStatus(""); throw new Error(d.error || t.errTranscribe); }
    }
  }, [getToken, t]);

  // Feature F (growth): import an existing Quizlet set. The learner exports it
  // from Quizlet (their own Export button) and pastes it here; we parse it into
  // flashcards directly, no AI generation and no quota spent. Still runs through
  // the content gate so nothing explicit/off-topic slips in. No URL, no fetch.
  const quizletCards = parseQuizlet(quizletText);
  const importQuizlet = async () => {
    if (requireLogin()) return;
    const cards = parseQuizlet(quizletText);
    if (!cards.length) { setQuizletErr(t.qzNoCards); return; }
    setQuizletBusy(true); setQuizletErr("");
    try {
      const joined = cards.map((c) => `${c.question}: ${c.answer}`).join("\n").slice(0, 8000);
      const gate = await gateContent({ blocks: [{ type: "text", text: joined }], uiLangName: LANGS[lang]?.name });
      if (gate.decision === "block") { setQuizletErr(gateMessage(gate.category, t)); setQuizletBusy(false); return; }
      setQuiz({ type: "cards", title: t.qzImportedTitle, subject: "", questions: cards });
      setQIdx(0); setAnswers([]); setSelected(null);
      setShowQuizlet(false); setQuizletText(""); setQuizletBusy(false);
      setScreen("quiz");
    } catch { setQuizletErr(t.qzImportErr); setQuizletBusy(false); }
  };

  const generateExam=useCallback(async()=>{
    if (requireLogin()) return;   // logged-out visitors are sent to sign-up
    if(examFiles.length===0){setError(t.errUploadOne);return;}
    // Free users: exam is ad-unlocked, single-use per day, capped to a
    // 20-question all-MCQ or all-written paper (no custom sections).
    if(!isPro){
      if(!unlocks.examUnlocked()){setError(t.errExamUsed);return;}
      if(examMode==="custom"){setError(t.errCustomPro);return;}
    }
    if(examMode==="custom" && sectionTotalQs===0){setError(t.errAddQuestion);return;}
    setError("");
    const dg = DIFFICULTY[diff] || DIFFICULTY[1];
    const totalQ = examMode==="custom" ? sectionTotalQs : (isPro ? Math.min(Math.max(parseInt(examTotalQ)||5,1),100) : 20);

    // Exams carry model answers/explanations → ~200 tokens/Q. Cap at 20k.
    const maxTokens = Math.min(Math.max(Math.round(totalQ*260)+3000, 6000), 48000);

    // Personalize the exam to this learner (weak-topic emphasis + calibration)
    // and fold in the content feedback loop's "avoid these" list, same as the
    // quiz flow. Empty for newcomers.
    const learnerBrief = [buildLearnerBrief(studyModel), buildAvoidNote(srs.bank)].filter(Boolean).join("\n\n");
    // Build the prompt; `scale` (≤1) shrinks the question counts for a retry.
    const buildPrompt=(scale)=>{
      const base=isPro?Math.min(Math.max(parseInt(examTotalQ)||5,1),100):20;
      const totN=Math.max(1,Math.round(base*scale));
      let typeInst=""; const marksMap={};
      if(examMode==="mcq") typeInst="Generate exactly "+totN+" multiple choice questions. 4 options each. Set type:\"mcq\" for all. Set \"section\":1 on every question.";
      else if(examMode==="written") typeInst="Generate exactly "+totN+" open-ended short-answer questions. Include a model answer. Set type:\"written\", options:[] for all. Set \"section\":1 on every question.";
      else {
        typeInst = examSections.map((s,i)=>{
          const n=Math.max(1,Math.round(Math.min(Math.max(parseInt(s.count)||5,1),100)*scale));
          marksMap[i+1]=parseFloat(s.marksPerQ)||1;
          const desc=s.type==="mcq"
            ?n+" multiple choice questions (4 options, type:\"mcq\", correct:0-based index)"
            :s.type==="fill"
            ?n+" fill-in-blank questions (type:\"fill\", question MUST contain ___, answer=the exact missing word)"
            :n+" open-ended written questions (type:\"written\", options:[])";
          return "Section "+(i+1)+": generate exactly "+desc+". Set \"section\":" +(i+1)+" on EVERY question in this section.";
        }).join("\n");
      }
      const prompt="You are creating a real graded exam.\n"+typeInst+"\nDIFFICULTY: "+dg.name+". "+dg.guide+" Calibrate every question to this "+dg.name+" level.\nLANGUAGE: Write the ENTIRE exam, every question, all options, model answers, explanations and the title, in the SAME language as the study material provided. Match the material's language exactly; do NOT translate it into English."+(LANGS[lang]?.name?" If the material is too short to tell its language, use "+LANGS[lang].name+".":"")+(learnerBrief?"\n"+learnerBrief:"")+"\nReturn ONLY raw JSON (no markdown):\n{\"title\":\"Exam title\",\"questions\":[{\"section\":1,\"type\":\"mcq\",\"question\":\"...\",\"options\":[\"A\",\"B\",\"C\",\"D\"],\"correct\":0,\"answer\":\"model answer\",\"explanation\":\"...\",\"topic\":\"2-4 word sub-topic\"}],\"summary\":\"a compact digest of this material for the study library\"}\nSet \"topic\" to the specific concept each question tests (2-4 words), used to track weak areas. For written/fill: options:[], correct:0. Keep questions in section order.\nALSO add a top-level \"summary\" field LAST: a compact digest (max 120 words) of the KEY concepts this material covers, in the same language as the material, for the learner's study library.";
      return { prompt, marksMap };
    };

    setScreen("loading");
    try{
      // Upload each study file to the Files API → reference by file_id.
      const blocks=await Promise.all(examFiles.map(async f=>{
        if(f.type==="text") return {type:"text",text:"Study material ("+f.name+"):\n\n"+f.content};
        const fid=await uploadFileToAnthropic(f.raw);
        return f.type==="pdf"
          ? {type:"document",source:{type:"file",file_id:fid}}
          : {type:"image",source:{type:"file",file_id:fid}};
      }));
      // Content gate BEFORE charging quota (same as the quiz flow): stop
      // explicit / harmful / non-study uploads; real study material passes.
      const gate = await gateContent({ blocks, uiLangName: LANGS[lang]?.name });
      if (gate.decision === "block") { setError(gateMessage(gate.category, t)); setScreen("exam_setup"); return; }
      // Exam questions count toward the daily question limit (reserve them now).
      const consumed = await consumeQuestions(totalQ);
      if (consumed && consumed.allowed === false) {
        const left = consumed.remaining ?? 0;
        setLimitHit(true); // Pro-only screen → offer the question-pack button
        setError(t.errExamOverLimit.replace("{q}",totalQ).replace("{left}",left).replace("{limit}",consumed.daily_limit));
        setScreen("exam_setup"); return;
      }
      const attempt=async(scale)=>{
        const { prompt, marksMap }=buildPrompt(scale);
        const res=await fetch("/api/anthropic",{method:"POST",headers:{"Content-Type":"application/json", ...(await authHeader())},
          body:JSON.stringify({model:AI_MODEL,max_tokens:maxTokens,
            system:"You are an expert exam setter. Return ONLY valid raw JSON, no markdown.",
            messages:[{role:"user",content:[...blocks,{type:"text",text:prompt}]}]})});
        if(!res.ok){const e=await res.json().catch(()=>({}));throw new Error(e.error?.message||"Error "+res.status);}
        const raw = stripFences(await readStream(res));
        let parsed;
        try { parsed = JSON.parse(raw); }
        catch {
          // Salvage a truncated big exam: close after the last complete question.
          const cut = raw.lastIndexOf("}");
          if (cut < 0) throw new Error("parse");
          parsed = JSON.parse(raw.slice(0, cut + 1) + "]}");
        }
        return { parsed, marksMap };
      };
      let parsed, marksMap;
      try { ({ parsed, marksMap }=await attempt(1)); }
      catch(e1){
        const truncated=/JSON|Unexpected end|Unterminated|parse/i.test(e1.message||"");
        if(truncated && totalQ>25){ ({ parsed, marksMap }=await attempt(0.5)); }
        else throw e1;
      }
      if(!parsed.questions?.length) throw new Error("No questions generated");
      // Phase 3: remember a summary of this exam's material for the study library
      // (never the material itself), same as the quiz flow.
      const exTopics = [...new Set(parsed.questions.map(q=>q.topic).filter(Boolean))];
      const exDoc = makeLibraryDoc({ title: parsed.title, subject: "", topics: exTopics, summary: parsed.summary, n: parsed.questions.length });
      if (exDoc) srs.addLibraryDoc(exDoc);
      const annotated = parsed.questions.map(q=>shuffleMCQOptions({
        ...q,
        marksPerQ: examMode==="custom" ? (marksMap[q.section]||1) : 1,
      }));
      setExamQs(annotated);setExamIdx(0);setExamAns({});setExamEvals(null);setShowConfetti(false);
      const tSec = examTimerOn ? Math.min(Math.max(parseInt(examTimerMin)||60,5),180)*60 : 0;
      setExamTotalSec(tSec); setExamTimeLeft(examTimerOn ? tSec : null);
      setExamPaused(false); setExamTimeUp(false); setExamReview(false); setShowSubmitPrompt(false); setExamTimeExpired(false);
      setScreen("exam_run");
      if(!isPro) unlocks.consumeExam();   // free daily exam is now used up
    }catch(err){setError(err.message.includes("parse")?t.errUnexpectedFormat:err.message);setScreen("exam_setup");}
  },[examFiles,examMode,examSections,examTotalQ,diff,sectionTotalQs,examTimerOn,examTimerMin,uploadFileToAnthropic,consumeQuestions,requireLogin,isPro,unlocks,studyModel,srs.bank]);

  const evaluateExam=useCallback(async(answers)=>{
    const hasWritten=examQs.some(q=>q.type==="written");
    if(!hasWritten){
      return examQs.map((q,i)=>q.type==="mcq"?{score:answers[i]===q.correct?1:0,feedback:answers[i]===q.correct?t.correct:t.incorrect}:{score:0,feedback:""});
    }
    setScreen("exam_eval");
    // Number the written answers 1..N in their own sequence (NOT the full
    // question index, which counts MCQs too). A dedicated 1-based "n" keeps the
    // model's mapping unambiguous so feedback can't land on the wrong question.
    const writtenIdxs=examQs.map((q,i)=>q.type==="written"?i:null).filter(x=>x!==null);
    const writtenLines=writtenIdxs.map((qi,k)=>
      "Answer #"+(k+1)+"\nQuestion: "+examQs[qi].question+
      "\nModel answer: "+(examQs[qi].answer||"(none provided)")+
      "\nStudent answer: \""+(answers[qi]||"(no answer)")+"\""
    ).join("\n\n");
    const evalPrompt=
      "Grade the "+writtenIdxs.length+" written answers below, numbered #1 to #"+writtenIdxs.length+". "+
      "Grade each student answer ONLY against the question and model answer under the SAME number, never carry over or mix answers between numbers. "+
      "Each feedback must refer to that one answer only.\n"+
      "Return ONLY JSON: {\"evals\":[{\"n\":1,\"score\":1.0,\"feedback\":\"brief\"}]} with exactly one entry per number, in order.\n"+
      "score: 1=correct, 0.5=partial, 0=wrong.\n\n"+writtenLines;
    // ~120 tokens of feedback per written answer; cap at 10k.
    const evalMaxTokens=Math.min(Math.max(writtenIdxs.length*120+1000,2000),10000);
    try{
      const res=await fetch("/api/anthropic",{method:"POST",headers:{"Content-Type":"application/json", ...(await authHeader())},
        body:JSON.stringify({model:AI_MODEL,max_tokens:evalMaxTokens,
          system:"Evaluate student exam answers. Return ONLY raw JSON.",
          messages:[{role:"user",content:[{type:"text",text:evalPrompt}]}]})});
      if(!res.ok) throw new Error("Eval error "+res.status);
      const parsed=JSON.parse(stripFences(await readStream(res)));
      const evals=Array.isArray(parsed.evals)?parsed.evals:[];
      const clamp=s=>{const n=Number(s);return Number.isFinite(n)?Math.max(0,Math.min(1,n)):0;};
      return examQs.map((q,i)=>{
        if(q.type==="mcq") return{score:answers[i]===q.correct?1:0,feedback:answers[i]===q.correct?t.correct:t.incorrect};
        const rank=writtenIdxs.indexOf(i); // 0-based position among written answers
        // Match on the answer's own 1-based number; fall back to positional order.
        const ev=evals.find(e=>Number(e.n)===rank+1) ?? evals[rank];
        return ev?{score:clamp(ev.score),feedback:ev.feedback||""}:{score:0,feedback:t.notEvaluated};
      });
    }catch{return examQs.map((q,i)=>({score:q.type==="mcq"?(answers[i]===q.correct?1:0):0,feedback:""}));}
  },[examQs]);

  const submitExam=useCallback(async(answersArg,opts={})=>{
    const answers = answersArg ?? examAns;
    const answered = examQs.reduce((c,q,i)=> (answers[i]!==undefined && answers[i]!=="") ? c+1 : c, 0);
    setExamAnsweredCount(answered);
    setExamTimeExpired(!!opts.expired);
    setExamTimeUsedSec(examTimerOn ? Math.max(0, examTotalSec - (timeLeftRef.current ?? 0)) : null);
    try{ sessionStorage.removeItem("revyy_exam"); }catch{ /* ignore */ }
    if(soundOn && !opts.expired) SoundEngine.submit();
    const evs=await evaluateExam(answers);
    setExamEvals(evs);
    const totalPossible=examQs.reduce((s,q)=>s+(q.marksPerQ||1),0);
    const total=evs.reduce((s,e,i)=>s+(e.score||0)*(examQs[i]?.marksPerQ||1),0);
    const pct=Math.round((total/totalPossible)*100);
    const passed=pct>=50;
    if(pct>=90){ setTimeout(()=>setShowConfetti(true),400); if(soundOn&&!opts.expired) setTimeout(()=>SoundEngine.celebrate(),600); }
    else if(soundOn&&!opts.expired){ passed?SoundEngine.pass():SoundEngine.fail(); }
    setScreen("exam_results");
  },[examQs,examAns,evaluateExam,soundOn,examTimerOn,examTotalSec]);

  // Time ran out: lock the screen, mark unanswered as "", and auto-submit.
  const handleTimeUp=useCallback(()=>{
    if(examTimeUp) return;
    setExamTimeUp(true);
    if(soundOn) SoundEngine.fail();
    const filled={...examAns};
    examQs.forEach((q,i)=>{ if(filled[i]===undefined) filled[i]=""; });
    setExamAns(filled);
    setTimeout(()=>submitExam(filled,{expired:true}),500);
  },[examTimeUp,examAns,examQs,soundOn,submitExam]);

  // Clicking final submit: if timed and time remains, offer a review first.
  const handleSubmitClick=()=>{
    if(examTimerOn && !examTimeUp && (examTimeLeft??0)>0 && !examReview) setShowSubmitPrompt(true);
    else submitExam();
  };

  const pickExam=(ans)=>{ setExamAns(prev=>({...prev,[examIdx]:ans})); if(soundOn) SoundEngine.tick(); };
  const nextExam=()=>{if(examIdx+1>=examQs.length)handleSubmitClick();else setExamIdx(i=>i+1);};
  const prevExam=()=>{if(examIdx>0)setExamIdx(i=>i-1);};

  // ── Timer effects ──
  useEffect(()=>{ timeLeftRef.current = examTimeLeft; },[examTimeLeft]);
  // Countdown tick, only during an active, unpaused, timed exam.
  useEffect(()=>{
    if(screen!=="exam_run" || !examTimerOn || examPaused || examTimeUp) return;
    const id=setInterval(()=>setExamTimeLeft(s=> s===null ? null : Math.max(0, s-1)),1000);
    return ()=>clearInterval(id);
  },[screen,examTimerOn,examPaused,examTimeUp]);
  // Fire time-up once when the clock reaches zero.
  useEffect(()=>{
    if(screen==="exam_run" && examTimerOn && examTimeLeft===0 && !examTimeUp) handleTimeUp();
  },[screen,examTimerOn,examTimeLeft,examTimeUp,handleTimeUp]);
  // Auto-pause + blur when the tab is hidden/switched, so the question can't be
  // seen off-screen. Applies even without a timer (it just hides the question).
  useEffect(()=>{
    if(screen!=="exam_run") return;
    const onVis=()=>{ if(document.hidden) setExamPaused(true); };
    document.addEventListener("visibilitychange",onVis);
    return ()=>document.removeEventListener("visibilitychange",onVis);
  },[screen]);
  // Drop focus from any input while paused so keystrokes can't reach it.
  useEffect(()=>{ if(examPaused) document.activeElement?.blur?.(); },[examPaused]);
  // Snapshot the live exam for refresh-recovery; persist on unload.
  useEffect(()=>{
    examSnapRef.current = (screen==="exam_run" && examQs.length && !examTimeUp)
      ? { examQs, examAns, examIdx, examTimeLeft, examTotalSec, examTimerOn, examMode, examSections, diff }
      : null;
  });
  useEffect(()=>{
    const save=()=>{ try{ if(examSnapRef.current) sessionStorage.setItem("revyy_exam",JSON.stringify(examSnapRef.current)); }catch{ /* ignore */ } };
    window.addEventListener("beforeunload",save);
    return ()=>window.removeEventListener("beforeunload",save);
  },[]);
  // On mount, offer to resume an exam interrupted by a refresh.
  useEffect(()=>{
    try{ const s=sessionStorage.getItem("revyy_exam"); if(s) setExamResume(JSON.parse(s)); }catch{ /* ignore */ }
  },[]);

  const resumeExam=()=>{
    const r=examResume; if(!r) return;
    setExamQs(r.examQs||[]); setExamAns(r.examAns||{}); setExamIdx(r.examIdx||0);
    setExamTotalSec(r.examTotalSec||0); setExamTimeLeft(r.examTimeLeft??null); setExamTimerOn(!!r.examTimerOn);
    setExamMode(r.examMode||null); if(r.examSections) setExamSections(r.examSections); if(r.diff!==undefined) setDiff(r.diff);
    setExamPaused(false); setExamTimeUp(false); setExamReview(false); setExamEvals(null);
    setExamResume(null); setScreen("exam_run");
  };
  const discardResume=()=>{ try{ sessionStorage.removeItem("revyy_exam"); }catch{ /* ignore */ } setExamResume(null); };
  const fmtClock=(s)=>{ const m=Math.floor(s/60), ss=s%60; return m+":"+String(ss).padStart(2,"0"); };

  // After returning from Stripe checkout (?upgraded=true): the webhook writes
  // is_pro asynchronously, so poll Supabase for a fresh value until it flips
  // to true (or we give up), showing an "activating" overlay meanwhile.
  useEffect(() => {
    if (!user?.id) return;          // wait until the signed-in user is known
    const params = new URLSearchParams(window.location.search);
    if (params.get("upgraded") !== "true") return;

    // Strip the param immediately so refreshes don't re-trigger this.
    const url = new URL(window.location.href);
    url.searchParams.delete("upgraded");
    window.history.replaceState({}, "", url.pathname + url.search);

    let cancelled = false;
    setActivating(true);

    (async () => {
      // ~30s of polling: the webhook usually lands within a few seconds.
      for (let i = 0; i < 20 && !cancelled; i++) {
        const pro = await refreshProfile();   // always a fresh Supabase read
        if (pro) break;
        await new Promise((r) => setTimeout(r, 1500));
      }
      if (cancelled) return;
      setActivating(false);
      setUpgraded(true);
      setTimeout(() => !cancelled && setUpgraded(false), 6000);
    })();

    return () => { cancelled = true; };
  }, [user, refreshProfile]);

  // Delete account: remove all data + auth user via the serverless function,
  // then go to the public home page and clear the local session.
  // Returns { error } so the settings modal can show a message on failure.
  const confirmDeleteAccount = async () => {
    const { error } = await deleteAccount();
    if (error) return { error };
    // Wipe locally-stored per-user data too.
    try { localStorage.removeItem("revyy_settings"); localStorage.removeItem("sq_v3"); } catch { /* ignore */ }
    navigate("/", { replace: true });
    await signOut();
    return {};
  };

  const openSettings  = ()  => { setSettingsDraft({...settings, lang}); setShowSettings(true); };
  const cancelSettings= ()  => { setSettingsDraft(null); setShowSettings(false); };
  const applySettings = ()  => {
    if(!settingsDraft) return;
    const { lang:draftLang, ...rest } = settingsDraft;   // language is applied via its own context, not stored in settings
    setSettings(rest);
    setSoundOn(rest.sound);
    setDiff(rest.defaultDiff);
    setNumQ(rest.defaultQCount);
    SoundEngine.setVolume(rest.volume);
    if(draftLang && draftLang!==lang) setLang(draftLang);
    window.storage.set("revyy_settings",JSON.stringify(rest)).catch(()=>{});
    setSettingsDraft(null);
    setShowSettings(false);
  };
  const updateDraft = (key,val) => setSettingsDraft(prev=>({...prev,[key]:val}));

  const haptic = (ms=35) => Haptics.buzz(ms);

  const processFile = useCallback(async (f, limitMB) => {
    const isPdf=f.type==="application/pdf", isImg=f.type.startsWith("image/"), isTxt=f.type.startsWith("text/")||/\.(txt|md|csv)$/i.test(f.name);
    if (!isPdf&&!isImg&&!isTxt) { setError(t.errFileType2); return; }
    try {
      if (isTxt) { const text=await readText(f); setFile({type:"text",content:text,mime:null,name:f.name,sizeMB:f.size/1024/1024}); }
      // PDFs/images are uploaded to the Anthropic Files API at generate time, 
      // keep the raw File (no base64) so large files aren't inflated.
      else { setFile({type:isPdf?"pdf":"image",raw:f,mime:f.type,name:f.name,sizeMB:f.size/1024/1024}); }
      setError("");
    } catch { setError(t.errReadFile2); }
  },[]);

  const loadFile = useCallback(async (f) => {
    if (!f) return;
    setError("");
    const fileMB  = f.size/1024/1024;
    const limitMB = fileLimitMB();
    if (fileMB > PRO_FILE_MB) { setError(t.errFileOverPro.replace("{size}",fmtMB(f.size)).replace("{max}",PRO_FILE_MB)); return; }
    if (fileMB > limitMB) {
      // Too big for the current limit. Pro can't exceed 999MB; free users can
      // watch an ad to raise the limit to 10MB for an hour.
      if (!isPro && fileMB <= AD_FILE_MB) {
        setError(t.errFileOverFree.replace("{size}",fmtMB(f.size)).replace("{limit}",limitMB).replace("{ad}",AD_FILE_MB));
        setUnlockFeature("filesize");
      } else {
        setError(t.errFileOver.replace("{size}",fmtMB(f.size)).replace("{limit}",limitMB)+(isPro?"":" "+t.errUpgradeSize));
      }
      return;
    }
    await processFile(f, limitMB);
  },[fileLimitMB, processFile, isPro]);

  const generate = useCallback(async () => {
    if (requireLogin()) return;   // logged-out visitors are sent to sign-up
    setError(""); setLimitHit(false);
    const finalType = canUseQType(qType)?qType:"mcq";
    const finalNumQ = effectiveNumQ();
    if (tab==="media") {
      if (!isPro) { setError(t.mediaProOnly); return; }
      if (!mediaFile) { setError(t.errUploadFirst); return; }
    } else if (tab==="file"||tab==="photo") {
      if (!file) { setError(t.errUploadFirst); return; }
    } else if (!textVal.trim()) { setError(t.errPasteFirst); return; }

    setScreen("loading");
    try {
      let blocks = [];
      if (tab==="media") {
        // Transcribe the lecture, then treat the transcript as pasted notes.
        const transcript = await transcribeMedia(mediaFile);
        if (!transcript) throw new Error(t.errTranscribe);
        blocks=[{type:"text",text:`Lecture transcript:\n\n${transcript}`}];
      } else if (tab==="file"||tab==="photo") {
        if (file.type==="text") blocks=[{type:"text",text:`Study material (${file.name}):\n\n${file.content}`}];
        else {
          const fileId = await uploadFileToAnthropic(file.raw);
          blocks = file.type==="pdf"
            ? [{type:"document",source:{type:"file",file_id:fileId}}]
            : [{type:"image",source:{type:"file",file_id:fileId}}];
        }
      } else {
        blocks=[{type:"text",text:`Study material:\n\n${textVal.trim()}`}];
      }
      // Pro: fold in any EXTRA files attached beyond the primary (docs uploaded,
      // media transcribed, text inlined), so one quiz can span several sources.
      // A bad extra is skipped rather than failing the whole quiz.
      for (const ex of (isPro ? extraFiles : [])) {
        try {
          if (ex.kind === "media") {
            const tr = await transcribeMedia(ex);
            if (tr) blocks.push({ type:"text", text:`Lecture transcript (${ex.name}):\n\n${tr}` });
          } else if (ex.type === "text") {
            blocks.push({ type:"text", text:`Study material (${ex.name}):\n\n${ex.content}` });
          } else {
            const fid = await uploadFileToAnthropic(ex.raw);
            blocks.push(ex.type==="pdf" ? { type:"document", source:{type:"file",file_id:fid} } : { type:"image", source:{type:"file",file_id:fid} });
          }
        } catch { /* skip a bad extra, keep the rest of the quiz */ }
      }
      // Content gate BEFORE charging quota, so a wrongly-blocked upload never
      // costs a real learner. Explicit / harmful / non-study material is stopped
      // here; everything a student could genuinely study from passes through.
      const gate = await gateContent({ blocks, uiLangName: LANGS[lang]?.name });
      if (gate.decision === "block") { setError(gateMessage(gate.category, t)); setScreen("upload"); return; }

      // Enforce the daily question limit (server-side; reserves the questions).
      const consumed = await consumeQuestions(finalNumQ);
      if (consumed && consumed.allowed === false) {
        const left = consumed.remaining ?? 0;
        setLimitHit(true); // offer the question-pack button under the error (all users)
        setError(
          isPro
            ? `Daily limit reached (${consumed.daily_limit}/day). You have ${left} questions left, grab a question pack for more.`
            : left > 0
              ? `That's ${finalNumQ} questions but you only have ${left} left today. Lower the count, watch an ad for +10, buy a question pack, or go Pro.`
              : `Daily question limit reached. Watch an ad for +10, buy a question pack, or upgrade to Pro.`
        );
        setScreen("upload"); return;
      }
      // Generate, then validate the count. The model sometimes returns fewer
      // questions than asked, if so, regenerate (up to 2 extra tries) and keep
      // whichever attempt produced the most questions. A parse error (usually a
      // truncated response) counts as a failed attempt rather than aborting.
      // Personalize the set to this learner (weak-topic emphasis + calibration),
      // and fold in the content feedback loop: an "avoid these" list built from
      // the questions they have flagged as bad, so generation self-improves.
      // Both empty for newcomers, so their experience is unchanged at first.
      const learnerBrief = [buildLearnerBrief(studyModel), buildAvoidNote(srs.bank)].filter(Boolean).join("\n\n");
      // Batched generation so a big count (e.g. 100) is actually reached: models
      // reliably return only ~20-30 per call, so we ask in chunks and accumulate
      // deduped questions, telling each chunk to avoid what's already written,
      // until we hit the target (or run out of new material). Small counts are a
      // single chunk, same as before. withSummary rides the first chunk only.
      const CHUNK = 25;
      const seen = new Set();
      const collected = [];
      let title = "", subject = "", summary = "", lastErr = null, emptyRounds = 0, calls = 0;
      const maxCalls = finalNumQ <= CHUNK ? 3 : Math.ceil(finalNumQ / CHUNK) + 3;
      while (collected.length < finalNumQ && calls < maxCalls && emptyRounds < 2) {
        calls++;
        const need = Math.min(CHUNK, finalNumQ - collected.length);
        const avoidSeen = collected.length
          ? `\nDo NOT repeat or lightly reword any of these questions already written:\n- ${collected.slice(-30).map((q) => String(q.question || "").slice(0, 120)).join("\n- ")}`
          : "";
        let r = null;
        try {
          r = await callClaude({ blocks, numQ: need, diff, type: finalType, uiLangName: LANGS[lang]?.name, learnerBrief: learnerBrief + avoidSeen, withSummary: calls === 1 });
        } catch (e1) { lastErr = e1; }
        let added = 0;
        if (r?.questions?.length) {
          if (calls === 1) { title = r.title || ""; subject = r.subject || ""; summary = r.summary || ""; }
          for (const q of r.questions) {
            const key = String(q?.question || "").trim().toLowerCase();
            if (!key || seen.has(key)) continue;
            seen.add(key); collected.push(q); added++;
            if (collected.length >= finalNumQ) break;
          }
        }
        emptyRounds = added === 0 ? emptyRounds + 1 : 0;
      }
      if (!collected.length) throw (lastErr || new Error("No questions returned"));
      const res = { title, subject, summary, questions: collected.slice(0, finalNumQ) };
      genBlocksRef.current = blocks; // keep the source material for FlagFix regen
      // Phase 3: remember a summary of this upload (never the material itself) so
      // Revyy can quiz across everything studied. Skipped for the cumulative
      // review + weak-spot drill, which pass no summary.
      const libTopics = [...new Set((res.questions || []).map((q) => q.topic).filter(Boolean))];
      const libDoc = makeLibraryDoc({ title: res.title, subject: res.subject, topics: libTopics, summary: res.summary, n: res.questions.length });
      if (libDoc) srs.addLibraryDoc(libDoc);
      // fresh + genDiff mark this as a first-play, difficulty-calibrated round so
      // the results handler logs it into the adaptive-difficulty perf history.
      setQuiz({...res, type:finalType, fresh:true, genDiff:diff});
      setQIdx(0); setAnswers([]); setSelected(null);
      setScreen("quiz");
    } catch(err) {
      setError(err.message.includes("parse")?t.errAiFormat:err.message);
      setScreen("upload");
    }
  },[isPro,qType,tab,file,mediaFile,textVal,extraFiles,diff,canUseQType,effectiveNumQ,consumeQuestions,uploadFileToAnthropic,transcribeMedia,requireLogin,studyModel,srs.bank]);

  // Generate a fresh MCQ quiz focused on the topics the learner is weakest on,
  // no upload needed. Uses accumulated topic mastery + sample missed questions to
  // steer the model (and avoid repeating ones they've already seen).
  const drillWeakSpots = useCallback(async () => {
    if (requireLogin()) return;
    const ranked = topicMastery(srs.topicStats);
    const picks = (ranked.filter(t => t.weak).length ? ranked.filter(t => t.weak) : ranked).slice(0, 6);
    if (!picks.length) return;
    const n = 10;
    setError(""); setLimitHit(false);
    const consumed = await consumeQuestions(n);
    if (consumed && consumed.allowed === false) {
      setLimitHit(true);
      setError(isPro ? `Daily limit reached, grab a question pack for more.` : `Daily question limit reached. Watch an ad for +10, buy a question pack, or upgrade to Pro.`);
      setScreen("upload"); return; // upload screen shows the error + pack/ad options
    }
    setScreen("loading");
    try {
      const topicKeys = picks.map(x => x.topic);
      const keys = new Set(topicKeys.map(s => s.toLowerCase()));
      // Phase 2 cost cut: reuse vetted questions from the learner's OWN bank on
      // these weak topics (up to half the set), then generate only the rest.
      // Empty bank -> reused is [] and the whole set is generated, as before.
      const reused = bankPick(srs.bank, topicKeys, DRILL_REUSE_MAX);
      const reusedHashes = reused.map(q => q._bankHash);
      const need = n - reused.length;
      const samples = (srs.cards || []).filter(c => keys.has(String(c.topic || "").toLowerCase())).slice(0, 12).map(c => c.front);
      // Tell the generator to avoid the questions already seen AND the exact ones
      // being reused, so the fresh half never duplicates the banked half.
      const avoidSamples = [...samples, ...reused.map(q => q.question)].slice(0, 16);
      const material = `The student is weak on these topics: ${topicKeys.join(", ")}.\nWrite fresh multiple-choice practice questions spread across these topics that genuinely test understanding, not just recall.${avoidSamples.length ? `\nDo NOT reuse these exact questions they have already seen:\n- ${avoidSamples.join("\n- ")}` : ""}`;
      const blocks = [{ type: "text", text: material }];
      const learnerBrief = [buildLearnerBrief(studyModel, { forDrill: true }), buildAvoidNote(srs.bank)].filter(Boolean).join("\n\n");
      let res = null, lastErr = null;
      if (need > 0) {
        for (let attempt = 0; attempt < 3; attempt++) {
          let r = null;
          try { r = await callClaude({ blocks, numQ: need, diff, type: "mcq", uiLangName: LANGS[lang]?.name, learnerBrief }); } catch (e1) { lastErr = e1; }
          if (r?.questions?.length) { if (!res || r.questions.length > res.questions.length) res = r; if (res.questions.length >= need) break; }
        }
        if (!res?.questions?.length && !reused.length) throw (lastErr || new Error("No questions returned"));
      }
      const generated = res?.questions || [];
      // Mix reused (internal hash stripped) with the freshly generated ones and
      // shuffle so the banked half isn't all up front.
      const stripHash = (q) => { const c = { ...q }; delete c._bankHash; return c; };
      const merged = [...reused.map(stripHash), ...generated].sort(() => Math.random() - 0.5).slice(0, n);
      if (!merged.length) throw (lastErr || new Error("No questions returned"));
      genBlocksRef.current = blocks; // keep the weak-spot brief for FlagFix regen
      if (reusedHashes.length) srs.bankUsed(reusedHashes); // rotate what's served next time
      setQuiz({ title: res?.title || t.drillWeak, subject: "", questions: merged, type: "mcq", fresh:true, genDiff:diff });
      setQIdx(0); setAnswers([]); setSelected(null);
      setScreen("quiz");
    } catch (err) {
      setError(err.message.includes("parse") ? t.errAiFormat : err.message);
      setScreen("upload");
    }
  }, [requireLogin, srs.topicStats, srs.cards, srs.bank, srs.bankUsed, consumeQuestions, diff, lang, t, isPro, studyModel]);

  // Phase 3: "quiz me on everything" cumulative review. Generates a mixed MCQ
  // set from the stored summaries of ALL the material the learner has studied
  // (no upload needed), so it feels like Revyy remembers their whole term.
  const reviewLibrary = useCallback(async () => {
    if (requireLogin()) return;
    const material = buildLibraryMaterial(srs.library);
    if (!material) return;
    const n = 10;
    setError(""); setLimitHit(false);
    const consumed = await consumeQuestions(n);
    if (consumed && consumed.allowed === false) {
      setLimitHit(true);
      setError(isPro ? `Daily limit reached, grab a question pack for more.` : `Daily question limit reached. Watch an ad for +10, buy a question pack, or upgrade to Pro.`);
      setScreen("upload"); return;
    }
    setScreen("loading");
    try {
      const blocks = [{ type: "text", text: material }];
      const learnerBrief = [buildLearnerBrief(studyModel), buildAvoidNote(srs.bank)].filter(Boolean).join("\n\n");
      let res = null, lastErr = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        let r = null;
        try { r = await callClaude({ blocks, numQ: n, diff, type: "mcq", uiLangName: LANGS[lang]?.name, learnerBrief }); } catch (e1) { lastErr = e1; }
        if (r?.questions?.length) { if (!res || r.questions.length > res.questions.length) res = r; if (res.questions.length >= n) break; }
      }
      if (!res?.questions?.length) throw (lastErr || new Error("No questions returned"));
      genBlocksRef.current = blocks; // keep the summaries for FlagFix regen
      setQuiz({ ...res, title: res.title || t.libraryReviewTitle, subject: "", type: "mcq", fresh:true, genDiff:diff });
      setQIdx(0); setAnswers([]); setSelected(null);
      setScreen("quiz");
    } catch (err) {
      setError(err.message.includes("parse") ? t.errAiFormat : err.message);
      setScreen("upload");
    }
  }, [requireLogin, srs.library, srs.bank, consumeQuestions, diff, lang, t, isPro, studyModel]);

  const pick    = i => {
    if(selected!==null) return;
    setSelected(i); haptic();
    // Immediate feedback reveals right/wrong now, so play that; otherwise a soft click.
    if (settings.feedback==="immediate") (i===quiz.questions[qIdx].correct ? SoundEngine.correct : SoundEngine.wrong)();
    else SoundEngine.click();
  };
  const nextQ   = (isCorrect, detail) => {
    // `detail` carries what the learner picked (e.g. {selected} for MCQ) so the
    // results screen can show "Your answer" next to the correct one.
    const upd=[...answers,{isCorrect,...(detail||{})}]; setAnswers(upd); setSelected(null);
    if (qIdx+1>=quiz.questions.length) setScreen("results");
    else setQIdx(i=>i+1);
  };
  const nextMCQ = () => { if(selected===null)return; nextQ(selected===quiz.questions[qIdx].correct,{selected}); };
  // Retry re-shuffles the SAME questions into a new order (never regenerates),
  // so a second attempt isn't a memorised run. Marked `replay` so the results
  // handler doesn't double-count it into stats / the deck / the adaptive signal.
  const retry   = () => {
    setQuiz(prev => prev ? { ...prev, questions:[...prev.questions].sort(()=>Math.random()-0.5), fresh:false, replay:true } : prev);
    setQIdx(0);setAnswers([]);setSelected(null);setScreen("quiz");
  };
  // Swap the flagged question in place with a freshly-generated replacement and
  // clear any pick, so the learner answers the corrected question (FlagFix).
  const replaceCurrentQuestion = (nq, reason) => {
    // The question being swapped out was flagged as bad, so record it as a
    // reject (Phase 2 feedback loop): it is dropped from the vetted bank and its
    // gist is fed to future generation as an "avoid this" signal.
    const old = quiz?.questions?.[qIdx];
    if (old?.question) srs.bankReject(old.question, reason || "flagged");
    setQuiz((prev) => {
      if (!prev) return prev;
      const qs = prev.questions.slice();
      qs[qIdx] = { ...qs[qIdx], ...nq };
      return { ...prev, questions: qs };
    });
    setSelected(null);
  };
  // Open an uploaded file in a new tab so the learner can see what they sent.
  const openFile = (f) => {
    try {
      const blob = f?.raw ? f.raw : (f?.content != null ? new Blob([f.content], { type: "text/plain" }) : null);
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank", "noopener");
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch { /* ignore */ }
  };
  // "New material" returns to the setup screen but KEEPS whatever was uploaded,
  // so a learner can tweak settings and regenerate without re-uploading. Use the
  // file's own remove control (the red x) to actually clear it.
  const newMat  = () => { setScreen("upload");setQuiz(null);setError(""); };
  // Feature D: re-drill ONLY the questions just missed, as a fresh mini-quiz
  // (active recall on exactly your weak spots, right now). Reuses the whole quiz
  // flow, no new generation, no quota spent, and no lockout: keep fixing until
  // you get them all. The spaced-repetition deck still handles the long game.
  const missedThisQuiz = quiz && quiz.type!=="match"
    ? quiz.questions.filter((_, i) => answers[i] && answers[i].isCorrect === false)
    : [];
  const fixMisses = () => {
    if (!missedThisQuiz.length) return;
    // fresh:false so this re-drill of already-missed questions is NOT logged
    // into the adaptive-difficulty perf history (it would skew accuracy low).
    setQuiz((prev) => ({ ...prev, questions: missedThisQuiz, title: t.fixMissesTitle, fresh:false }));
    setQIdx(0); setAnswers([]); setSelected(null);
    setScreen("quiz");
  };

  const score = answers.filter(a=>a.isCorrect).length;
  const pct   = quiz ? Math.round((score/quiz.questions.length)*100) : 0;
  const badge = pct>=90?{icon:"trophy",text:t.excellent}:pct>=75?{icon:"target",text:t.great}:pct>=60?{icon:"notes",text:t.good}:{icon:"flame",text:t.keep};
  // Adaptive difficulty, forward nudge: after a very strong or rough round,
  // offer to move the next quiz up or down a level (reward framing only). Uses
  // the level this set was actually generated at, not the current picker value.
  const resNudge = quiz ? resultNudge({ diff: quiz.genDiff ?? diff, correct: score, total: quiz.questions.length }) : null;

  // ── Coach actions ────────────────────────────────────────────────
  const openPlanSetup = () => { if (requireLogin()) return; setPlanErr(""); setScreen("plan_setup"); };
  const buildAndSavePlan = () => {
    if (requireLogin()) return;
    setPlanErr("");
    const today = new Date().toLocaleDateString("en-CA");
    if (!planForm.testDate || planForm.testDate < today) { setPlanErr(t.coachInvalidDate); return; }
    const { count } = parseChapters(planForm.chapterNames, planForm.chapters);
    if (!count || count < 1) { setPlanErr(t.coachInvalidCh); return; }
    const plan = buildPlan({ testDate:planForm.testDate, chapters:planForm.chapters, chapterNames:planForm.chapterNames, isPro, mode:planForm.mode, reminderTime:planForm.reminderTime, title:planForm.title });
    savePlan(plan); setActivePlanId(plan.id); setConfirmDelPlan(false);
    setPlanForm({ title:"", testDate:"", chapters:"6", chapterNames:"", mode:"selfpaced", reminderTime:"18:00" });
    setScreen("plan");
  };
  // Start a scheduled day: preset the generator to that day's format + count
  // (or open exam mode for a Pro mock). planSession drives completion on finish.
  const startPlanDay = (plan, dayIndex) => {
    if (requireLogin()) return;
    const day = plan?.days?.[dayIndex]; if (!day) return;
    setPlanSession({ planId:plan.id, dayIndex, format:day.format, numQ:day.numQ, label:day.label, kind:day.kind });
    planDoneRef.current = null;
    if (day.format==="exam") { setScreen("exam_setup"); return; }
    const type = ["mcq","cards","fill","match"].includes(day.format) ? day.format : "mcq";
    const n = Math.min(day.numQ||15, qCap());
    setQType(type); setNumQ(n); setCustomQ(String(n)); setUseCustomQ(false);
    setTab("file"); setFile(null); setExtraFiles([]); setTextVal(""); setError(""); setLimitHit(false);
    setScreen("upload");
  };
  const backToPlan = () => { const pid = planSession?.planId; setPlanSession(null); if (pid) setActivePlanId(pid); setScreen("plan"); };
  // Share-a-quiz: create a public link for the just-finished quiz.
  const createShareLink = async () => {
    if (shareBusy) return;
    setShareErr(""); setShareCopied(false);
    if (shareLink) { setShareOpen(true); return; } // reuse an already-made link
    setShareBusy(true);
    try {
      const token = await getToken?.();
      const ownerName = (settings.nickname||"").trim() || (user?.email || "").split("@")[0] || "";
      const res = await fetch("/api/study", {
        method:"POST",
        headers:{ "Content-Type":"application/json", ...(token ? { Authorization:`Bearer ${token}` } : {}) },
        body: JSON.stringify({ action:"createShare", quiz:{ title:quiz?.title, subject:quiz?.subject, type:quiz?.type, diff, questions:quiz?.questions, owner:ownerName, ownerScore:score, ownerTotal:quiz?.questions?.length||0 } }),
      });
      const d = await res.json().catch(()=>({}));
      if (!res.ok || !d.id) throw new Error();
      setShareLink(`${window.location.origin}/q/${d.id}`);
      setShareOpen(true);
    } catch { setShareErr(t.shareErr); setShareOpen(true); }
    setShareBusy(false);
  };
  const copyShare = async () => { try { await navigator.clipboard.writeText(shareLink); setShareCopied(true); setTimeout(()=>setShareCopied(false),1800); } catch { /* ignore */ } };
  // Continue a saved, unfinished exam exactly where it left off.
  const resumeMock = () => {
    const r = readMockResume();
    if (!r) { setMockResume(null); return; }
    const { mock: m, tilt, p } = r;
    const secIdx = Math.min(Math.max(0, p.secIdx || 0), m.sections.length - 1);
    const nQ = m.sections[secIdx]?.questions?.length || 1;
    setMock(m); // the full mock, incl scoreMode/adaptive/routing/_route
    setMockTilt(tilt || "standard");
    setMockPresetId(m.presetId);
    setMockSecIdx(secIdx);
    setMockQIdx(Math.min(Math.max(0, p.qIdx || 0), nQ - 1));
    setMockAns(Array.isArray(p.ans) && p.ans.length ? p.ans : m.sections.map(() => []));
    setMockSecResults(Array.isArray(p.secResults) ? p.secResults : []);
    setMockSecTimeLeft(typeof p.secTimeLeft === "number" ? p.secTimeLeft : (m.sections[secIdx].minutes * 60));
    setMockPaused(false);
    submittedSecRef.current = -1;
    mockScoredRef.current = null;
    setScreen(p.phase === "break" ? "mock_break" : "mock_run");
  };
  // Throw away the saved exam so the picker starts clean.
  const discardMockResume = () => { clearMockResume(); setMockResume(null); };
  // Generate a full standardized mock (all sections, from spec, no upload).
  const startMock = async () => {
    if (requireLogin()) return;
    if (!isPro) { setShowProModal(true); return; }
    setMockGenErr("");
    clearMockResume(); // a fresh exam supersedes any half-finished one
    // Server-enforced, account-tied daily cap: atomically reserve one mock.
    const cap = await consumeMock();
    if (!cap || cap.allowed === false) { setMockGenErr(t.mockDailyLimit.replace("{n}", cap?.mock_daily_cap ?? 2)); return; }
    const exam = getMock(mockPresetId) || MOCK_EXAMS[0];
    setScreen("mock_gen");
    try {
      // Non-adaptive forms get one difficulty tilt for the whole exam (luck of the
      // draw; ~25% easier / 50% standard / 25% harder). Adaptive forms (digital
      // SAT/PSAT, GRE) instead run a mixed first module, then route each later
      // module off the taker's performance, so their opening module is "standard".
      const tilt = exam.adaptive ? "standard" : ["easier", "standard", "standard", "harder"][Math.floor(Math.random() * 4)];
      setMockTilt(tilt);
      // Build ONLY the first section now; the rest are built on demand as the
      // user proceeds, faster start, and no cost for sections never reached.
      const sec0 = exam.sections[0];
      const qs = await buildMockSection(exam, sec0, tilt);
      if (!qs.length) throw new Error("Couldn't generate the exam, please try again.");
      submittedSecRef.current = -1;
      // Carry the WHOLE exam spec into state (scoreMode, goodScore, adaptive,
      // routing, totals) so scoreMock has everything it needs at the end.
      setMock({ ...exam, presetId: exam.id, sections: exam.sections.map((s, i) => ({ ...s, questions: i === 0 ? qs : [] })) });
      setMockSecIdx(0); setMockQIdx(0);
      setMockAns(exam.sections.map(() => []));
      setMockSecResults([]); setMockSecTimeLeft(exam.sections[0].minutes * 60); setMockPaused(false);
      setScreen("mock_run");
    } catch (e) {
      setMockGenErr(e.message || "Generation failed. Please try again.");
      setScreen("mock_intro");
    }
  };
  const enableReminders = async () => { try { if (typeof Notification!=="undefined") { const p = await Notification.requestPermission(); setNotifPerm(p); } } catch { /* ignore */ } };
  // Tick a coached day off (once) when its quiz/exam results appear.
  useEffect(() => {
    if (!planSession) return;
    if (screen==="results" && quiz && planDoneRef.current!==quiz) {
      planDoneRef.current = quiz;
      completePlanDay(planSession.planId, planSession.dayIndex, { score, total: quiz.questions.length });
    } else if (screen==="exam_results" && examEvals && planDoneRef.current!==examEvals) {
      planDoneRef.current = examEvals;
      const possible = examQs.reduce((s,q)=>s+(q.marksPerQ||1),0) || examEvals.length || 1;
      const got = examEvals.reduce((s,e,i)=>s+((e?.score||0)*(examQs[i]?.marksPerQ||1)),0);
      completePlanDay(planSession.planId, planSession.dayIndex, { score: Math.round((got/possible)*100), total: 100 });
    }
  }, [screen, quiz, examEvals, planSession, score, examQs, completePlanDay]);

  // ── HOME ─────────────────────────────────────────────────────────
  if (screen==="home") return (
    <div style={Sb.root}><style>{CSS}</style>
      <ActivatingOverlay show={activating}/>
      <AdBanners isPro={isPro}/>
      {upgraded && <div style={{position:"fixed",top:0,left:0,right:0,zIndex:800,background:"#16a34a",color:"#fff",textAlign:"center",padding:"11px 14px",fontSize:14,fontWeight:700,fontFamily:"inherit",boxShadow:"0 2px 12px rgba(0,0,0,0.25)"}}>{t.welcomePro}</div>}
      <div style={Sb.hero}>
        <div className="rv-hero-inner">
          <button onClick={()=>navigate("/")} title={t.mainSite} className="rv-hero-back" style={{background:"none",border:"none",cursor:"pointer",fontSize:13,color:"rgba(255,255,255,0.78)",fontFamily:"inherit",padding:0,fontWeight:500,marginBottom:18,display:"inline-flex",alignItems:"center",gap:5}}>← {t.mainSite}</button>
          <div className="rv-hero-bar">
            <span style={{...Sb.brand,color:"#fff"}}><Logo/>{t.appName}
              {isPro && <span style={{marginLeft:7,padding:"2px 9px",borderRadius:999,fontSize:11,fontWeight:800,letterSpacing:0.8,color:"#422006",background:"linear-gradient(135deg,#fde68a,#f59e0b)",boxShadow:"0 2px 8px rgba(245,158,11,0.35)"}}>PRO</span>}
              <DevBadge/></span>
            <div className="rv-hero-tools">
              {user ? (
                <button onClick={()=>openSettings()} title={t.accountLbl} aria-label={t.accountLbl}
                  style={{width:36,height:36,borderRadius:"50%",background:"rgba(255,255,255,0.16)",border:"1.5px solid rgba(255,255,255,0.35)",color:"#fff",fontSize:15,fontWeight:700,cursor:"pointer",fontFamily:"inherit",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                  {(user.email||"?").charAt(0).toUpperCase()}
                </button>
              ) : (
                <button onClick={()=>navigate("/login")} style={{background:"rgba(255,255,255,0.16)",color:"#fff",border:"1px solid rgba(255,255,255,0.3)",borderRadius:8,fontSize:12,fontWeight:600,padding:"7px 14px",cursor:"pointer",fontFamily:"inherit"}}>{t.logIn}</button>
              )}
              <ThemeSwitch isDark={isDarkTheme} onToggle={toggleTheme} onDark />
            </div>
          </div>
          <h1 className="rv-hero-head" style={Sb.h1}>{t.tagline}</h1>
          <p className="rv-hero-sub" style={{fontSize:14,color:"#c7d2fe",lineHeight:1.6,margin:0,maxWidth:300}}>{t.sub}</p>
          <button className="rv-hero-cta" style={Sb.btnHero} onClick={()=>setScreen("upload")}>{t.start}</button>
        </div>
      </div>

      <div className="rv-home-body" style={{padding:"20px 16px 32px"}}>
        {/* Smart Review, spaced repetition of missed questions + exam countdown */}
        <div style={{background:srs.dueCount>0?"linear-gradient(135deg,#4338ca,#6366f1)":"var(--color-background-primary)",border:srs.dueCount>0?"none":"0.5px solid var(--color-border-tertiary)",borderRadius:14,padding:"14px 16px",marginBottom:18,boxShadow:srs.dueCount>0?"0 4px 16px rgba(67,56,202,0.3)":"none"}}>
          <div style={{display:"flex",alignItems:"center",gap:12}}>
            <span style={{flexShrink:0,display:"flex",color:srs.dueCount>0?"#fff":"var(--color-accent)"}}><Icon name="repeat" size={23}/></span>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontWeight:700,fontSize:14,color:srs.dueCount>0?"#fff":"var(--color-text-primary)"}}>{t.srsTitle}</div>
              <div style={{fontSize:11.5,marginTop:2,lineHeight:1.4,color:srs.dueCount>0?"rgba(255,255,255,0.85)":"var(--color-text-secondary)"}}>
                {srs.dueCount>0 ? t.srsDue.replace("{n}",srs.dueCount).replace("{s}",srs.dueCount>1?"s":"") :
                 srs.totalCount>0 ? t.srsCaughtUp.replace("{n}",srs.totalCount).replace("{s}",srs.totalCount>1?"s":"") :
                 t.srsEmpty}
              </div>
            </div>
            {srs.totalCount>0 && (
              <div style={{display:"flex",alignItems:"center",gap:8,flexShrink:0}}>
                {srs.dueCount===0 && <Icon name="check" size={18} stroke={2.4} style={{color:"#16a34a"}}/>}
                <button onClick={startQuick10} style={{border:"none",borderRadius:10,padding:"9px 16px",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:"inherit",...(srs.dueCount>0?{background:"#fff",color:"#4338ca"}:{background:"var(--color-accent)",color:"#fff"})}}>{t.quick10}</button>
              </div>
            )}
          </div>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:10,marginTop:12,paddingTop:12,borderTop:srs.dueCount>0?"0.5px solid rgba(255,255,255,0.2)":"0.5px solid var(--color-border-tertiary)"}}>
            <span style={{fontSize:12,fontWeight:600,color:srs.dueCount>0?"rgba(255,255,255,0.9)":"var(--color-text-secondary)"}}>
              {srs.examDate ? t.srsExamIn.replace("{n}",srs.daysToExam).replace("{s}",srs.daysToExam===1?"":"s") : t.srsSetExam}
            </span>
            <input type="date" value={srs.examDate||""} min={new Date().toISOString().slice(0,10)}
              onChange={e=>srs.setExamDate(e.target.value)}
              style={{border:"0.5px solid var(--color-border-secondary)",borderRadius:8,padding:"5px 8px",fontSize:12,fontFamily:"inherit",background:"var(--color-background-secondary)",color:"var(--color-text-primary)",outline:"none",colorScheme:srs.dueCount>0?"dark":"light"}}/>
          </div>
        </div>
        {/* Topic mastery, per-topic strength across all quizzes/exams, with a
            one-tap drill on the weakest topics (no upload needed). */}
        {mastery.length>0 && (
          <div style={{background:"var(--color-background-primary)",border:"0.5px solid var(--color-border-tertiary)",borderRadius:14,padding:"14px 16px",marginBottom:18}}>
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:12}}>
              <span style={{flexShrink:0,display:"flex",color:"var(--color-accent)"}}><Icon name="chart" size={21}/></span>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontWeight:700,fontSize:14,color:"var(--color-text-primary)"}}>{t.masteryTitle}</div>
                <div style={{fontSize:11.5,marginTop:1,color:"var(--color-text-secondary)"}}>{t.masterySub}</div>
              </div>
            </div>
            {mastery.slice(0,4).map((tp,i)=>{
              const col = tp.mastery>=70?"#16a34a":tp.mastery>=40?"#f59e0b":"#dc2626";
              return (
                <div key={i} style={{marginBottom:9}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",fontSize:12,marginBottom:3,gap:8}}>
                    <span style={{color:"var(--color-text-primary)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{tp.topic}</span>
                    <span style={{fontWeight:700,color:col,flexShrink:0}}>{tp.mastery}%</span>
                  </div>
                  <div style={{height:6,borderRadius:6,background:"var(--color-background-secondary)",overflow:"hidden"}}>
                    <div style={{height:"100%",width:tp.mastery+"%",background:col,borderRadius:6,transition:"width 0.3s"}}/>
                  </div>
                </div>
              );
            })}
            {mastery.some(t=>t.weak) && <button onClick={drillWeakSpots} style={{...Sb.btnPrimary,width:"100%",marginTop:6,fontSize:13,display:"inline-flex",alignItems:"center",justifyContent:"center",gap:7}}><Icon name="target" size={15}/>{t.drillWeak}</button>}
          </div>
        )}
        {/* Phase 3: study library, a memory of everything uploaded (summaries
            only), with a one-tap cumulative "quiz me on everything" review. */}
        {librarySize(srs.library)>0 && (
          <div style={{background:"var(--color-background-primary)",border:"0.5px solid var(--color-border-tertiary)",borderRadius:14,padding:"14px 16px",marginBottom:18}}>
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:12}}>
              <span style={{flexShrink:0,display:"flex",color:"var(--color-accent)"}}><Icon name="layers" size={21}/></span>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontWeight:700,fontSize:14,color:"var(--color-text-primary)"}}>{t.libraryTitle}</div>
                <div style={{fontSize:11.5,marginTop:1,color:"var(--color-text-secondary)"}}>{t.librarySets.replace("{n}",librarySize(srs.library)).replace("{s}",librarySize(srs.library)>1?"s":"")}</div>
              </div>
            </div>
            <div style={{marginBottom:10}}>
              {srs.library.docs.slice(0,5).map((d)=>(
                <div key={d.id} style={{display:"flex",alignItems:"center",gap:8,padding:"7px 0",borderTop:"0.5px solid var(--color-border-tertiary)"}}>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:12.5,color:"var(--color-text-primary)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{d.title}</div>
                    {d.subject&&<div style={{fontSize:11,color:"var(--color-text-tertiary)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{d.subject}</div>}
                  </div>
                  <button onClick={()=>srs.removeLibraryDoc(d.id)} style={{flexShrink:0,background:"none",border:"none",color:"var(--color-text-tertiary)",fontSize:11,cursor:"pointer",fontFamily:"inherit",textDecoration:"underline",textUnderlineOffset:2}}>{t.libraryRemove}</button>
                </div>
              ))}
              {librarySize(srs.library)>5 && <div style={{fontSize:11,color:"var(--color-text-tertiary)",paddingTop:7,borderTop:"0.5px solid var(--color-border-tertiary)"}}>{t.libraryMore.replace("{n}",librarySize(srs.library)-5)}</div>}
            </div>
            <button onClick={reviewLibrary} style={{...Sb.btnPrimary,width:"100%",marginTop:2,fontSize:13,display:"inline-flex",alignItems:"center",justifyContent:"center",gap:7}}><Icon name="layers" size={15}/>{t.libraryReview}</button>
          </div>
        )}
        {/* #8: challenge activity, who took the quizzes this user shared, and
            whether they beat the sender's score, to keep the rivalry going. */}
        {challenges.length>0 && (
          <div style={{background:"var(--color-background-primary)",border:"0.5px solid var(--color-border-tertiary)",borderRadius:14,padding:"14px 16px",marginBottom:18}}>
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:12}}>
              <span style={{flexShrink:0,display:"flex",color:"var(--color-accent)"}}><Icon name="trophy" size={21}/></span>
              <div style={{fontWeight:700,fontSize:14,color:"var(--color-text-primary)"}}>{t.challengeActivity}</div>
            </div>
            {challenges.slice(0,4).map((c)=>{
              const oPct = (c.ownerTotal>0) ? c.ownerScore/c.ownerTotal : null;
              return (
                <div key={c.id} style={{padding:"8px 0",borderTop:"0.5px solid var(--color-border-tertiary)"}}>
                  <div style={{display:"flex",justifyContent:"space-between",gap:8,marginBottom:4}}>
                    <span style={{fontSize:12.5,fontWeight:700,color:"var(--color-text-primary)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{c.title}</span>
                    <span style={{flexShrink:0,fontSize:11,color:"var(--color-text-tertiary)"}}>{c.takerCount}{c.ownerTotal>0?` · ${t.challengeYou} ${c.ownerScore}/${c.ownerTotal}`:""}</span>
                  </div>
                  {c.takers.slice(0,3).map((tk,j)=>{
                    const tPct = (tk.total>0) ? tk.score/tk.total : 0;
                    const beat = oPct!=null ? tPct>oPct : null;
                    return (
                      <div key={j} style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:8,padding:"2px 0"}}>
                        <span style={{fontSize:12,color:"var(--color-text-secondary)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{tk.name} · {tk.score}/{tk.total}</span>
                        {beat!=null && <span style={{flexShrink:0,fontSize:10,fontWeight:700,padding:"1px 7px",borderRadius:999,color:beat?"#b91c1c":"#15803d",background:beat?"#fef2f2":"#f0fdf4",border:`0.5px solid ${beat?"#fca5a5":"#86efac"}`}}>{beat?t.challengeBeat:t.challengeAhead}</span>}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        )}
        {/* AI Study Coach, day-by-day exam plan */}
        {!homePlan ? (
          <div style={{background:"var(--color-background-primary)",border:"0.5px solid var(--color-border-tertiary)",borderRadius:14,padding:"14px 16px",marginBottom:18}}>
            <div style={{display:"flex",alignItems:"center",gap:12}}>
              <span style={{flexShrink:0,display:"flex",color:"var(--color-accent)"}}><Icon name="compass" size={23}/></span>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontWeight:700,fontSize:14,color:"var(--color-text-primary)"}}>{t.coachTitle}</div>
                <div style={{fontSize:11.5,marginTop:2,lineHeight:1.4,color:"var(--color-text-secondary)"}}>{t.coachTagline}</div>
              </div>
              <button onClick={openPlanSetup} style={{flexShrink:0,background:"#4338ca",color:"#fff",border:"none",borderRadius:10,padding:"9px 14px",fontSize:12.5,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>{t.coachCreate}</button>
            </div>
          </div>
        ) : (()=>{
          const prog = planProgress(homePlan);
          const complete = isPlanComplete(homePlan);
          const nd = nextDayIndex(homePlan);
          const day = nd>=0 ? homePlan.days[nd] : null;
          const due = !!day && day.date === new Date().toLocaleDateString("en-CA");
          const dte = Math.max(0, Math.ceil((new Date(homePlan.testDate+"T00:00:00").getTime() - Date.now())/86400000));
          const countdown = dte===0 ? t.coachExamToday : t.coachExamIn.replace("{n}",dte).replace("{s}",dte===1?"":"s");
          return (
            <div style={{background:due?"linear-gradient(135deg,#4338ca,#6366f1)":"var(--color-background-primary)",border:due?"none":"0.5px solid var(--color-border-tertiary)",borderRadius:14,padding:"14px 16px",marginBottom:18,boxShadow:due?"0 4px 16px rgba(67,56,202,0.3)":"none"}}>
              <div style={{display:"flex",alignItems:"center",gap:12}}>
                <span style={{flexShrink:0,display:"flex",color:due?"#fff":"var(--color-accent)"}}><Icon name="compass" size={23}/></span>
                <div style={{flex:1,minWidth:0,cursor:"pointer"}} onClick={()=>{setActivePlanId(homePlan.id);setConfirmDelPlan(false);setScreen("plan");}}>
                  <div style={{fontWeight:700,fontSize:14,color:due?"#fff":"var(--color-text-primary)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{homePlan.title}</div>
                  <div style={{fontSize:11.5,marginTop:2,lineHeight:1.4,color:due?"rgba(255,255,255,0.85)":"var(--color-text-secondary)"}}>
                    {complete ? t.coachAllDone : `${t.coachProgressLbl.replace("{done}",prog.done).replace("{total}",prog.total)} · ${countdown}`}
                  </div>
                </div>
                {complete
                  ? <button onClick={()=>{setActivePlanId(homePlan.id);setScreen("plan");}} style={{flexShrink:0,background:"var(--color-background-secondary)",color:"var(--color-text-primary)",border:"0.5px solid var(--color-border-secondary)",borderRadius:10,padding:"9px 14px",fontSize:12.5,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>{t.coachViewPlan}</button>
                  : <button onClick={()=>startPlanDay(homePlan, nd)} style={{flexShrink:0,background:due?"#fff":"#4338ca",color:due?"#4338ca":"#fff",border:"none",borderRadius:10,padding:"9px 14px",fontSize:12.5,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>{due?t.coachStart:t.coachContinue}</button>}
              </div>
              {!complete && day && (
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:10,marginTop:12,paddingTop:12,borderTop:due?"0.5px solid rgba(255,255,255,0.2)":"0.5px solid var(--color-border-tertiary)"}}>
                  <span style={{fontSize:12,fontWeight:600,color:due?"rgba(255,255,255,0.9)":"var(--color-text-secondary)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",display:"inline-flex",alignItems:"center",gap:6}}><Icon name="notes" size={13} style={{flexShrink:0}}/>{day.label}</span>
                  <span style={{flexShrink:0,fontSize:10,fontWeight:700,letterSpacing:0.3,background:due?"rgba(255,255,255,0.2)":"var(--color-sel-tint)",color:due?"#fff":"var(--color-accent)",borderRadius:8,padding:"3px 8px"}}>{day.format==="exam"?t.coachExamFormat:(t.quizTypes?.[day.format]||day.format)}</span>
                </div>
              )}
            </div>
          );
        })()}
        <p style={Sb.secLabel}>{t.whatUpload}</p>
        <div className="rv-feat-grid" style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:20}}>
          {[...t.features.filter(([icon])=>icon!=="🔗"), t.langFeature].map(([,title,sub],i)=>(
            <div key={i} style={Sb.fCard}>
              <span style={{width:34,height:34,borderRadius:9,background:"var(--color-sel-tint)",color:"var(--color-accent)",display:"flex",alignItems:"center",justifyContent:"center",marginBottom:2}}><Icon name={FEAT_ICONS[i]||"notes"} size={19}/></span>
              <span style={{fontSize:13,fontWeight:600,color:"var(--color-text-primary)"}}>{title}</span>
              <span style={{fontSize:11,color:"var(--color-text-secondary)",lineHeight:1.4}}>{sub}</span>
            </div>
          ))}
        </div>

        <div className="rv-plans-row" style={{display:"flex",gap:10,marginBottom:18}}>
          {/* Free card only shown to free users, hidden once Pro. */}
          {!isPro && (
            <div style={Sb.planCard}>
              <div style={{fontWeight:700,fontSize:14,marginBottom:4}}>{t.freeLabel}</div>
              <div style={{fontSize:11,color:"var(--color-text-secondary)",lineHeight:1.7}}>{t.freeDesc}</div>
              <button style={{...Sb.btnPrimary,width:"100%",marginTop:10,fontSize:13}} onClick={()=>setScreen("upload")}>{t.startFree}</button>
            </div>
          )}
          <div style={{...Sb.planCard,border:"2px solid #f59e0b",background:"#fffbeb",position:"relative",overflow:"hidden"}}>
            <div style={{position:"absolute",top:0,left:0,right:0,height:3,background:"linear-gradient(90deg,#f59e0b,#fbbf24)"}}/>
            <div style={{fontWeight:700,fontSize:14,marginBottom:2,color:"#92400e",display:"inline-flex",alignItems:"center",gap:5}}><Icon name="spark" size={13}/>{t.proLabel}</div>
            <div style={{fontSize:13,color:"#b45309",fontWeight:700,marginBottom:4}}>{t.proPrice}</div>
            <div style={{fontSize:11,color:"#78350f",lineHeight:1.7}}>{t.proDesc}</div>
            {isPro ? (
              <>
                <div style={{width:"100%",marginTop:10,fontSize:13,fontWeight:700,color:"#fff",textAlign:"center",padding:"10px",borderRadius:10,background:"linear-gradient(135deg,#16a34a,#15803d)",boxShadow:"0 2px 10px rgba(22,163,74,0.3)"}}>{t.youArePro}</div>
                <button style={{...Sb.btnPrimary,width:"100%",marginTop:8,fontSize:13,background:"#f59e0b",color:"#fff"}} onClick={()=>setScreen("upload")}>{t.makeQuiz}</button>
              </>
            ) : (
              <button style={{...Sb.btnPrimary,width:"100%",marginTop:10,fontSize:13,background:"#f59e0b",color:"#fff"}} onClick={()=>{if(requireLogin())return;setCoErr("");setShowProModal(true);}}>{t.upgrade}</button>
            )}
          </div>
        </div>
      </div>
      {showProModal && <ProModal onClose={()=>{setShowProModal(false);setCoErr("");}} t={t} onMonthly={()=>doCheckout(STRIPE_MONTHLY_PRICE,"monthly")} onYearly={()=>doCheckout(STRIPE_YEARLY_PRICE,"yearly")} busy={coBusy} error={coErr}/>}
      {showSettings && <SettingsPanel draft={settingsDraft} update={updateDraft} onApply={applySettings} onCancel={cancelSettings} onSignOut={()=>signOut()} onDeleteAccount={confirmDeleteAccount} requiresPassword={requiresPassword} onReauthenticate={reauthenticate} isPro={isPro} onManageSubscription={openPortal} signedIn={!!user} t={t}/>}
      <ResumeModal info={examResume} onResume={resumeExam} onDiscard={discardResume} fmtClock={fmtClock}/>
    </div>
  );

  // ── UPLOAD ───────────────────────────────────────────────────────
  if (screen==="upload") return (
    <div style={Sb.root}><style>{CSS}</style>
      <AdBanners isPro={isPro}/>
      {upgraded && <div style={{position:"fixed",top:0,left:0,right:0,zIndex:800,background:"#16a34a",color:"#fff",textAlign:"center",padding:"11px 14px",fontSize:14,fontWeight:700,fontFamily:"inherit",boxShadow:"0 2px 12px rgba(0,0,0,0.25)"}}>{t.welcomePro}</div>}
      <div style={Sb.topbar} className="rv-topbar">
        <button style={Sb.backBtn} onClick={()=>setScreen("home")}>← {t.homeWord}</button>
        <span style={Sb.brand}>{t.appName}</span>
        <div style={{display:"flex",alignItems:"center",gap:6}}>
          {isPro && <span style={{fontSize:10,background:"#f59e0b",color:"#fff",borderRadius:8,padding:"2px 7px",fontWeight:700}}>PRO</span>}
          <button onClick={()=>setSoundOn(s=>!s)} title={soundOn?t.soundOn:t.soundOff} style={{background:"none",border:"none",cursor:"pointer",padding:"2px 4px",display:"flex",alignItems:"center",color:"var(--color-text-secondary)",opacity:soundOn?1:0.4}}><Icon name="volume" size={17}/></button>
          <ThemeSwitch isDark={isDarkTheme} onToggle={toggleTheme} />
          <button onClick={()=>openSettings()} title={t.set.title} style={{background:"none",border:"none",cursor:"pointer",padding:"2px 4px",display:"flex",alignItems:"center",color:"var(--color-text-secondary)"}}><Icon name="gear" size={17}/></button>
        </div>
      </div>
      <div className="rv-upload-body" style={{padding:"18px 16px 32px"}}>
        <div className="rv-ul-left">
        {planSession && (
          <div style={{display:"flex",alignItems:"center",gap:10,background:"linear-gradient(135deg,#4338ca,#6366f1)",borderRadius:12,padding:"11px 14px",marginBottom:14,color:"#fff"}}>
            <span style={{flexShrink:0,display:"flex"}}><Icon name="compass" size={19}/></span>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontSize:12.5,fontWeight:700,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{t.coachSessionBanner} · {planSession.label}</div>
              <div style={{fontSize:11,opacity:0.85,marginTop:1}}>{t.quizTypes?.[planSession.format]||planSession.format} · {planSession.numQ} Qs</div>
            </div>
            <button onClick={backToPlan} style={{flexShrink:0,background:"rgba(255,255,255,0.2)",color:"#fff",border:"none",borderRadius:8,padding:"6px 10px",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>{t.coachBackToPlan}</button>
          </div>
        )}
        <h2 style={Sb.h2}>{t.uploadTitle}</h2>
        <div style={{display:"flex",gap:5,marginBottom:16}}>
          {[["file",t.tabs[0]],["text",t.tabs[1]],["photo",t.tabs[3]],["media",t.mediaTab]].map(([id,lb])=> <button key={id} onClick={()=>setTab(id)} style={{flex:1,position:"relative",padding:"8px 4px",borderRadius:8,border:"0.5px solid",borderColor:tab===id?"#4338ca":"var(--color-border-secondary)",background:tab===id?"#4338ca":"var(--color-background-primary)",color:tab===id?"#fff":"var(--color-text-secondary)",fontSize:11,cursor:"pointer",fontFamily:"inherit",fontWeight:500,transition:"all 0.15s",display:"inline-flex",alignItems:"center",justifyContent:"center",gap:6}}><Icon name={TAB_ICONS[id]} size={15}/>{stripEmoji(lb)}{id==="media"&&!isPro&&<span style={{position:"absolute",top:-6,right:-4,background:"#f59e0b",color:"#fff",fontSize:8,borderRadius:8,padding:"1px 5px",fontWeight:800,letterSpacing:0.3,lineHeight:1.4,pointerEvents:"none"}}>PRO</span>}</button>)}
        </div>
        {tab==="file" && (
          <div style={{...Sb.dropzone,position:"relative",...(drag?{borderColor:"#4338ca",background:"var(--color-sel-tint)"}:{}),...(file?{borderStyle:"solid",borderColor:"#4338ca"}:{})}}
            onDragOver={e=>{e.preventDefault();setDrag(true);}} onDragLeave={()=>setDrag(false)}
            onDrop={e=>{e.preventDefault();setDrag(false);loadFile(e.dataTransfer.files[0]);}}
            onClick={()=>file?openFile(file):fileRef.current.click()}>
            <input ref={fileRef} type="file" accept=".pdf,.txt,.md,.csv,image/*" style={{display:"none"}} onChange={e=>loadFile(e.target.files[0])}/>
            {file&&<button onClick={e=>{e.stopPropagation();setFile(null);}} title={t.tapToRemove} aria-label={t.tapToRemove} style={{position:"absolute",top:8,right:8,width:24,height:24,borderRadius:"50%",background:"#ef4444",color:"#fff",border:"none",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",fontSize:13,lineHeight:1,fontFamily:"inherit",zIndex:2}}>✕</button>}
            {file?(<><div style={{color:"var(--color-accent)",marginBottom:2}}><Icon name={file.type==="image"?"camera":"notes"} size={30} stroke={1.5}/></div><div style={{fontWeight:600,fontSize:14,color:"var(--color-text-primary)"}}>{file.name}</div><div style={{fontSize:11,color:"var(--color-text-tertiary)"}}>{fmtMB(file.sizeMB*1024*1024)} · {t.tapOpen}</div></>):(<><div style={{color:"var(--color-accent)",marginBottom:2}}><Icon name="folder" size={32} stroke={1.5}/></div><div style={{fontSize:14,fontWeight:600,color:"var(--color-text-primary)"}}>{t.dropTitle}</div><div style={{fontSize:12,color:"var(--color-text-secondary)"}}>{t.dropSub}</div><div style={{fontSize:11,color:"var(--color-text-tertiary)",marginTop:2}}>{isPro?t.unlimited:t.maxFileFree.replace("{n}",fileLimitMB())}</div></>)}
          </div>
        )}
        {tab==="file" && !isPro && (
          unlocks.isUnlocked("filesize")
            ? <div style={{fontSize:11,color:"var(--color-text-success)",marginTop:8,fontWeight:600,display:"flex",alignItems:"center",gap:5}}><Icon name="check" size={13}/>{AD_FILE_MB}MB uploads unlocked · {unlocks.remainingLabel("filesize")} left</div>
            : <button onClick={()=>setUnlockFeature("filesize")} style={{fontSize:11,color:"#f59e0b",background:"none",border:"none",cursor:"pointer",fontFamily:"inherit",padding:"6px 0 0",textAlign:"left",display:"block"}}>
                {unlocks.canUnlock("filesize") ? t.adWatchFile.replace("{n}",AD_FILE_MB) : t.adFileUsed.replace("{n}",AD_FILE_MB)}
              </button>
        )}
        {tab==="photo" && (
          <div style={{...Sb.dropzone,position:"relative",...(file&&file.type==="image"?{borderStyle:"solid",borderColor:"#4338ca"}:{})}} onClick={()=>(file&&file.type==="image")?openFile(file):photoRef.current.click()}>
            <input ref={photoRef} type="file" accept="image/*" capture="environment" style={{display:"none"}} onChange={e=>loadFile(e.target.files[0])}/>
            {file&&file.type==="image"&&<button onClick={e=>{e.stopPropagation();setFile(null);}} title={t.tapToRemove} aria-label={t.tapToRemove} style={{position:"absolute",top:8,right:8,width:24,height:24,borderRadius:"50%",background:"#ef4444",color:"#fff",border:"none",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",fontSize:13,lineHeight:1,fontFamily:"inherit",zIndex:2}}>✕</button>}
            {file&&file.type==="image"?(<><div style={{color:"var(--color-accent)",marginBottom:2}}><Icon name="camera" size={30} stroke={1.5}/></div><div style={{fontWeight:600,fontSize:14,color:"var(--color-text-primary)"}}>{file.name}</div><div style={{fontSize:11,color:"var(--color-text-tertiary)"}}>{t.tapOpen}</div></>):(<><div style={{color:"var(--color-accent)",marginBottom:4}}><Icon name="camera" size={38} stroke={1.4}/></div><div style={{fontSize:14,fontWeight:600,color:"var(--color-text-primary)"}}>{t.photoTitle}</div><div style={{fontSize:12,color:"var(--color-text-secondary)"}}>{t.photoHint}</div></>)}
          </div>
        )}
        {tab==="text" && <><textarea value={textVal} onChange={e=>setTextVal(e.target.value)} placeholder={t.pasteHint} style={Sb.textarea}/>
          <button onClick={()=>{setQuizletErr("");setShowQuizlet(true);}} style={{marginTop:8,background:"none",border:"none",color:"var(--color-accent)",fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit",padding:0,display:"inline-flex",alignItems:"center",gap:5}}><Icon name="upload" size={13}/>{t.qzImportLink}</button></>}
        {tab==="media" && (isPro ? (
          <div style={{...Sb.dropzone,position:"relative",...(mediaFile?{borderStyle:"solid",borderColor:"#4338ca"}:{})}} onClick={()=>mediaFile?openFile(mediaFile):mediaRef.current.click()}>
            <input ref={mediaRef} type="file" accept="audio/*,video/*" style={{display:"none"}} onChange={e=>loadMedia(e.target.files[0])}/>
            {mediaFile&&<button onClick={e=>{e.stopPropagation();setMediaFile(null);}} title={t.tapToRemove} aria-label={t.tapToRemove} style={{position:"absolute",top:8,right:8,width:24,height:24,borderRadius:"50%",background:"#ef4444",color:"#fff",border:"none",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",fontSize:13,lineHeight:1,fontFamily:"inherit",zIndex:2}}>✕</button>}
            {mediaFile?(<><div style={{color:"var(--color-accent)",marginBottom:2}}><Icon name="play" size={30} stroke={1.5}/></div><div style={{fontWeight:600,fontSize:14,color:"var(--color-text-primary)",wordBreak:"break-word"}}>{mediaFile.name}</div><div style={{fontSize:11,color:"var(--color-text-tertiary)"}}>{fmtMB(mediaFile.sizeMB*1024*1024)} · {t.tapOpen}</div></>):(<><div style={{color:"var(--color-accent)",marginBottom:4}}><Icon name="play" size={36} stroke={1.4}/></div><div style={{fontSize:14,fontWeight:600,color:"var(--color-text-primary)"}}>{t.mediaTitle}</div><div style={{fontSize:12,color:"var(--color-text-secondary)"}}>{t.mediaHint}</div><div style={{fontSize:11,color:"var(--color-text-tertiary)",marginTop:2}}>{t.mediaSizeHint.replace("{max}",MEDIA_MAX_MB)}</div></>)}
          </div>
        ) : (
          <div style={{...Sb.dropzone,cursor:"pointer"}} onClick={()=>setShowProModal(true)}>
            <div style={{color:"var(--color-accent)",marginBottom:6}}><Icon name="play" size={34} stroke={1.4}/></div>
            <div style={{fontSize:14,fontWeight:600,color:"var(--color-text-primary)"}}>{t.mediaTitle}</div>
            <div style={{fontSize:12,color:"var(--color-text-secondary)",marginTop:2}}>{t.mediaProOnly}</div>
          </div>
        ))}
        {/* Pro: attach more files beyond the primary (the "+" the founder asked
            for). Appears once a primary is picked, on the upload tabs. Free users
            never see this, their quiz stays single-file. */}
        {isPro && (file||mediaFile) && (tab==="file"||tab==="photo"||tab==="media") && (
          <div style={{marginTop:12}}>
            <input ref={extraRef} type="file" accept=".pdf,.txt,.md,.csv,image/*,audio/*,video/*" style={{display:"none"}} onChange={e=>{addExtraFile(e.target.files[0]); e.target.value="";}}/>
            {extraFiles.map((ex,i)=>(
              <div key={i} style={{display:"flex",alignItems:"center",gap:8,background:"var(--color-sel-tint)",border:"1px solid #c7d2fe",borderRadius:9,padding:"8px 11px",marginBottom:6}}>
                <Icon name={ex.kind==="media"?"play":ex.type==="pdf"?"notes":ex.type==="image"?"camera":"pencil"} size={15} style={{color:"var(--color-accent)",flexShrink:0}}/>
                <span style={{flex:1,minWidth:0,fontSize:12,color:"var(--color-text-primary)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{ex.name}</span>
                <button onClick={()=>setExtraFiles(prev=>prev.filter((_,j)=>j!==i))} style={{flexShrink:0,background:"none",border:"none",color:"var(--color-text-tertiary)",cursor:"pointer",fontFamily:"inherit",fontSize:15,lineHeight:1,padding:0}}>✕</button>
              </div>
            ))}
            {extraFiles.length < QUIZ_FILES_PRO-1 && (
              <button onClick={()=>extraRef.current.click()} style={{width:"100%",background:"var(--color-background-primary)",border:"1.5px dashed var(--color-border-secondary)",borderRadius:9,padding:"9px",fontSize:12,fontWeight:600,color:"var(--color-accent)",cursor:"pointer",fontFamily:"inherit",display:"inline-flex",alignItems:"center",justifyContent:"center",gap:6}}>
                <Icon name="paperclip" size={14}/>{t.addAnotherFile}
              </button>
            )}
          </div>
        )}
        {error && <div style={{background:"#fef2f2",border:"0.5px solid #fecaca",borderRadius:10,padding:"10px 14px",fontSize:13,color:"#b91c1c",marginBottom:14,lineHeight:1.5,display:"flex",alignItems:"flex-start",gap:7}}><Icon name="alert" size={15} style={{flexShrink:0,marginTop:1}}/><span>{error}</span></div>}
        {limitHit && <button onClick={()=>setShowPacks(true)} style={{...Sb.btnPrimary,width:"100%",marginBottom:14,background:"#4338ca",display:"inline-flex",alignItems:"center",justifyContent:"center",gap:7}}><Icon name="gem" size={16}/>{t.getMoreQuestions}</button>}
        </div>
        <div className="rv-ul-right">
        <div style={Sb.settingsBox}>
          <div style={Sb.settingRow}>
            <span style={Sb.settingLabel}>{t.quizType}</span>
            <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
              {QUIZ_TYPES.map(type=>{
                const feat = QTYPE_FEATURE[type];
                const unlocked = canUseQType(type);
                const active = !isPro && feat && unlocks.isUnlocked(feat); // ad-unlocked window
                const adLockable = !isPro && feat && !unlocked;            // free, locked, ad-unlockable
                return (
                  <div key={type} style={{position:"relative"}}>
                    <Chip small hideBadge label={t.quizTypes[type]} active={qType===type} locked={!unlocked}
                      onClick={()=>{ if(unlocked) setQType(type); else setUnlockFeature(feat); }}/>
                    {adLockable&&<span style={{position:"absolute",top:-6,right:-4,background:"#7c3aed",color:"#fff",fontSize:8,borderRadius:8,padding:"1px 5px",fontWeight:800,letterSpacing:0.3,lineHeight:1.4,pointerEvents:"none"}}>{t.badgeAd}</span>}
                    {active&&<span style={{position:"absolute",top:-6,right:-4,background:"#16a34a",color:"#fff",fontSize:8,borderRadius:8,padding:"1px 4px",fontWeight:700,lineHeight:1.4,pointerEvents:"none"}}>{unlocks.remainingLabel(feat)}</span>}
                  </div>
                );
              })}
            </div>
          </div>
          <div style={{...Sb.settingRow,flexDirection:"column",alignItems:"flex-start",gap:8}}>
            <div style={{display:"flex",justifyContent:"space-between",width:"100%",alignItems:"center"}}>
              <span style={Sb.settingLabel}>{t.questions}</span>
              <span style={{fontWeight:700,fontSize:14,color:"var(--color-accent)",minWidth:32,textAlign:"right"}}>{Math.min(numQ,qCap())}</span>
            </div>
            {/* Pro/unlocked: step the slider by 1 and reveal a type-in box. */}
            {canCustomQ()&&(
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",width:"100%"}}>
                <span style={{fontSize:12,color:"var(--color-text-secondary)"}}>{t.customAmount}</span>
                <Toggle on={useCustomQ} onChange={v=>{setUseCustomQ(v); if(v) setCustomQ(String(Math.min(numQ,qCap())));}}/>
              </div>
            )}
            <div style={{width:"100%",paddingRight:2}}>
              <div style={{display:"flex",gap:10,alignItems:"center"}}>
                <input type="range"
                  min={useCustomQ&&canCustomQ()?1:5} max={qCap()} step={useCustomQ&&canCustomQ()?1:5}
                  value={Math.min(numQ,qCap())}
                  onChange={e=>{const v=parseInt(e.target.value);setImportCount(null);setNumQ(v);setCustomQ(String(v));if(!canCustomQ())setUseCustomQ(false);}}
                  style={{flex:1,accentColor:"#4338ca",cursor:"pointer"}}
                />
                {useCustomQ&&canCustomQ()&&(
                  <input type="number" min={1} max={qCap()} inputMode="numeric" value={customQ}
                    onChange={e=>{const s=e.target.value.replace(/[^0-9]/g,"").slice(0,3);setImportCount(null);setCustomQ(s);const n=parseInt(s,10);if(!isNaN(n))setNumQ(Math.min(Math.max(n,1),qCap()));}}
                    onBlur={e=>{const n=Math.min(Math.max(parseInt(e.target.value,10)||1,1),qCap());setCustomQ(String(n));setNumQ(n);}}
                    style={{width:58,borderRadius:8,border:"1.5px solid var(--color-border-secondary)",background:"var(--color-background-primary)",color:"var(--color-text-primary)",fontSize:14,padding:"8px 6px",fontFamily:"inherit",outline:"none",boxSizing:"border-box",textAlign:"center"}}/>
                )}
              </div>
              <div style={{display:"flex",justifyContent:"space-between",fontSize:10,color:"var(--color-text-tertiary)",marginTop:2}}>
                <span>{useCustomQ&&canCustomQ()?1:5}</span>
                <span style={{color:(!isPro&&!unlocks.isUnlocked("questions"))?"#f59e0b":"var(--color-text-tertiary)"}}>
                  {qCap()}{!isPro&&!unlocks.isUnlocked("questions")?" "+t.freeMax:""}{!isPro&&unlocks.isUnlocked("questions")?` · ${unlocks.remainingLabel("questions")}`:""}
                </span>
              </div>
              {useCustomQ&&canCustomQ()&&<div style={{fontSize:10,color:"var(--color-text-tertiary)",marginTop:3}}>{t.customAmountHint}</div>}
            </div>
            {!isPro&&!unlocks.isUnlocked("questions")&&(
              <button onClick={()=>setUnlockFeature("questions")} style={{fontSize:11,color:"#f59e0b",background:"none",border:"none",cursor:"pointer",fontFamily:"inherit",padding:0,textAlign:"left"}}>
                {unlocks.canUnlock("questions") ? t.adWatchQ.replace("{n}",AD_MAX_Q) : t.adQUsed.replace("{n}",AD_MAX_Q)}
              </button>
            )}
          </div>
          <div style={Sb.settingRow}>
            <span style={Sb.settingLabel}>{t.difficulty}</span>
            <div style={{display:"flex",gap:5}}>
              {t.diffOpts.map((d,i)=><Chip key={d} small label={d} active={diff===i} rec={diffRec.confidence>=0.6 && diffRec.diff===i} onClick={()=>pickDiff(i)}/>)}
            </div>
          </div>
          {t.diffDesc?.[diff] && <div style={{fontSize:11,color:"var(--color-text-tertiary)",lineHeight:1.45,padding:"2px 2px 0",textAlign:"right"}}>{t.diffDesc[diff]}</div>}
          {/* Adaptive difficulty (Phase 1): once there's enough history, show the
              level the student model recommends and why. When the picker isn't
              already on it (learner overrode), offer a one-tap switch. */}
          {diffRec.confidence>=0.6 && (
            <div style={{display:"flex",alignItems:"center",gap:8,marginTop:9,background:"var(--color-sel-tint)",border:"1px solid #c7d2fe",borderRadius:10,padding:"8px 11px"}}>
              <Icon name="target" size={15} style={{color:"var(--color-accent)",flexShrink:0}}/>
              <span style={{flex:1,fontSize:11.5,color:"var(--color-accent)",lineHeight:1.4}}>
                <strong>{t.recForYou}: {t.diffOpts[diffRec.diff]}</strong>{" · "}
                {diffRec.reason==="up"?t.diffWhyUp:diffRec.reason==="down"?t.diffWhyDown:t.diffWhyHold}
              </span>
              {diffRec.diff!==diff && (
                <button onClick={()=>pickDiff(diffRec.diff)} style={{flexShrink:0,background:"#4338ca",color:"#fff",border:"none",borderRadius:8,padding:"6px 11px",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>{t.useThis}</button>
              )}
            </div>
          )}
        </div>
        {/* Usage strip, questions remaining today (server-tracked). */}
        <div style={{background:isPro?"var(--color-background-secondary)":"#fffbeb",border:isPro?"0.5px solid var(--color-border-tertiary)":"1px solid #f59e0b44",borderRadius:10,padding:"10px 14px",fontSize:12,color:isPro?"var(--color-text-secondary)":"#92400e",marginBottom:14}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:8}}>
            <span><strong>{usage?.remaining ?? (isPro?250:50)}</strong> {t.questionsLeftToday} · {usage?.questions_used_today ?? 0}/{usage?.daily_limit ?? (isPro?250:50)} {t.used}{(usage?.bonus_questions_remaining>0)?` · +${usage.bonus_questions_remaining} ${t.bonusWord}`:""} · {t.maxPerQuiz.replace("{n}",isPro?PRO_MAX_Q:FREE_MAX_Q)}</span>
            {!isPro&&<span onClick={()=>setShowProModal(true)} style={{color:"#f59e0b",fontWeight:700,cursor:"pointer",flexShrink:0,fontSize:11,textDecoration:"underline"}}>{t.goPro}</span>}
          </div>
          {!isPro&&(usage?.remaining??99)<=10&&((usage?.max_ad_watches??2)-(usage?.ad_watches_today??0))>0&&
            <button disabled={adBusy} onClick={handleWatchAd} style={{marginTop:8,width:"100%",background:"#f59e0b",color:"#fff",border:"none",borderRadius:8,padding:"9px",fontSize:12,fontWeight:700,cursor:adBusy?"default":"pointer",fontFamily:"inherit",opacity:adBusy?0.6:1}}>
              {adBusy?t.loadingAd:`${t.watchAdForQuestions.replace("{n}",usage?.ad_question_bonus??10)} · ${usage?.ad_watches_today??0}/${usage?.max_ad_watches??2}`}
            </button>}
        </div>
        {isPro&&<button style={{width:"100%",marginBottom:14,background:"#2c2870",color:"#fff",border:"none",borderRadius:12,padding:"14px 20px",fontSize:15,fontWeight:600,cursor:"pointer",fontFamily:"'Fraunces',Georgia,serif",display:"flex",alignItems:"center",justifyContent:"space-between"}} onClick={()=>setScreen("exam_setup")}><span style={{display:"inline-flex",alignItems:"center",gap:8}}><Icon name="cap" size={17}/>{stripEmoji(t.examModeLabel)}</span><span style={{fontSize:10,background:"rgba(255,255,255,0.2)",borderRadius:8,padding:"3px 8px",fontWeight:700}}>{t.badgeUnlimited}</span></button>}
        {!isPro&&(
          <div
            onClick={unlocks.examUsedToday()?undefined:enterExamMode}
            style={{background:"var(--color-sel-tint)",border:"1.5px solid "+(unlocks.examUnlocked()?"#4338ca":"#f59e0b55"),borderRadius:12,padding:"14px 16px",marginBottom:14,display:"flex",alignItems:"center",gap:12,cursor:unlocks.examUsedToday()?"default":"pointer",opacity:unlocks.examUsedToday()?0.65:1}}>
            <span style={{flexShrink:0,display:"flex",color:"var(--color-accent)"}}><Icon name="cap" size={22}/></span>
            <div style={{flex:1}}>
              <div style={{fontWeight:700,fontSize:14,color:"var(--color-text-primary)"}}>{stripEmoji(t.examModeLabel)}</div>
              <div style={{fontSize:11,color:"var(--color-text-secondary)",marginTop:2,lineHeight:1.45}}>
                {examAdBusy?t.loadingAd:unlocks.examUsedToday()?t.examAdUsed:unlocks.examUnlocked()?t.examAdUnlocked:t.examAdWatch}
              </div>
            </div>
            <span style={{fontSize:10,background:unlocks.examUsedToday()?"#94a3b8":unlocks.examUnlocked()?"#4338ca":"#f59e0b",color:"#fff",borderRadius:8,padding:"3px 8px",fontWeight:700,flexShrink:0,whiteSpace:"nowrap"}}>
              {unlocks.examUsedToday()?t.examBadgeUsed:unlocks.examUnlocked()?t.examBadgeReady:t.examBadgeFree}
            </span>
          </div>
        )}
        <div onClick={()=>{ if(requireLogin())return; setMockGenErr(""); setScreen("mock_select"); }}
          style={{background:"#2c2870",borderRadius:12,padding:"14px 16px",marginBottom:14,display:"flex",alignItems:"center",gap:10,cursor:"pointer"}}>
          <span style={{flexShrink:0,display:"flex",color:"#fff"}}><Icon name="cap" size={22}/></span>
          <div style={{flex:1,color:"#fff",minWidth:0}}>
            <div style={{fontWeight:700,fontSize:14}}>{t.mockCardTitle}</div>
            <div style={{fontSize:11,opacity:0.85,marginTop:2,lineHeight:1.45}}>{t.mockCardSub}</div>
          </div>
          {!isPro && <span style={{fontSize:10,background:"#f59e0b",color:"#fff",borderRadius:8,padding:"3px 8px",fontWeight:700,flexShrink:0}}>PRO</span>}
          <span style={{fontSize:18,color:"rgba(255,255,255,0.6)",flexShrink:0}}>›</span>
        </div>
        <button style={{...Sb.btnPrimary,width:"100%"}} onClick={generate}>{t.generate}</button>
        </div>
      </div>
      <UnlockModal feature={unlockFeature} unlocks={unlocks} t={t}
        onClose={()=>setUnlockFeature(null)} onUpgrade={openUpgrade}/>
      {showProModal&&<ProModal onClose={()=>{setShowProModal(false);setCoErr("");}} t={t} onMonthly={()=>doCheckout(STRIPE_MONTHLY_PRICE,"monthly")} onYearly={()=>doCheckout(STRIPE_YEARLY_PRICE,"yearly")} busy={coBusy} error={coErr}/>}
      {showQuizlet && (
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.6)",zIndex:500,display:"flex",alignItems:"flex-end"}} onClick={()=>!quizletBusy&&setShowQuizlet(false)}>
          <div className="slide-up" onClick={e=>e.stopPropagation()} style={{background:"var(--color-background-primary)",borderRadius:"20px 20px 0 0",padding:"24px 20px 32px",width:"100%",maxWidth:520,margin:"0 auto",boxSizing:"border-box",maxHeight:"88vh",overflowY:"auto"}}>
            <div style={{display:"flex",alignItems:"center",gap:9,marginBottom:6}}><Icon name="upload" size={20} style={{color:"var(--color-accent)"}}/><h3 style={{margin:0,fontSize:18,fontWeight:700,fontFamily:"'Fraunces',Georgia,serif",color:"var(--color-text-primary)"}}>{t.qzTitle}</h3></div>
            <p style={{margin:"0 0 12px",fontSize:12.5,color:"var(--color-text-secondary)",lineHeight:1.5}}>{t.qzHow}</p>
            <textarea value={quizletText} onChange={e=>{setQuizletText(e.target.value);setQuizletErr("");}} placeholder={t.qzPaste} style={{...Sb.textarea,minHeight:120}}/>
            <div style={{fontSize:12,color:"var(--color-text-tertiary)",marginTop:6}}>{t.qzFound.replace("{n}",quizletCards.length).replace("{s}",quizletCards.length===1?"":"s")}</div>
            {quizletErr && <div style={{background:"#fef2f2",border:"0.5px solid #fecaca",borderRadius:10,padding:"9px 12px",fontSize:12.5,color:"#b91c1c",marginTop:10,display:"flex",alignItems:"flex-start",gap:7}}><Icon name="alert" size={14} style={{flexShrink:0,marginTop:1}}/><span>{quizletErr}</span></div>}
            <button onClick={importQuizlet} disabled={quizletBusy||!quizletCards.length} style={{...Sb.btnPrimary,width:"100%",marginTop:14,opacity:(quizletBusy||!quizletCards.length)?0.5:1,cursor:(quizletBusy||!quizletCards.length)?"not-allowed":"pointer"}}>{quizletBusy?t.qzImporting:t.qzImportBtn.replace("{n}",quizletCards.length).replace("{s}",quizletCards.length===1?"":"s")}</button>
            <button onClick={()=>!quizletBusy&&setShowQuizlet(false)} style={{width:"100%",marginTop:8,background:"none",border:"none",color:"var(--color-text-tertiary)",fontSize:13,cursor:"pointer",fontFamily:"inherit",padding:"6px"}}>{t.cancel}</button>
          </div>
        </div>
      )}
      {showPacks&&<PacksModal onClose={()=>setShowPacks(false)} buyPack={buyPack} t={t}/>}
      {showSettings&&<SettingsPanel draft={settingsDraft} update={updateDraft} onApply={applySettings} onCancel={cancelSettings} onSignOut={()=>signOut()} onDeleteAccount={confirmDeleteAccount} requiresPassword={requiresPassword} onReauthenticate={reauthenticate} isPro={isPro} onManageSubscription={openPortal} signedIn={!!user} t={t}/>}
    </div>
  );

  // ── LOADING ──────────────────────────────────────────────────────
  if (screen==="loading") return (
    <div style={{...Sb.root,alignItems:"center",justifyContent:"center",padding:"0 24px",textAlign:"center",minHeight:"100vh",display:"flex",flexDirection:"column"}}><style>{CSS}</style>
      <div className="spin-ring" style={{width:52,height:52,borderRadius:"50%",border:"4px solid var(--color-border-tertiary)",borderTopColor:"#4338ca"}}/>
      <h2 style={{...Sb.h2,textAlign:"center",marginTop:28}}>{mediaStatus || t.generating}</h2>
      <div style={{display:"flex",flexDirection:"column",gap:12,marginTop:24,alignItems:"flex-start"}}>
        {t.genSteps.map((s,i)=>(
          <div key={i} className={`step step-${i}`} style={{display:"flex",alignItems:"center",gap:10,fontSize:13,color:"var(--color-text-secondary)",opacity:0}}>
            <span style={{width:8,height:8,borderRadius:"50%",background:"#4338ca",flexShrink:0,display:"block"}}/>
            {s}
          </div>
        ))}
      </div>
      <p style={{marginTop:28,maxWidth:300,fontSize:12,lineHeight:1.55,color:"var(--color-text-tertiary)",display:"flex",alignItems:"flex-start",gap:7,textAlign:"left"}}>
        <Icon name="clock" size={14} style={{flexShrink:0,marginTop:1}}/><span>{t.genNotice || "Bigger files or a high question count can make generation take a little longer, hang tight."}</span>
      </p>
    </div>
  );

  // ── QUIZ ─────────────────────────────────────────────────────────
  if (screen==="quiz" && quiz) {
    const q=quiz.questions[qIdx], isLast=qIdx+1===quiz.questions.length;
    const instant = settings.feedback==="immediate"; // false = reveal only at end
    if (quiz.type==="match") return (
      <div style={Sb.root}><style>{CSS}</style>
      <AdBanners isPro={isPro}/>
      {upgraded && <div style={{position:"fixed",top:0,left:0,right:0,zIndex:800,background:"#16a34a",color:"#fff",textAlign:"center",padding:"11px 14px",fontSize:14,fontWeight:700,fontFamily:"inherit",boxShadow:"0 2px 12px rgba(0,0,0,0.25)"}}>{t.welcomePro}</div>}
        <div style={Sb.topbar} className="rv-topbar"><button style={Sb.backBtn} onClick={()=>setShowExitConfirm(true)}>{t.exit}</button><span style={{fontSize:12,fontWeight:600,color:"var(--color-text-secondary)"}}>{quiz.title}</span><span/></div>
        <div className="rv-center-narrow" style={{padding:"20px 16px 32px"}}><MatchQuiz questions={quiz.questions} t={t} onDone={(s,total,detail)=>{setAnswers(detail||Array(total).fill(0).map((_,i)=>({isCorrect:i<s})));setScreen("results");}}/></div>
        <ExitModal show={showExitConfirm} onStay={()=>setShowExitConfirm(false)} onLeave={()=>{setShowExitConfirm(false);newMat();}}/>
        <button onClick={openSettings} title={t.set?.title||"Settings"} aria-label={t.set?.title||"Settings"} style={{position:"fixed",left:12,bottom:58,zIndex:400,width:38,height:38,borderRadius:"50%",background:"var(--color-background-secondary)",border:"0.5px solid var(--color-border-secondary)",color:"var(--color-text-secondary)",cursor:"pointer",fontFamily:"inherit",display:"inline-flex",alignItems:"center",justifyContent:"center",boxShadow:"0 2px 10px rgba(0,0,0,0.18)"}}><Icon name="gear" size={17}/></button>
        <button onClick={()=>setShowBugReport(true)} title={t.reportTitle} aria-label={t.reportTitle} style={{position:"fixed",left:12,bottom:12,zIndex:400,width:38,height:38,borderRadius:"50%",background:"var(--color-background-secondary)",border:"0.5px solid var(--color-border-secondary)",color:"var(--color-text-secondary)",cursor:"pointer",fontFamily:"inherit",display:"inline-flex",alignItems:"center",justifyContent:"center",boxShadow:"0 2px 10px rgba(0,0,0,0.18)"}}><Icon name="chat" size={17}/></button>
        {showBugReport && <ContactModal defaultEmail={user?.email||""} onClose={()=>setShowBugReport(false)} t={t}/>}
        {showSettings && <SettingsPanel draft={settingsDraft} update={updateDraft} onApply={applySettings} onCancel={cancelSettings} onSignOut={()=>signOut()} onDeleteAccount={confirmDeleteAccount} requiresPassword={requiresPassword} onReauthenticate={reauthenticate} isPro={isPro} onManageSubscription={openPortal} signedIn={!!user} t={t}/>}
      </div>
    );
    return (
      <div style={Sb.root}><style>{CSS}</style>
      <AdBanners isPro={isPro}/>
      {upgraded && <div style={{position:"fixed",top:0,left:0,right:0,zIndex:800,background:"#16a34a",color:"#fff",textAlign:"center",padding:"11px 14px",fontSize:14,fontWeight:700,fontFamily:"inherit",boxShadow:"0 2px 12px rgba(0,0,0,0.25)"}}>{t.welcomePro}</div>}
        <div style={Sb.topbar} className="rv-topbar">
          <button style={Sb.backBtn} onClick={()=>setShowExitConfirm(true)}>{t.exit}</button>
          <span style={{fontSize:12,fontWeight:600,color:"var(--color-text-secondary)",maxWidth:160,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{quiz.title}</span>
          <span style={{fontSize:12,color:"var(--color-text-secondary)",fontWeight:600}}>{qIdx+1}/{quiz.questions.length}</span>
        </div>
        <PBar v={qIdx} max={quiz.questions.length}/>
        <div className="rv-center-narrow" style={{padding:"20px 16px 32px"}}>
          <div style={{display:"flex",gap:8,marginBottom:14,flexWrap:"wrap"}}>
            <span style={{background:"var(--color-sel-tint)",color:"var(--color-accent)",borderRadius:20,padding:"4px 12px",fontSize:11,fontWeight:700}}>{t.diffOpts[diff]}</span>
            <span style={{background:"var(--color-sel-tint)",color:"var(--color-accent)",borderRadius:20,padding:"4px 12px",fontSize:11,fontWeight:700}}>{t.quizTypes[quiz.type]}</span>
          </div>
          {quiz.type==="cards"&&<Flashcard key={qIdx} q={q} isLast={isLast} t={t} onNext={ok=>{const u=[...answers,{isCorrect:ok}];setAnswers(u);setSelected(null);if(qIdx+1>=quiz.questions.length)setScreen("results");else setQIdx(i=>i+1);}}/>}
          {quiz.type==="fill" &&<FillBlank  key={qIdx} q={q} isLast={isLast} t={t} feedback={settings.feedback} autoAdvance={settings.autoAdvance} autoSec={autoAdvanceSec} onNext={(ok,picked)=>{const u=[...answers,{isCorrect:ok,picked}];setAnswers(u);setSelected(null);if(qIdx+1>=quiz.questions.length)setScreen("results");else setQIdx(i=>i+1);}}/>}
          {quiz.type==="mcq"  &&(
            <>
              <h3 style={{fontFamily:"'Fraunces',Georgia,serif",fontSize:19,fontWeight:700,color:"var(--color-text-primary)",lineHeight:1.4,margin:0}}>{q.question}<SourceMark source={q.source} label={t.srcSeeQuestion} t={t}/></h3>
              <div style={{display:"flex",flexDirection:"column",gap:9,marginTop:20}}>
                {q.options.map((opt,i)=>{
                  const isChosen=selected===i,isCorrect=q.correct===i;
                  let extra={};
                  if(selected!==null){
                    // Instant: reveal right/wrong. At-end: just mark the picked
                    // option (no correctness shown until the results review).
                    if(instant){if(isCorrect)extra={border:"1.5px solid #22c55e",background:"#f0fdf4",color:"#15803d"};else if(isChosen)extra={border:"1.5px solid #ef4444",background:"#fef2f2",color:"#b91c1c"};else extra={opacity:0.45};}
                    else if(isChosen)extra={border:"1.5px solid #4338ca",background:"var(--color-sel-tint)"};
                    else extra={opacity:0.55};
                  }
                  return <button key={i} onClick={()=>pick(i)} disabled={selected!==null} className={selected===null?"quiz-opt":""} style={{display:"flex",alignItems:"center",gap:12,background:"var(--color-background-primary)",border:"1.5px solid var(--color-border-tertiary)",borderRadius:12,padding:"13px 14px",cursor:selected!==null?"default":"pointer",fontSize:14,color:"var(--color-text-primary)",fontFamily:"inherit",transition:"all 0.18s",...extra}}>
                    <span style={{width:28,height:28,borderRadius:"50%",background:"var(--color-background-secondary)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,fontWeight:700,flexShrink:0}}>{LETTERS[i]}</span>
                    <span style={{flex:1,textAlign:"left",lineHeight:1.4}}>{opt}</span>
                    {instant&&selected!==null&&isCorrect&&<Icon name="check" size={17} stroke={2.6} style={{color:"#16a34a",flexShrink:0}}/>}{instant&&selected!==null&&isChosen&&!isCorrect&&<Icon name="x" size={17} stroke={2.6} style={{color:"#dc2626",flexShrink:0}}/>}
                  </button>;
                })}
              </div>
              {selected!==null&&instant&&<div style={{borderRadius:10,padding:"12px 14px",marginTop:14,...(selected===q.correct?{background:"#f0fdf4",border:"0.5px solid #86efac",color:"#15803d"}:{background:"#fef2f2",border:"0.5px solid #fca5a5",color:"#b91c1c"})}} className="slide-up"><strong style={{fontSize:14}}>{selected===q.correct?t.correct:t.incorrect}</strong><p style={{margin:"5px 0 0",fontSize:13,lineHeight:1.5}}>{q.explanation}</p></div>}
              {settings.autoAdvance && instant && selected!==null && <AutoAdvanceBar sec={autoAdvanceSec} runId={qIdx} t={t}/>}
              {(!settings.autoAdvance || instant) && <button style={{...Sb.btnPrimary,width:"100%",marginTop:settings.autoAdvance?12:20,opacity:selected===null?0.35:1,cursor:selected===null?"not-allowed":"pointer"}} onClick={nextMCQ} disabled={selected===null}>{settings.autoAdvance?t.skip||t.next:(isLast?t.finish:t.next)}</button>}
              <div style={{textAlign:"center",marginTop:12}}><FlagFix key={qIdx} q={q} subject={quiz.subject} blocks={genBlocksRef.current} uiLangName={LANGS[lang]?.name} diff={diff} t={t} onReplace={replaceCurrentQuestion}/></div>
            </>
          )}
        </div>
        <ExitModal show={showExitConfirm} onStay={()=>setShowExitConfirm(false)} onLeave={()=>{setShowExitConfirm(false);newMat();}}/>
        <button onClick={openSettings} title={t.set?.title||"Settings"} aria-label={t.set?.title||"Settings"} style={{position:"fixed",left:12,bottom:58,zIndex:400,width:38,height:38,borderRadius:"50%",background:"var(--color-background-secondary)",border:"0.5px solid var(--color-border-secondary)",color:"var(--color-text-secondary)",cursor:"pointer",fontFamily:"inherit",display:"inline-flex",alignItems:"center",justifyContent:"center",boxShadow:"0 2px 10px rgba(0,0,0,0.18)"}}><Icon name="gear" size={17}/></button>
        <button onClick={()=>setShowBugReport(true)} title={t.reportTitle} aria-label={t.reportTitle} style={{position:"fixed",left:12,bottom:12,zIndex:400,width:38,height:38,borderRadius:"50%",background:"var(--color-background-secondary)",border:"0.5px solid var(--color-border-secondary)",color:"var(--color-text-secondary)",cursor:"pointer",fontFamily:"inherit",display:"inline-flex",alignItems:"center",justifyContent:"center",boxShadow:"0 2px 10px rgba(0,0,0,0.18)"}}><Icon name="chat" size={17}/></button>
        {showBugReport && <ContactModal defaultEmail={user?.email||""} onClose={()=>setShowBugReport(false)} t={t}/>}
        {showSettings && <SettingsPanel draft={settingsDraft} update={updateDraft} onApply={applySettings} onCancel={cancelSettings} onSignOut={()=>signOut()} onDeleteAccount={confirmDeleteAccount} requiresPassword={requiresPassword} onReauthenticate={reauthenticate} isPro={isPro} onManageSubscription={openPortal} signedIn={!!user} t={t}/>}
      </div>
    );
  }

  // ── RESULTS ──────────────────────────────────────────────────────
  if (screen==="results" && quiz) return (
    <div style={Sb.root}><style>{CSS}</style>
      <AdBanners isPro={isPro} bottom={false}/>
      {upgraded && <div style={{position:"fixed",top:0,left:0,right:0,zIndex:800,background:"#16a34a",color:"#fff",textAlign:"center",padding:"11px 14px",fontSize:14,fontWeight:700,fontFamily:"inherit",boxShadow:"0 2px 12px rgba(0,0,0,0.25)"}}>{t.welcomePro}</div>}
      <div style={{background:"#2c2870",padding:"36px 20px 28px",textAlign:"center"}}>
        <div style={{marginBottom:10,display:"flex",justifyContent:"center"}}><Icon name={badge.icon} size={46} stroke={1.7} style={{color:"#fff"}}/></div>
        <h2 style={{margin:"0 0 4px",fontSize:22,fontWeight:700,color:"#fff"}}>{badge.text}</h2>
        <div style={{fontSize:46,fontWeight:800,color:"#fff",letterSpacing:-1,fontFamily:"'Fraunces',Georgia,serif"}}>{pct}%</div>
        <div style={{fontSize:14,color:"rgba(255,255,255,0.7)",marginTop:4}}>{score} {t.outOf} {quiz.questions.length}</div>
        <div style={{display:"flex",flexWrap:"wrap",gap:5,justifyContent:"center",marginTop:16}}>{answers.map((a,i)=><span key={i} style={{width:14,height:14,borderRadius:4,background:a.isCorrect?"#4ade80":"#f87171"}}/>)}</div>
      </div>
      <div className="rv-center" style={{padding:"20px 16px"}}>
        {srsAdded>0 && (
          <div style={{display:"flex",alignItems:"center",gap:10,background:"var(--color-sel-tint)",border:"1px solid #c7d2fe",borderRadius:12,padding:"11px 14px",marginBottom:16}}>
            <Icon name="repeat" size={18} style={{color:"var(--color-accent)",flexShrink:0}}/>
            <span style={{flex:1,fontSize:12.5,color:"var(--color-accent)",lineHeight:1.4}}>{t.srsAddedMsg.replace("{n}",srsAdded).replace("{s}",srsAdded>1?"s":"")}</span>
            <button onClick={startReview} style={{flexShrink:0,background:"#4338ca",color:"#fff",border:"none",borderRadius:9,padding:"7px 12px",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>{t.srsReview}</button>
          </div>
        )}
        <div style={{display:"flex",gap:10,marginBottom:16}}>
          {[{v:score,l:t.correct2},{v:quiz.questions.length-score,l:t.wrong},{v:t.diffOpts[diff]||"-",l:t.level}].map(({v,l},i)=>(
            <div key={i} style={{flex:1,background:"var(--color-background-primary)",borderRadius:10,padding:"12px 6px",textAlign:"center",border:"0.5px solid var(--color-border-tertiary)"}}>
              <div style={{fontSize:17,fontWeight:700,color:"var(--color-text-primary)"}}>{v}</div>
              <div style={{fontSize:11,color:"var(--color-text-secondary)",marginTop:2}}>{l}</div>
            </div>
          ))}
        </div>
        {resNudge && (
          <div style={{display:"flex",alignItems:"center",gap:10,background:"var(--color-sel-tint)",border:"1px solid #c7d2fe",borderRadius:12,padding:"11px 14px",marginBottom:16}}>
            <Icon name={resNudge.dir==="up"?"spark":"flame"} size={18} style={{color:"var(--color-accent)",flexShrink:0}}/>
            <span style={{flex:1,fontSize:12.5,color:"var(--color-accent)",lineHeight:1.4}}>{(resNudge.dir==="up"?t.nudgeHarder:t.nudgeEasier).replace("{n}",t.diffOpts[resNudge.to])}</span>
            <button onClick={()=>{ pickDiff(resNudge.to); newMat(); }} style={{flexShrink:0,background:"#4338ca",color:"#fff",border:"none",borderRadius:9,padding:"7px 12px",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>{t.useThis}</button>
          </div>
        )}
        {missedThisQuiz.length>0 && (
          <button onClick={fixMisses} style={{...Sb.btnPrimary,width:"100%",margin:"0 0 14px",display:"inline-flex",alignItems:"center",justifyContent:"center",gap:9,background:"linear-gradient(135deg,#15803d,#22c55e)"}}>
            <Icon name="target" size={17}/>{t.fixMisses.replace("{n}",missedThisQuiz.length)}
          </button>
        )}
        {planSession && (
          <div style={{display:"flex",alignItems:"center",gap:10,background:"linear-gradient(135deg,#4338ca,#6366f1)",borderRadius:12,padding:"11px 14px",marginBottom:14,color:"#fff"}}>
            <Icon name="compass" size={18} style={{color:"#fff",flexShrink:0}}/>
            <span style={{flex:1,fontSize:12.5,fontWeight:700,lineHeight:1.4}}>{t.coachComplete}</span>
            <button onClick={backToPlan} style={{flexShrink:0,background:"rgba(255,255,255,0.2)",color:"#fff",border:"none",borderRadius:9,padding:"7px 12px",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>{t.coachBackToPlan}</button>
          </div>
        )}
        <div style={{display:"flex",gap:10,marginBottom:14}}>
          <button style={{...Sb.btnPrimary,flex:1,margin:0}} onClick={retry}>{t.retry}</button>
          <button style={{...Sb.btnOutline,flex:1}} onClick={newMat}>{t.newMat}</button>
        </div>
        <button style={{...Sb.btnPrimary,width:"100%",margin:"0 0 14px",background:"var(--color-clay,#b5502f)"}} onClick={createShareLink} disabled={shareBusy}>{shareBusy?t.shareCreating:<span style={{display:"inline-flex",alignItems:"center",gap:8}}><Icon name="trophy" size={16}/>{t.challengeFriend}</span>}</button>
        {shareOpen && <ShareModal link={shareLink} err={shareErr} copied={shareCopied} onCopy={copyShare} onClose={()=>setShareOpen(false)} challengeScore={`${score}/${quiz.questions.length}`} t={t}/>}
        {!isPro&&adsOn&&<div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:6,background:"var(--color-background-secondary)",border:"0.5px dashed var(--color-border-secondary)",borderRadius:10,padding:"8px 14px",fontSize:12,color:"var(--color-text-tertiary)",marginBottom:14}}><Icon name="volume" size={13}/>{t.advertisement}</div>}
        <p style={Sb.secLabel}>{t.review}</p>
        {quiz.type==="match"?
          quiz.questions.map((q,i)=>{
            const a=answers[i];
            return <div key={i} style={{background:"var(--color-background-primary)",borderRadius:10,padding:"14px 14px 14px 11px",marginBottom:10,border:"0.5px solid var(--color-border-tertiary)",borderLeft:`3px solid ${a?.isCorrect?"#22c55e":"#ef4444"}`}} className="fade-in">
              <div style={{display:"flex",gap:8,alignItems:"flex-start",marginBottom:8}}><span style={{flexShrink:0,display:"inline-flex",marginTop:1}}>{a?.isCorrect?<Icon name="check" size={16} stroke={2.6} style={{color:"#16a34a"}}/>:<Icon name="x" size={16} stroke={2.6} style={{color:"#dc2626"}}/>}</span><span style={{fontSize:14,fontWeight:600,color:"var(--color-text-primary)",lineHeight:1.4}}>{q.question}<SourceMark source={q.source} label={t.srcSeeQuestion} t={t}/></span></div>
              {!a?.isCorrect&&a&&<div style={{fontSize:12,color:"#dc2626",marginBottom:4,paddingLeft:23}}>{t.yourAns} {a.chosen||", "}</div>}
              <div style={{fontSize:12,color:"#16a34a",marginBottom:6,paddingLeft:23,fontWeight:500}}>{t.correctAns} {q.answer||""}<SourceMark source={q.source} label={t.srcSeeAnswer} quoteLabel={t.srcConfirmsAnswer} t={t}/></div>
              {!a?.isCorrect&&<ExplainBox t={t} ctx={{question:q.question,correct:q.answer||"",picked:a?.chosen||"",subject:quiz.subject}}/>}
            </div>;
          })
        :
          quiz.questions.map((q,i)=>{
            const a=answers[i];
            return <div key={i} style={{background:"var(--color-background-primary)",borderRadius:10,padding:"14px 14px 14px 11px",marginBottom:10,border:"0.5px solid var(--color-border-tertiary)",borderLeft:`3px solid ${a?.isCorrect?"#22c55e":"#ef4444"}`}} className="fade-in">
              <div style={{display:"flex",gap:8,alignItems:"flex-start",marginBottom:8}}><span style={{flexShrink:0,display:"inline-flex",marginTop:1}}>{a?.isCorrect?<Icon name="check" size={16} stroke={2.6} style={{color:"#16a34a"}}/>:<Icon name="x" size={16} stroke={2.6} style={{color:"#dc2626"}}/>}</span><span style={{fontSize:14,fontWeight:600,color:"var(--color-text-primary)",lineHeight:1.4}}>{q.question}<SourceMark source={q.source} label={t.srcSeeQuestion} t={t}/></span></div>
              {!a?.isCorrect&&a&&(quiz.type==="mcq"||quiz.type==="fill")&&<div style={{fontSize:12,color:"#dc2626",marginBottom:4,paddingLeft:23}}>{t.yourAns} {quiz.type==="mcq"?(q.options?.[a.selected]??", "):(a.picked||", ")}</div>}
              <div style={{fontSize:12,color:"#16a34a",marginBottom:6,paddingLeft:23,fontWeight:500}}>{t.correctAns} {quiz.type==="mcq"?q.options?.[q.correct]:(q.answer||"")}<SourceMark source={q.source} label={t.srcSeeAnswer} quoteLabel={t.srcConfirmsAnswer} t={t}/></div>
              {q.explanation&&<div style={{fontSize:12,color:"var(--color-text-secondary)",lineHeight:1.55,paddingTop:8,borderTop:"0.5px solid var(--color-border-tertiary)",paddingLeft:23}}>{q.explanation}</div>}
              {!a?.isCorrect&&<ExplainBox t={t} ctx={{question:q.question,correct:quiz.type==="mcq"?(q.options?.[q.correct]??""):(q.answer||""),picked:quiz.type==="mcq"?(q.options?.[a?.selected]??""):(a?.picked||""),subject:quiz.subject}}/>}
            </div>;
          })
        }
      </div>
    </div>
  );

  // ── EXAM SETUP ────────────────────────────────────────────────────
  // ── REVIEW (spaced repetition) ───────────────────────────────────
  if(screen==="review") {
    const card = srs.cards.find(c=>c.id===reviewQueue[reviewPos]);
    const done = reviewPos>=reviewQueue.length || !card;
    const gradeCard = (ok) => { if(card) srs.grade(card.id, ok); setReviewShown(false); setReviewPos(p=>p+1); };
    // Feature H, explainable SRS: mirror the SM-2 schedule so the learner can see
    // WHY this card is up and WHEN a "Got it" sends it back (no more black box).
    const goodDays = card ? (card.reps===0 ? 1 : card.reps===1 ? 3 : Math.max(1, Math.round((card.interval||1) * (card.ease||2.3)))) : 0;
    const whyLabel = card ? (card.lapses>0 ? t.srsWhyMissed : card.reps===0 ? t.srsWhyNew : t.srsWhySeen.replace("{n}",card.reps).replace("{s}",card.reps>1?"s":"")) : "";
    const whyMissed = !!(card && card.lapses>0);
    return (
      <div style={Sb.root}><style>{CSS}</style>
        <AdBanners isPro={isPro}/>
        <div style={Sb.topbar} className="rv-topbar">
          <button style={Sb.backBtn} onClick={()=>setScreen("home")}>← {t.homeWord}</button>
          <span style={{...Sb.brand,color:"var(--color-accent)",display:"inline-flex",alignItems:"center",gap:7}}><Icon name="repeat" size={18}/>{t.srsReview}</span>
          <span style={{fontSize:12,color:"var(--color-text-secondary)",fontWeight:600}}>{done?"":`${Math.min(reviewPos+1,reviewQueue.length)}/${reviewQueue.length}`}</span>
        </div>
        {!done && <PBar v={reviewPos} max={reviewQueue.length||1}/>}
        <div className="rv-center-narrow" style={{padding:"22px 16px 32px"}}>
          {done ? (
            <div style={{textAlign:"center",padding:"30px 0"}}>
              <div style={{marginBottom:12,display:"flex",justifyContent:"center"}}><Icon name={reviewQueue.length?"spark":"check"} size={44} stroke={1.8} style={{color:"var(--color-accent)"}}/></div>
              <h2 style={{...Sb.h2,margin:"0 0 6px"}}>{reviewQueue.length?t.reviewComplete:t.nothingDue}</h2>
              <p style={{fontSize:14,color:"var(--color-text-secondary)",lineHeight:1.6,maxWidth:320,margin:"0 auto 22px"}}>
                {reviewQueue.length
                  ? `${t.reviewedCards.replace("{n}",reviewQueue.length).replace("{s}",reviewQueue.length>1?"s":"")} ${srs.dueCount>0?t.moreCameDue.replace("{n}",srs.dueCount):t.comeBackTomorrow}`
                  : t.reviewDeckInfo.replace("{n}",srs.totalCount).replace("{s}",srs.totalCount===1?"":"s")}
              </p>
              {reviewQueue.length>0 && srs.dueCount>0 &&
                <button style={{...Sb.btnPrimary,width:"100%",marginBottom:10}} onClick={startReview}>{t.reviewMore.replace("{n}",srs.dueCount)}</button>}
              <button style={{...Sb.btnPrimary,width:"100%",background:"var(--color-background-secondary)",color:"var(--color-text-primary)",border:"0.5px solid var(--color-border-secondary)"}} onClick={()=>setScreen("home")}>{t.backToHome}</button>
            </div>
          ) : (
            <>
              <div style={{background:"var(--color-background-primary)",borderRadius:16,border:"0.5px solid var(--color-border-tertiary)",padding:"24px 20px",minHeight:150,display:"flex",flexDirection:"column",justifyContent:"center"}}>
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:8,marginBottom:10}}>
                  <span style={{fontSize:11,fontWeight:700,letterSpacing:0.8,color:"var(--color-text-tertiary)",textTransform:"uppercase"}}>{t.question}</span>
                  {whyLabel && <span style={{flexShrink:0,fontSize:10,fontWeight:700,color:whyMissed?"#b45309":"var(--color-accent)",background:whyMissed?"#fffbeb":"var(--color-sel-tint)",borderRadius:20,padding:"3px 9px",display:"inline-flex",alignItems:"center",gap:4}}><Icon name={whyMissed?"repeat":card.reps===0?"spark":"check"} size={11} stroke={2.2}/>{whyLabel}</span>}
                </div>
                <div style={{fontSize:18,fontWeight:600,color:"var(--color-text-primary)",lineHeight:1.45,fontFamily:"'Fraunces',Georgia,serif"}}>{card.front}</div>
                {reviewShown && (
                  <div className="slide-up" style={{marginTop:18,paddingTop:16,borderTop:"0.5px solid var(--color-border-tertiary)"}}>
                    <div style={{fontSize:11,fontWeight:700,letterSpacing:0.8,color:"#16a34a",marginBottom:8,textTransform:"uppercase"}}>{t.answerWord}</div>
                    <div style={{fontSize:15,fontWeight:600,color:"var(--color-text-primary)",lineHeight:1.5}}>{card.back||", "}</div>
                    {card.explanation && <p style={{margin:"12px 0 0",fontSize:13,color:"var(--color-text-secondary)",lineHeight:1.55}}>{card.explanation}</p>}
                  </div>
                )}
              </div>
              {!reviewShown ? (
                <button style={{...Sb.btnPrimary,width:"100%",marginTop:18}} onClick={()=>setReviewShown(true)}>{t.showAnswer}</button>
              ) : (
                <div style={{display:"flex",gap:10,marginTop:18}}>
                  <button style={{flex:1,background:"#fef2f2",border:"1.5px solid #fca5a5",color:"#b91c1c",borderRadius:12,padding:"11px",cursor:"pointer",fontFamily:"inherit",display:"flex",flexDirection:"column",alignItems:"center",gap:2}} onClick={()=>gradeCard(false)}>
                    <span style={{fontSize:14,fontWeight:700}}>{t.againBtn}</span>
                    <span style={{fontSize:10.5,fontWeight:600,opacity:0.85}}>{t.srsAgainNext}</span>
                  </button>
                  <button style={{flex:1,background:"#16a34a",border:"none",color:"#fff",borderRadius:12,padding:"11px",cursor:"pointer",fontFamily:"inherit",display:"flex",flexDirection:"column",alignItems:"center",gap:2}} onClick={()=>gradeCard(true)}>
                    <span style={{fontSize:14,fontWeight:700}}>{t.gotIt}</span>
                    <span style={{fontSize:10.5,fontWeight:600,opacity:0.9}}>{t.srsGoodNext.replace("{n}",goodDays).replace("{s}",goodDays>1?"s":"")}</span>
                  </button>
                </div>
              )}
              <p style={{textAlign:"center",fontSize:11,color:"var(--color-text-tertiary)",marginTop:14,lineHeight:1.5}}>{t.reviewHint}</p>
            </>
          )}
        </div>
      </div>
    );
  }

  if(screen==="exam_setup") return (
    <div style={Sb.root}><style>{CSS}</style>
      <AdBanners isPro={isPro}/>
      {upgraded && <div style={{position:"fixed",top:0,left:0,right:0,zIndex:800,background:"#16a34a",color:"#fff",textAlign:"center",padding:"11px 14px",fontSize:14,fontWeight:700,fontFamily:"inherit",boxShadow:"0 2px 12px rgba(0,0,0,0.25)"}}>{t.welcomePro}</div>}
      <div style={Sb.topbar} className="rv-topbar">
        <button style={Sb.backBtn} onClick={()=>setScreen("upload")}>← {t.backWord}</button>
        <span style={{...Sb.brand,color:"var(--color-accent)"}}><Icon name="cap" size={16}/>{stripEmoji(t.examModeLabel)}</span>
        <span style={{fontSize:10,background:isPro?"#f59e0b":"#4338ca",color:"#fff",borderRadius:8,padding:"2px 8px",fontWeight:700,whiteSpace:"nowrap"}}>{isPro?"PRO":t.oneFreePerDay}</span>
      </div>
      <div className="rv-exam-body" style={{padding:"20px 16px 40px"}}>
        <p style={{fontSize:13,color:"var(--color-text-secondary)",marginBottom:20,lineHeight:1.6}}>{t.examModeSub}</p>
        <p style={Sb.secLabel}>{t.examType}</p>
        <div style={{display:"flex",flexDirection:"column",gap:10,marginBottom:22}}>
          {[{id:"mcq",icon:"list",title:t.fullMCQ,desc:t.fullMCQDesc},{id:"written",icon:"pencil",title:t.fullWritten,desc:t.fullWrittenDesc},{id:"custom",icon:"sliders",title:t.customMix,desc:t.customMixDesc}].filter(m=>isPro||m.id!=="custom").map(m=>(
            <div key={m.id} onClick={()=>setExamMode(m.id)} className="exam-type-card" style={{display:"flex",alignItems:"center",gap:14,borderRadius:12,padding:"14px 16px",cursor:"pointer",border:"1.5px solid "+(examMode===m.id?"#4338ca":"var(--color-border-tertiary)"),background:examMode===m.id?"var(--color-sel-tint)":"var(--color-background-primary)",transition:"all 0.18s",boxShadow:examMode===m.id?"0 4px 16px #4338ca33":"none"}}>
              <span style={{flexShrink:0,display:"flex",color:"var(--color-accent)"}}><Icon name={m.icon} size={24} stroke={1.6}/></span>
              <div style={{flex:1}}><div style={{fontWeight:600,fontSize:14,color:"var(--color-text-primary)"}}>{m.title}</div><div style={{fontSize:12,color:"var(--color-text-secondary)",marginTop:2}}>{m.desc}</div></div>
              {examMode===m.id&&<span style={{color:"var(--color-accent)",fontWeight:700,fontSize:18}}>✓</span>}
            </div>
          ))}
        </div>
        {examMode&&examMode!=="custom"&&(
          <div style={{marginBottom:20}}>
            <p style={Sb.secLabel}>{t.totalQ.toUpperCase()}</p>
            {isPro ? (
              <div style={{background:"var(--color-background-primary)",borderRadius:12,padding:"14px 16px",border:"0.5px solid var(--color-border-tertiary)"}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                  <span style={{fontSize:13,color:"var(--color-text-secondary)"}}>{t.questionsLow}</span>
                  <span style={{fontWeight:700,fontSize:18,color:"var(--color-accent)"}}>{Math.min(Math.max(parseInt(examTotalQ)||1,1),100)}</span>
                </div>
                <input type="range" min={1} max={100} step={1} value={Math.min(Math.max(parseInt(examTotalQ)||1,1),100)} onChange={e=>setExamTotalQ(e.target.value)} style={{width:"100%",accentColor:"#4338ca",cursor:"pointer"}}/>
                <div style={{display:"flex",justifyContent:"space-between",fontSize:10,color:"var(--color-text-tertiary)",marginTop:2}}><span>1</span><span>100</span></div>
              </div>
            ) : (
              <div style={{background:"var(--color-background-primary)",borderRadius:12,padding:"14px 16px",border:"0.5px solid var(--color-border-tertiary)"}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <span style={{fontSize:13,color:"var(--color-text-secondary)"}}>{t.freeDailyExam}</span>
                  <span style={{fontWeight:700,fontSize:18,color:"var(--color-accent)"}}>{t.examFreeQCount}</span>
                </div>
                <p style={{fontSize:11,color:"var(--color-text-tertiary)",lineHeight:1.5,margin:"8px 0 0"}}>{t.upgradeExamNote}</p>
              </div>
            )}
          </div>
        )}
        {examMode==="custom"&&(
          <div style={{marginBottom:20}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
              <p style={{...Sb.secLabel,margin:0}}>{t.examSectionsLbl}</p>
              {examSections.length<5&&<button onClick={addSection} style={{background:"var(--color-sel-tint)",border:"1px solid #a5b4fc",color:"var(--color-accent)",borderRadius:8,padding:"5px 12px",fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>{t.addSectionBtn}</button>}
            </div>
            <div style={{display:"flex",flexDirection:"column",gap:10}}>
              {examSections.map((sec,si)=>{
                const secMarks=(parseInt(sec.count)||0)*(parseFloat(sec.marksPerQ)||1);
                return (
                  <div key={sec.id} style={{background:"var(--color-background-primary)",borderRadius:12,border:"0.5px solid var(--color-border-tertiary)",overflow:"hidden"}}>
                    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"10px 14px",borderBottom:"0.5px solid var(--color-border-tertiary)",background:si%2===0?"var(--color-sel-tint)":"#fef3c7"}}>
                      <span style={{fontWeight:700,fontSize:13,color:si%2===0?"#4338ca":"#92400e"}}>{t.sectionNum.replace("{n}",si+1)}</span>
                      <div style={{display:"flex",alignItems:"center",gap:8}}>
                        <span style={{fontSize:11,fontWeight:600,color:"var(--color-text-secondary)"}}>{secMarks} {t.marksWord}</span>
                        {examSections.length>1&&<button onClick={()=>removeSection(sec.id)} style={{background:"none",border:"none",cursor:"pointer",color:"var(--color-text-tertiary)",fontSize:16,lineHeight:1,padding:"0 2px"}}>✕</button>}
                      </div>
                    </div>
                    <div style={{display:"flex",flexDirection:"column",gap:12,padding:"12px 14px"}}>
                      <div style={{display:"grid",gridTemplateColumns:"1fr 96px",gap:8,alignItems:"end"}}>
                        <div>
                          <div style={{fontSize:10,fontWeight:600,color:"var(--color-text-tertiary)",marginBottom:4}}>{t.questionTypeLbl}</div>
                          <select value={sec.type} onChange={e=>updateSection(sec.id,"type",e.target.value)} style={{width:"100%",borderRadius:8,border:"0.5px solid var(--color-border-secondary)",background:"var(--color-background-tertiary)",color:"var(--color-text-primary)",fontSize:13,padding:"7px 8px",fontFamily:"inherit",outline:"none"}}>
                            <option value="mcq">{t.quizTypes.mcq}</option>
                            <option value="written">{t.qtWrittenOpen}</option>
                            <option value="fill">{t.quizTypes.fill}</option>
                          </select>
                        </div>
                        <div>
                          <div style={{fontSize:10,fontWeight:600,color:"var(--color-text-tertiary)",marginBottom:4}}>{t.marksPerQLbl}</div>
                          <input type="number" min={0.5} max={20} step={0.5} value={sec.marksPerQ} onChange={e=>updateSection(sec.id,"marksPerQ",e.target.value)} style={{width:"100%",borderRadius:8,border:"0.5px solid var(--color-border-secondary)",background:"var(--color-background-tertiary)",color:"var(--color-text-primary)",fontSize:15,fontWeight:700,padding:"7px 6px",fontFamily:"inherit",outline:"none",textAlign:"center",boxSizing:"border-box"}}/>
                        </div>
                      </div>
                      <div>
                        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
                          <span style={{fontSize:10,fontWeight:600,color:"var(--color-text-tertiary)"}}>{t.questionsUpperLbl}</span>
                          <span style={{fontWeight:700,fontSize:14,color:"var(--color-accent)"}}>{Math.min(Math.max(parseInt(sec.count)||1,1),100)}</span>
                        </div>
                        <input type="range" min={1} max={100} step={1} value={Math.min(Math.max(parseInt(sec.count)||1,1),100)} onChange={e=>updateSection(sec.id,"count",e.target.value)} style={{width:"100%",accentColor:"#4338ca",cursor:"pointer"}}/>
                        <div style={{display:"flex",justifyContent:"space-between",fontSize:10,color:"var(--color-text-tertiary)",marginTop:2}}><span>1</span><span>100</span></div>
                      </div>
                    </div>
                    <div style={{padding:"6px 14px 10px",fontSize:11,color:"var(--color-text-secondary)"}}>
                      {parseInt(sec.count)||0} {sec.type==="mcq"?t.typeMcqLower:sec.type==="fill"?t.typeFillLower:t.typeWrittenLower} {t.questionsLow} × {parseFloat(sec.marksPerQ)||1} {t.marksWord} = <strong>{secMarks} {t.marksWord}</strong>
                    </div>
                  </div>
                );
              })}
            </div>
            <div style={{marginTop:12,background:"#2c2870",borderRadius:10,padding:"12px 16px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <span style={{fontSize:13,color:"rgba(255,255,255,0.8)"}}>{t.totalExamLbl}</span>
              <span style={{fontSize:15,fontWeight:700,color:"#fff"}}>{sectionTotalQs} {t.questionsLow} · {sectionTotalMarks} {t.marksWord}</span>
            </div>
          </div>
        )}
        {examMode && (
          <div style={{marginBottom:22}}>
            <p style={Sb.secLabel}>{t.timerLbl}</p>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",background:"var(--color-background-primary)",borderRadius:12,padding:"12px 16px",border:"0.5px solid var(--color-border-tertiary)"}}>
              <div>
                <div style={{fontSize:14,fontWeight:600,color:"var(--color-text-primary)"}}>{t.enableTimer}</div>
                <div style={{fontSize:11,color:"var(--color-text-tertiary)",marginTop:2}}>{t.timerDesc}</div>
              </div>
              <Toggle on={examTimerOn} onChange={setExamTimerOn}/>
            </div>
            {examTimerOn && (
              <div style={{marginTop:10,background:"var(--color-background-primary)",borderRadius:12,padding:"12px 16px",border:"0.5px solid var(--color-border-tertiary)"}}>
                <div style={{display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
                  <span style={{fontSize:13,color:"var(--color-text-secondary)"}}>{t.totalExamTime}</span>
                  <input type="number" min={5} max={180} value={examTimerMin} onChange={e=>setExamTimerMin(e.target.value)} style={{width:80,borderRadius:8,border:"0.5px solid var(--color-border-secondary)",background:"var(--color-background-tertiary)",color:"var(--color-text-primary)",fontSize:16,fontWeight:700,padding:"7px 10px",fontFamily:"inherit",outline:"none",textAlign:"center"}}/>
                </div>
                <p style={{fontSize:11,color:"var(--color-text-tertiary)",lineHeight:1.5,margin:"10px 0 0"}}>{t.timerNote}</p>
              </div>
            )}
          </div>
        )}
        <div style={{marginBottom:22}}>
          <p style={Sb.secLabel}>{t.difficulty.toUpperCase()}</p>
          <div style={{display:"flex",gap:8}}>{t.diffOpts.map((d,i)=><Chip key={d} label={d} active={diff===i} onClick={()=>pickDiff(i)}/>)}</div>
        </div>
        {(() => {
          const examCap = isPro ? EXAM_FILES_PRO : EXAM_FILES_FREE;
          const efs = examFiles.filter(Boolean);
          return (<>
        <p style={Sb.secLabel}>{t.examFiles.toUpperCase()} ({efs.length}/{examCap})</p>
        <p style={{fontSize:12,color:"var(--color-text-secondary)",marginBottom:12,marginTop:-8}}>{t.examFilesHint}</p>
        <input ref={examAddRef} type="file" accept=".pdf,.txt,.md,.csv,image/*" style={{display:"none"}} onChange={e=>{addExamFile(e.target.files[0]); e.target.value="";}}/>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:22}}>
          {efs.map((ef,idx)=>(
            <div key={idx} style={{background:"var(--color-sel-tint)",border:"1px solid #a5b4fc",borderRadius:10,padding:"10px",display:"flex",alignItems:"center",gap:8,cursor:"pointer",minHeight:56}} onClick={()=>removeExamFile(idx)}>
              <span style={{flexShrink:0,display:"inline-flex",color:"var(--color-accent)"}}><Icon name={ef.type==="pdf"?"notes":ef.type==="image"?"camera":"pencil"} size={18}/></span>
              <div style={{flex:1,minWidth:0}}><div style={{fontSize:10,fontWeight:600,color:"var(--color-accent)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{ef.name}</div><div style={{fontSize:9,color:"var(--color-text-secondary)"}}>{t.tapToRemove}</div></div>
            </div>
          ))}
          {efs.length<examCap && (
            <div style={{border:"1.5px dashed var(--color-border-secondary)",borderRadius:10,padding:"14px 8px",textAlign:"center",cursor:"pointer",background:"var(--color-background-primary)",minHeight:56,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center"}} onClick={()=>examAddRef.current.click()}>
              <div style={{color:"var(--color-text-tertiary)",marginBottom:3,display:"flex"}}><Icon name="paperclip" size={17}/></div>
              <div style={{fontSize:10,color:"var(--color-text-tertiary)"}}>{t.addFile}</div>
            </div>
          )}
        </div>
          </>);
        })()}
        {error&&<div style={{display:"flex",alignItems:"center",gap:8,background:"#fef2f2",border:"0.5px solid #fecaca",borderRadius:10,padding:"10px 14px",fontSize:13,color:"#b91c1c",marginBottom:14}}><Icon name="alert" size={15} style={{flexShrink:0}}/><span>{error}</span></div>}
        {limitHit && <button onClick={()=>setShowPacks(true)} style={{...Sb.btnPrimary,width:"100%",marginBottom:14,background:"#4338ca"}}><span style={{display:"inline-flex",alignItems:"center",gap:8}}><Icon name="gem" size={16}/>{t.getMoreQuestions}</span></button>}
        <button disabled={!examMode||examFiles.filter(Boolean).length===0} style={{...Sb.btnPrimary,width:"100%",opacity:(!examMode||examFiles.filter(Boolean).length===0)?0.35:1,background:"linear-gradient(135deg,#2c2870,#4338ca)"}} onClick={generateExam}>{t.startExam}</button>
      </div>
      {showPacks&&<PacksModal onClose={()=>setShowPacks(false)} buyPack={buyPack} t={t}/>}
      {showSettings&&<SettingsPanel draft={settingsDraft} update={updateDraft} onApply={applySettings} onCancel={cancelSettings} onSignOut={()=>signOut()} onDeleteAccount={confirmDeleteAccount} requiresPassword={requiresPassword} onReauthenticate={reauthenticate} isPro={isPro} onManageSubscription={openPortal} signedIn={!!user} t={t}/>}
    </div>
  );

  // ── EXAM RUN ──────────────────────────────────────────────────────
  if(screen==="exam_run"&&examQs.length>0){
    const q=examQs[examIdx],isLast=examIdx+1===examQs.length,answered=Object.keys(examAns).length;
    return (
      <div style={Sb.root}><style>{CSS}</style>
      <AdBanners isPro={isPro}/>
      {upgraded && <div style={{position:"fixed",top:0,left:0,right:0,zIndex:800,background:"#16a34a",color:"#fff",textAlign:"center",padding:"11px 14px",fontSize:14,fontWeight:700,fontFamily:"inherit",boxShadow:"0 2px 12px rgba(0,0,0,0.25)"}}>{t.welcomePro}</div>}
        <div style={Sb.topbar} className="rv-topbar">
          <button style={Sb.backBtn} onClick={()=>setShowExitConfirm(true)}>{t.examExitBtn}</button>
          <div style={{display:"flex",alignItems:"center",gap:12}}>
            <span style={{fontSize:12,fontWeight:600,color:"var(--color-text-secondary)"}}>{t.examProgress} {examIdx+1}/{examQs.length}</span>
            {examTimerOn && examTimeLeft!=null && (
              <span className={examTimeLeft<60?"rv-timer-flash":""} style={{display:"inline-flex",alignItems:"center",gap:4,fontSize:14,fontWeight:800,fontVariantNumeric:"tabular-nums",color: examTimeLeft<60?"#ef4444" : (examTimeLeft/examTotalSec)>0.5?"var(--color-text-primary)" : (examTimeLeft/examTotalSec)>0.25?"#f59e0b":"#ef4444"}}><Icon name="clock" size={14} style={{flexShrink:0}}/>{fmtClock(examTimeLeft)}</span>
            )}
          </div>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            {examTimerOn && !examTimeUp && <button onClick={()=>setExamPaused(true)} title={t.pauseLbl} aria-label={t.pauseLbl} style={{background:"none",border:"1px solid var(--color-border-secondary)",borderRadius:8,padding:"4px 9px",cursor:"pointer",color:"var(--color-text-secondary)",fontFamily:"inherit",display:"inline-flex",alignItems:"center"}}><Icon name="pause" size={14} stroke={2}/></button>}
            <span style={{fontSize:11,color:answered===examQs.length?"#16a34a":"var(--color-text-tertiary)",fontWeight:600}}>{answered}/{examQs.length}</span>
          </div>
        </div>
        <div style={{height:4,background:"var(--color-border-tertiary)"}}><div style={{height:"100%",background:"#94a3b8",width:((examIdx/examQs.length)*100)+"%",transition:"width 0.3s"}}/></div>
        {examReview && (
          <div style={{background:"#f0fdf4",borderBottom:"1px solid #86efac",padding:"8px 16px",display:"flex",alignItems:"center",justifyContent:"space-between",gap:10}}>
            <span style={{fontSize:12,color:"#15803d",fontWeight:600}}>{t.reviewModeNote}</span>
            <button onClick={()=>submitExam()} style={{background:"#16a34a",color:"#fff",border:"none",borderRadius:8,padding:"7px 14px",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:"inherit",whiteSpace:"nowrap"}}>{t.finalSubmit}</button>
          </div>
        )}
        <div className="rv-center-narrow" style={{padding:"20px 16px 32px"}}>
          {q.section&&(examIdx===0||examQs[examIdx-1]?.section!==q.section)&&(
            <div style={{background:"#2c2870",borderRadius:10,padding:"10px 16px",marginBottom:14,display:"flex",justifyContent:"space-between",alignItems:"center"}} className="fade-in">
              <span style={{fontWeight:700,fontSize:14,color:"#fff"}}>{t.sectionNum.replace("{n}",q.section)}</span>
              {examMode==="custom"&&examSections[q.section-1]&&(
                <span style={{fontSize:11,color:"rgba(255,255,255,0.75)"}}>{t.qsAndMarks.replace("{q}",examSections[q.section-1].count).replace("{m}",(parseInt(examSections[q.section-1].count)||0)*(parseFloat(examSections[q.section-1].marksPerQ)||1))}</span>
              )}
            </div>
          )}
          <div style={{display:"flex",gap:8,marginBottom:16,flexWrap:"wrap"}}>
            <span style={{background:q.type==="mcq"?"var(--color-sel-tint)":"#fef3c7",color:q.type==="mcq"?"#4338ca":"#92400e",borderRadius:20,padding:"4px 12px",fontSize:11,fontWeight:700}}>{q.type==="mcq"?t.quizTypes.mcq:q.type==="fill"?t.quizTypes.fill:t.writtenWord}</span>
            {examAns[examIdx]!==undefined&&<span style={{background:"#f0fdf4",color:"#16a34a",borderRadius:20,padding:"4px 10px",fontSize:11,fontWeight:600}}>{t.answeredWord}</span>}
          </div>
          <h3 style={{fontFamily:"'Fraunces',Georgia,serif",fontSize:19,fontWeight:700,color:"var(--color-text-primary)",lineHeight:1.4,margin:"0 0 20px"}}>{q.question}</h3>
          {q.type==="mcq"&&(
            <div style={{display:"flex",flexDirection:"column",gap:9}}>
              {q.options.map((opt,i)=>{
                const isSel=examAns[examIdx]===i;
                return <button key={i} onClick={()=>pickExam(i)} className="quiz-opt" style={{display:"flex",alignItems:"center",gap:12,background:isSel?"var(--color-sel-tint)":"var(--color-background-primary)",border:"1.5px solid "+(isSel?"#4338ca":"var(--color-border-tertiary)"),borderRadius:12,padding:"13px 14px",cursor:"pointer",fontSize:14,color:"var(--color-text-primary)",fontFamily:"inherit",transition:"all 0.18s"}}>
                  <span style={{width:28,height:28,borderRadius:"50%",background:isSel?"#4338ca":"var(--color-background-secondary)",color:isSel?"#fff":"var(--color-text-secondary)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,fontWeight:700,flexShrink:0}}>{LETTERS[i]}</span>
                  <span style={{flex:1,textAlign:"left",lineHeight:1.4}}>{opt}</span>
                </button>;
              })}
            </div>
          )}
          {q.type==="written"&&<textarea value={examAns[examIdx]||""} onChange={e=>setExamAns(prev=>({...prev,[examIdx]:e.target.value}))} placeholder={t.typeAnswer} style={{...Sb.textarea,height:150,marginBottom:0}}/>}
          {q.type==="fill"&&<FillBlank key={examIdx} q={q} isLast={isLast} t={t} onNext={ok=>{setExamAns(prev=>({...prev,[examIdx]:ok?q.answer:"__wrong__"}));if(isLast)submitExam();else setExamIdx(i=>i+1);}}/>}
          {q.type!=="fill"&&(
            <div style={{display:"flex",gap:10,marginTop:20}}>
              {examIdx>0&&<button onClick={prevExam} style={{...Sb.btnOutline,padding:"13px 20px",fontSize:13}}>← {t.prev}</button>}
              <button onClick={nextExam} style={{...Sb.btnPrimary,flex:1,margin:0,background:isLast?"#16a34a":"#4338ca",fontSize:14}}>{isLast?t.submitExam:t.next}</button>
            </div>
          )}
          {isLast&&q.type!=="fill"&&<p style={{fontSize:11,color:"var(--color-text-tertiary)",textAlign:"center",marginTop:8}}>{t.reviewBeforeSubmit}</p>}
        </div>
        <ExitModal show={showExitConfirm}
          title={t.examExitTitle}
          message={t.examExitMsg}
          stayLabel={t.examContinue} leaveLabel={t.examExitBtn} stayGreen
          onStay={()=>setShowExitConfirm(false)}
          onLeave={()=>{setShowExitConfirm(false);try{sessionStorage.removeItem("revyy_exam")}catch{ /* ignore */ };setScreen("exam_setup");}}/>

        {/* Submit-before-time-up review prompt */}
        {showSubmitPrompt && (
          <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.55)",zIndex:560,display:"flex",alignItems:"center",justifyContent:"center",padding:"20px"}}>
            <div className="slide-up" style={{background:"var(--color-background-primary)",borderRadius:16,padding:"26px 22px",maxWidth:330,width:"100%",textAlign:"center",boxShadow:"0 8px 32px rgba(0,0,0,0.25)"}}>
              <div style={{marginBottom:10,display:"flex",justifyContent:"center",color:"var(--color-accent)"}}><Icon name="list" size={30} stroke={1.8}/></div>
              <h3 style={{margin:"0 0 8px",fontSize:18,fontWeight:700,color:"var(--color-text-primary)",fontFamily:"'Fraunces',Georgia,serif"}}>{t.submitExamQ}</h3>
              <p style={{margin:"0 0 18px",fontSize:13,color:"var(--color-text-secondary)",lineHeight:1.5}}>{t.submitStillHave} <strong style={{color:"var(--color-accent)"}}>{fmtClock(examTimeLeft||0)}</strong> {t.submitReviewBefore}</p>
              <div style={{display:"flex",flexDirection:"column",gap:10}}>
                <button onClick={()=>{setShowSubmitPrompt(false);setExamReview(true);setExamIdx(0);}} style={{...Sb.btnPrimary,width:"100%",margin:0,background:"#4338ca",fontSize:14}}>{t.reviewAnswersBtn}</button>
                <button onClick={()=>{setShowSubmitPrompt(false);submitExam();}} style={{width:"100%",background:"#16a34a",color:"#fff",border:"none",borderRadius:12,padding:"13px",fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>{t.submitNowBtn}</button>
              </div>
            </div>
          </div>
        )}

        {examPaused && !examTimeUp && <PauseOverlay onResume={()=>setExamPaused(false)}/>}
        {examTimeUp && <TimeUpModal/>}
      </div>
    );
  }

  // ── EXAM EVAL ─────────────────────────────────────────────────────
  if(screen==="exam_eval") return (
    <div style={{...Sb.root,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:"0 24px",textAlign:"center",minHeight:"100vh"}}><style>{CSS}</style>
      <div style={{marginBottom:18,display:"flex",justifyContent:"center",color:"var(--color-accent)"}}><Icon name="spark" size={46} stroke={1.6}/></div>
      <h2 style={{...Sb.h2,textAlign:"center"}}>{t.evaluating}</h2>
      <p style={{fontSize:13,color:"var(--color-text-secondary)",marginBottom:24}}>{t.aiGradingMsg}</p>
      <div style={{display:"flex",flexDirection:"column",gap:12,alignItems:"flex-start"}}>
        {t.evalSteps.map((s,i)=>(<div key={i} className={"step step-"+i} style={{display:"flex",alignItems:"center",gap:10,fontSize:13,color:"var(--color-text-secondary)",opacity:0}}><span style={{width:8,height:8,borderRadius:"50%",background:"#4338ca",flexShrink:0,display:"block"}}/>{s}</div>))}
      </div>
    </div>
  );

  // ── EXAM RESULTS ──────────────────────────────────────────────────
  if(screen==="exam_results"&&examEvals){
    const totalPossible=examQs.reduce((s,q)=>s+(q.marksPerQ||1),0);
    const total=examEvals.reduce((s,e,i)=>s+(e.score||0)*(examQs[i]?.marksPerQ||1),0);
    const pct=Math.round((total/totalPossible)*100);
    const passed=pct>=50,excellent=pct>=90;
    const theme=excellent?{bg:"linear-gradient(145deg,#052e16,#16a34a)",icon:"trophy",title:t.excellentTitle,msg:t.excellentMsg}:passed?{bg:"linear-gradient(145deg,#451a03,#b45309)",icon:"target",title:t.passTitle,msg:t.passMsg}:{bg:"linear-gradient(145deg,#1c0f0f,#b91c1c)",icon:"notes",title:t.failTitle,msg:t.failMsg};
    return (
      <div style={Sb.root}><style>{CSS}</style>
      <AdBanners isPro={isPro}/>
      {upgraded && <div style={{position:"fixed",top:0,left:0,right:0,zIndex:800,background:"#16a34a",color:"#fff",textAlign:"center",padding:"11px 14px",fontSize:14,fontWeight:700,fontFamily:"inherit",boxShadow:"0 2px 12px rgba(0,0,0,0.25)"}}>{t.welcomePro}</div>}
        {showConfetti&&<Confetti/>}
        <div style={{background:theme.bg,padding:"40px 20px 32px",textAlign:"center"}}>
          <div style={{marginBottom:10,display:"flex",justifyContent:"center"}}><Icon name={theme.icon} size={50} stroke={1.7} style={{color:"#fff"}}/></div>
          <h2 style={{margin:"0 0 8px",fontSize:24,fontWeight:700,color:"#fff",fontFamily:"'Fraunces',Georgia,serif"}}>{theme.title}</h2>
          <div style={{fontSize:52,fontWeight:900,color:"#fff",letterSpacing:-2,fontFamily:"'Fraunces',Georgia,serif"}}>{pct}%</div>
          <div style={{fontSize:13,color:"rgba(255,255,255,0.7)",marginTop:4}}>
            {(Math.round(total*10)/10)+" / "+totalPossible+(examMode==="custom"?" "+t.marksSuffix:" "+t.ptsSuffix)} · {t.passMark}
          </div>
          {excellent&&<div style={{marginTop:14,display:"flex",justifyContent:"center",gap:12}}><Icon name="spark" size={22} style={{color:"#fff"}}/><Icon name="cap" size={24} style={{color:"#fff"}}/><Icon name="spark" size={22} style={{color:"#fff"}}/></div>}
          <p style={{margin:"14px 0 0",fontSize:14,color:"rgba(255,255,255,0.88)",lineHeight:1.6,maxWidth:300,marginLeft:"auto",marginRight:"auto"}}>{theme.msg}</p>
        </div>
        <div className="rv-center" style={{padding:"20px 16px"}}>
          {srsAdded>0 && (
            <div style={{display:"flex",alignItems:"center",gap:10,background:"var(--color-sel-tint)",border:"1px solid #c7d2fe",borderRadius:12,padding:"11px 14px",marginBottom:16}}>
              <Icon name="repeat" size={18} style={{color:"var(--color-accent)",flexShrink:0}}/>
              <span style={{flex:1,fontSize:12.5,color:"var(--color-accent)",lineHeight:1.4}}>{t.srsAddedMsg.replace("{n}",srsAdded).replace("{s}",srsAdded>1?"s":"")}</span>
              <button onClick={startReview} style={{flexShrink:0,background:"#4338ca",color:"#fff",border:"none",borderRadius:9,padding:"7px 12px",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>{t.srsReview}</button>
            </div>
          )}
          <div style={{display:"flex",gap:10,marginBottom:18}}>
            {[{v:(Math.round(total*10)/10)+"/"+totalPossible,l:t.examScore},{v:pct+"%",l:t.scoreLbl},{v:passed?t.passLbl:t.failLbl,l:t.resultLbl}].map(({v,l},i)=>(
              <div key={i} style={{flex:1,background:"var(--color-background-primary)",borderRadius:10,padding:"12px 6px",textAlign:"center",border:"0.5px solid var(--color-border-tertiary)"}}>
                <div style={{fontSize:15,fontWeight:700,color:i===2?(passed?"#16a34a":"#dc2626"):"var(--color-text-primary)"}}>{v}</div>
                <div style={{fontSize:10,color:"var(--color-text-secondary)",marginTop:2}}>{l}</div>
              </div>
            ))}
          </div>
          {(examTimeUsedSec!=null || examTimerOn) && (
            <div style={{display:"flex",gap:10,marginBottom:18}}>
              {[
                {v: examTimeExpired ? t.timeExpiredLbl : (examTimeUsedSec!=null ? Math.floor(examTimeUsedSec/60)+" min "+(examTimeUsedSec%60)+" sec" : ", "), l:t.timeUsedLbl, red:examTimeExpired},
                {v: examAnsweredCount+" / "+examQs.length, l:t.answeredLbl},
              ].map(({v,l,red},i)=>(
                <div key={i} style={{flex:1,background:"var(--color-background-primary)",borderRadius:10,padding:"12px 6px",textAlign:"center",border:"0.5px solid var(--color-border-tertiary)"}}>
                  <div style={{fontSize:14,fontWeight:700,color:red?"#dc2626":"var(--color-text-primary)"}}>{v}</div>
                  <div style={{fontSize:10,color:"var(--color-text-secondary)",marginTop:2}}>{l}</div>
                </div>
              ))}
            </div>
          )}
          {examMode==="custom"&&examSections.length>1&&(
            <div style={{background:"var(--color-background-primary)",borderRadius:12,border:"0.5px solid var(--color-border-tertiary)",marginBottom:16,overflow:"hidden"}}>
              <div style={{padding:"10px 14px",borderBottom:"0.5px solid var(--color-border-tertiary)",fontSize:11,fontWeight:700,color:"var(--color-text-secondary)",letterSpacing:1}}>{t.sectionBreakdown}</div>
              {examSections.map((sec,si)=>{
                const secQs=examQs.map((q,i)=>({q,i})).filter(({q})=>q.section===si+1);
                const earned=secQs.reduce((s,{q,i})=>s+(examEvals?.[i]?.score||0)*(q.marksPerQ||1),0);
                const possible=secQs.reduce((s,{q})=>s+(q.marksPerQ||1),0);
                const secPct=possible>0?Math.round((earned/possible)*100):0;
                const col=secPct>=90?"#16a34a":secPct>=50?"#b45309":"#dc2626";
                return (
                  <div key={si} style={{display:"flex",alignItems:"center",padding:"10px 14px",borderBottom:si<examSections.length-1?"0.5px solid var(--color-border-tertiary)":undefined,gap:12}}>
                    <span style={{width:22,height:22,borderRadius:"50%",background:si%2===0?"var(--color-sel-tint)":"#fef3c7",color:si%2===0?"#4338ca":"#92400e",display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:700,flexShrink:0}}>{si+1}</span>
                    <div style={{flex:1}}>
                      <div style={{fontSize:12,fontWeight:600,color:"var(--color-text-primary)"}}>{t.sectionNum.replace("{n}",si+1)}: {sec.type==="mcq"?t.quizTypes.mcq:sec.type==="fill"?t.quizTypes.fill:t.writtenWord}</div>
                      <div style={{fontSize:11,color:"var(--color-text-secondary)"}}>{t.qsTimesMarks.replace("{n}",secQs.length).replace("{m}",sec.marksPerQ)}</div>
                    </div>
                    <div style={{textAlign:"right"}}>
                      <div style={{fontSize:14,fontWeight:700,color:col}}>{Math.round(earned*10)/10}/{possible}</div>
                      <div style={{fontSize:10,color:"var(--color-text-tertiary)"}}>{secPct}%</div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {planSession && (
            <div style={{display:"flex",alignItems:"center",gap:10,background:"linear-gradient(135deg,#4338ca,#6366f1)",borderRadius:12,padding:"11px 14px",marginBottom:16,color:"#fff"}}>
              <Icon name="compass" size={18} style={{color:"#fff",flexShrink:0}}/>
              <span style={{flex:1,fontSize:12.5,fontWeight:700,lineHeight:1.4}}>{t.coachComplete}</span>
              <button onClick={backToPlan} style={{flexShrink:0,background:"rgba(255,255,255,0.2)",color:"#fff",border:"none",borderRadius:9,padding:"7px 12px",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>{t.coachBackToPlan}</button>
            </div>
          )}
          <div style={{display:"flex",gap:10,marginBottom:20}}>
            <button style={{...Sb.btnPrimary,flex:1,margin:0}} onClick={()=>{setScreen("exam_setup");setExamQs([]);setExamAns({});setExamEvals(null);setShowConfetti(false);}}>{t.retakeExam}</button>
            <button style={{...Sb.btnOutline,flex:1}} onClick={()=>setScreen("upload")}>{t.newExam}</button>
          </div>
          <p style={Sb.secLabel}>{t.reviewed}</p>
          {examQs.map((q,i)=>{
            const ev=examEvals[i],sc=ev?.score||0;
            const col=sc>=0.9?"#16a34a":sc>=0.5?"#b45309":"#dc2626";
            const bg=sc>=0.9?"#f0fdf4":sc>=0.5?"#fffbeb":"#fef2f2";
            const bdr=sc>=0.9?"#86efac":sc>=0.5?"#fde68a":"#fca5a5";
            return (
              <div key={i} style={{background:"var(--color-background-primary)",borderRadius:10,padding:"13px 13px 13px 10px",marginBottom:10,border:"0.5px solid var(--color-border-tertiary)",borderLeft:"3px solid "+col}} className="fade-in">
                <div style={{display:"flex",gap:8,alignItems:"flex-start",marginBottom:8}}>
                  <span style={{fontSize:9,fontWeight:700,background:q.type==="mcq"?"var(--color-sel-tint)":"#fef3c7",color:q.type==="mcq"?"#4338ca":"#92400e",borderRadius:8,padding:"2px 6px",flexShrink:0,marginTop:2}}>{q.type==="mcq"?t.badgeMcq:q.type==="fill"?t.badgeFill:t.badgeWritten}</span>
                  <span style={{fontSize:14,fontWeight:600,color:"var(--color-text-primary)",lineHeight:1.4,flex:1}}>{q.question}</span>
                </div>
                {q.type==="mcq"&&examAns[i]!==undefined&&(
                  <div style={{paddingLeft:8,marginBottom:4}}>
                    {examAns[i]!==q.correct&&<div style={{fontSize:12,color:"#dc2626",marginBottom:2}}>{t.yourAns} {q.options[examAns[i]]}</div>}
                    <div style={{fontSize:12,color:"#16a34a",fontWeight:500}}>{t.correctAns} {q.options[q.correct]}</div>
                  </div>
                )}
                {q.type!=="mcq"&&(
                  <div style={{paddingLeft:8,marginBottom:4}}>
                    <div style={{fontSize:12,color:"var(--color-text-secondary)",marginBottom:3,fontStyle:"italic"}}>{t.yourAns} "{examAns[i]||t.noAnswerLbl}"</div>
                    <div style={{fontSize:12,color:"#16a34a",fontWeight:500}}>{t.modelLabel} {q.answer}</div>
                  </div>
                )}
                {ev?.feedback&&<div style={{background:bg,border:"0.5px solid "+bdr,borderRadius:8,padding:"7px 10px",fontSize:12,color:col,marginTop:6,lineHeight:1.5}}>{ev.feedback}</div>}
                {q.explanation&&<div style={{fontSize:12,color:"var(--color-text-secondary)",lineHeight:1.5,paddingTop:6,borderTop:"0.5px solid var(--color-border-tertiary)",marginTop:6}}>{q.explanation}</div>}
                {sc<1&&<div style={{marginLeft:-8}}><ExplainBox t={t} ctx={{question:q.question,correct:q.type==="mcq"?(q.options?.[q.correct]??""):(q.answer||""),picked:q.type==="mcq"?(q.options?.[examAns[i]]??""):(examAns[i]||""),subject:""}}/></div>}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // ── PLAN SETUP (AI Study Coach) ───────────────────────────────────
  if (screen==="plan_setup") return (
    <div style={Sb.root}><style>{CSS}</style>
      <AdBanners isPro={isPro}/>
      <div style={Sb.topbar} className="rv-topbar">
        <button style={Sb.backBtn} onClick={()=>setScreen(homePlan?"plan":"home")}>← {homePlan?t.coachYourPlan:t.homeWord}</button>
        <span style={Sb.brand}>{t.coachTitle}</span>
        <span/>
      </div>
      <div className="rv-center-narrow" style={{padding:"22px 16px 40px"}}>
        <h2 style={Sb.h2}>{t.coachSetupTitle}</h2>
        <p style={{fontSize:13,color:"var(--color-text-secondary)",lineHeight:1.55,margin:"-6px 0 18px"}}>{t.coachSetupSub}</p>

        <label style={Sb.coachLabel}>{t.coachName}</label>
        <input value={planForm.title} onChange={e=>setPlanForm(f=>({...f,title:e.target.value}))} placeholder={t.coachNamePh} style={Sb.coachInput}/>

        <label style={Sb.coachLabel}>{t.coachDate}</label>
        <input type="date" value={planForm.testDate} min={new Date().toISOString().slice(0,10)} onChange={e=>setPlanForm(f=>({...f,testDate:e.target.value}))} style={{...Sb.coachInput,colorScheme:"light"}}/>

        <label style={Sb.coachLabel}>{t.coachChapters}</label>
        <input type="number" inputMode="numeric" min={1} max={60} value={planForm.chapters} onChange={e=>setPlanForm(f=>({...f,chapters:e.target.value.replace(/[^0-9]/g,"").slice(0,2)}))} placeholder={t.coachChaptersPh} style={Sb.coachInput}/>

        <label style={Sb.coachLabel}>{t.coachChapterNames}</label>
        <textarea value={planForm.chapterNames} onChange={e=>setPlanForm(f=>({...f,chapterNames:e.target.value}))} placeholder={t.coachChapterNamesPh} style={{...Sb.coachInput,height:90,resize:"vertical",lineHeight:1.5}}/>
        <div style={{fontSize:11,color:"var(--color-text-tertiary)",margin:"-6px 0 16px",lineHeight:1.5}}>{t.coachChapterNamesHint}</div>

        <label style={Sb.coachLabel}>{t.coachMode}</label>
        <div style={{display:"flex",flexDirection:"column",gap:8,marginBottom:16}}>
          {[["selfpaced",t.coachModeSelf,t.coachModeSelfDesc],["remind",t.coachModeRemind,t.coachModeRemindDesc]].map(([v,lbl,desc])=>(
            <button key={v} onClick={()=>setPlanForm(f=>({...f,mode:v}))} style={{textAlign:"left",display:"flex",gap:10,alignItems:"flex-start",padding:"12px 14px",borderRadius:12,border:"1.5px solid "+(planForm.mode===v?"#4338ca":"var(--color-border-secondary)"),background:planForm.mode===v?"var(--color-sel-tint)":"var(--color-background-primary)",cursor:"pointer",fontFamily:"inherit"}}>
              <span style={{width:18,height:18,borderRadius:"50%",border:"2px solid "+(planForm.mode===v?"#4338ca":"var(--color-border-secondary)"),flexShrink:0,marginTop:1,background:planForm.mode===v?"#4338ca":"transparent",boxShadow:planForm.mode===v?"inset 0 0 0 2px var(--color-background-primary)":"none"}}/>
              <span style={{flex:1}}>
                <span style={{display:"block",fontSize:13.5,fontWeight:700,color:"var(--color-text-primary)"}}>{lbl}</span>
                <span style={{display:"block",fontSize:11.5,color:"var(--color-text-secondary)",marginTop:2,lineHeight:1.45}}>{desc}</span>
              </span>
            </button>
          ))}
        </div>
        {planForm.mode==="remind" && (
          <div style={{marginBottom:16}}>
            <label style={Sb.coachLabel}>{t.coachReminderTime}</label>
            <input type="time" value={planForm.reminderTime} onChange={e=>setPlanForm(f=>({...f,reminderTime:e.target.value}))} style={{...Sb.coachInput,marginBottom:8,colorScheme:"light"}}/>
            <div style={{fontSize:11,color:"var(--color-text-tertiary)",lineHeight:1.5,marginBottom:8}}>{t.coachReminderNote}</div>
            <button onClick={enableReminders} disabled={notifPerm==="granted"||notifPerm==="unsupported"} style={{...Sb.btnGhost,width:"100%",fontSize:12.5,opacity:(notifPerm==="granted"||notifPerm==="unsupported")?0.6:1}}>{notifPerm==="granted"?t.coachNotifOn:t.coachEnableNotif}</button>
          </div>
        )}

        <div style={{background:isPro?"#fffbeb":"var(--color-background-secondary)",border:"0.5px solid "+(isPro?"#f59e0b44":"var(--color-border-tertiary)"),borderRadius:10,padding:"10px 14px",fontSize:12,color:isPro?"#92400e":"var(--color-text-secondary)",lineHeight:1.5,marginBottom:14}}>
          {isPro ? ("✦ "+t.coachTierPro) : t.coachTierFree}
        </div>
        {planErr && <div style={{display:"flex",alignItems:"center",gap:8,background:"#fef2f2",border:"0.5px solid #fecaca",borderRadius:10,padding:"10px 14px",fontSize:13,color:"#b91c1c",marginBottom:14}}><Icon name="alert" size={15} style={{flexShrink:0}}/><span>{planErr}</span></div>}
        <button style={{...Sb.btnPrimary,width:"100%"}} onClick={buildAndSavePlan}><span style={{display:"inline-flex",alignItems:"center",gap:8}}><Icon name="compass" size={16}/>{t.coachBuild}</span></button>
      </div>
    </div>
  );

  // ── PLAN DETAIL (schedule) ────────────────────────────────────────
  if (screen==="plan" && activePlan) {
    const prog = planProgress(activePlan);
    const nd = nextDayIndex(activePlan);
    const dte = Math.max(0, Math.ceil((new Date(activePlan.testDate+"T00:00:00").getTime() - Date.now())/86400000));
    const countdown = dte===0 ? t.coachExamToday : t.coachExamIn.replace("{n}",dte).replace("{s}",dte===1?"":"s");
    const KIND = { learn:t.coachKindLearn, review:t.coachKindReview, final:t.coachKindFinal };
    const rd = computeReadiness({ cards:srs.cards, stats, plan:activePlan });
    const focus = weakTopics(srs.cards);
    return (
      <div style={Sb.root}><style>{CSS}</style>
        <AdBanners isPro={isPro}/>
        <div style={Sb.topbar} className="rv-topbar">
          <button style={Sb.backBtn} onClick={()=>setScreen("home")}>← {t.homeWord}</button>
          <span style={Sb.brand}>{t.coachTitle}</span>
          <button onClick={openPlanSetup} title={t.coachCreate} style={{background:"none",border:"none",fontSize:20,lineHeight:1,cursor:"pointer",color:"var(--color-text-secondary)",padding:0,fontWeight:400}}>＋</button>
        </div>
        <div style={{background:"#2c2870",padding:"22px 20px 20px"}}>
          <div style={{fontSize:11,fontWeight:700,letterSpacing:1,color:"rgba(255,255,255,0.7)",textTransform:"uppercase",marginBottom:4}}>{t.coachYourPlan}</div>
          <h2 style={{margin:0,fontSize:21,fontWeight:700,color:"#fff",fontFamily:"'Fraunces',Georgia,serif"}}>{activePlan.title}</h2>
          <div style={{display:"flex",alignItems:"center",gap:10,marginTop:10,flexWrap:"wrap"}}>
            <span style={{display:"inline-flex",alignItems:"center",gap:5,fontSize:12,fontWeight:700,color:"#fff",background:"rgba(255,255,255,0.18)",borderRadius:20,padding:"4px 12px"}}><Icon name="target" size={13}/>{countdown}</span>
            <span style={{fontSize:12,color:"rgba(255,255,255,0.85)"}}>{t.coachProgressLbl.replace("{done}",prog.done).replace("{total}",prog.total)}</span>
          </div>
          <div style={{height:6,background:"rgba(255,255,255,0.2)",borderRadius:3,overflow:"hidden",marginTop:12}}>
            <div style={{height:"100%",width:prog.pct+"%",background:"#fff",borderRadius:3,transition:"width .3s"}}/>
          </div>
        </div>
        <div className="rv-center" style={{padding:"18px 16px 40px"}}>
          {activePlan.mode==="remind" && activePlan.reminderTime && (
            <div style={{display:"flex",alignItems:"center",gap:8,fontSize:12,color:"var(--color-text-secondary)",background:"var(--color-background-secondary)",border:"0.5px solid var(--color-border-tertiary)",borderRadius:10,padding:"9px 12px",marginBottom:14}}>
              <Icon name="clock" size={15} style={{flexShrink:0}}/> <span style={{flex:1}}>{t.coachReminderTime} <strong style={{color:"var(--color-text-primary)"}}>{activePlan.reminderTime}</strong></span>
              {notifPerm!=="granted" && notifPerm!=="unsupported" && <button onClick={enableReminders} style={{background:"none",border:"none",color:"var(--color-accent)",fontWeight:700,fontSize:11.5,cursor:"pointer",fontFamily:"inherit",padding:0}}>{t.coachEnableNotif}</button>}
            </div>
          )}
          {rd.score!=null && (
            <div style={{background:"var(--color-background-primary)",border:"0.5px solid var(--color-border-tertiary)",borderRadius:12,padding:"14px 16px",marginBottom:14}}>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
                <span style={{fontSize:12,fontWeight:700,color:"var(--color-text-secondary)",letterSpacing:0.3}}>{t.readinessTitle}</span>
                <span style={{fontSize:12,fontWeight:700,color:rd.score>=75?"#16a34a":rd.score>=45?"#b45309":"#dc2626"}}>{rd.label}</span>
              </div>
              <div style={{display:"flex",alignItems:"center",gap:12}}>
                <span style={{fontSize:30,fontWeight:800,color:"var(--color-text-primary)",fontFamily:"'Fraunces',Georgia,serif",minWidth:58}}>{rd.score}%</span>
                <div style={{flex:1,height:8,background:"var(--color-background-tertiary)",borderRadius:4,overflow:"hidden"}}>
                  <div style={{height:"100%",width:rd.score+"%",background:rd.score>=75?"#16a34a":rd.score>=45?"#f59e0b":"#ef4444",borderRadius:4,transition:"width .4s"}}/>
                </div>
              </div>
              {focus.length>0 && (
                <div style={{marginTop:12,paddingTop:12,borderTop:"0.5px solid var(--color-border-tertiary)"}}>
                  <div style={{fontSize:11,fontWeight:700,color:"var(--color-text-tertiary)",marginBottom:6}}>{t.focusAreas}</div>
                  <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
                    {focus.map((x,i)=><span key={i} style={{fontSize:11,fontWeight:600,background:"#fff7ed",color:"#9a3412",border:"0.5px solid #fed7aa",borderRadius:8,padding:"3px 9px"}}>{x.label}</span>)}
                  </div>
                </div>
              )}
            </div>
          )}
          {activePlan.days.map((day,i)=>{
            const st = dayState(day);
            const isNext = i===nd;
            const pctScore = (day.status==="done" && day.total) ? Math.round((day.score/day.total)*100) : null;
            const stColor = st==="done"?"#16a34a":st==="today"?"#4338ca":st==="missed"?"#b45309":"var(--color-text-tertiary)";
            const stLabel = st==="done"?t.coachDayDone:st==="today"?t.coachDayToday:st==="missed"?t.coachDayMissed:t.coachDayUpcoming;
            const dObj = new Date(day.date+"T00:00:00");
            return (
              <div key={i} style={{background:"var(--color-background-primary)",borderRadius:12,padding:"12px 14px",marginBottom:10,border:"0.5px solid var(--color-border-tertiary)",borderLeft:"3px solid "+stColor,opacity:st==="upcoming"?0.92:1}}>
                <div style={{display:"flex",alignItems:"center",gap:10}}>
                  <div style={{width:36,height:38,borderRadius:9,background:st==="done"?"var(--color-background-success)":"var(--color-background-secondary)",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                    <span style={{fontSize:9,fontWeight:700,color:"var(--color-text-tertiary)",lineHeight:1,textTransform:"uppercase"}}>{dObj.toLocaleDateString(undefined,{weekday:"short"})}</span>
                    <span style={{fontSize:14,fontWeight:800,color:"var(--color-text-primary)",lineHeight:1.15}}>{dObj.getDate()}</span>
                  </div>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:13.5,fontWeight:700,color:"var(--color-text-primary)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{st==="done"&&"✓ "}{day.label}</div>
                    <div style={{display:"flex",alignItems:"center",gap:6,marginTop:3,flexWrap:"wrap"}}>
                      <span style={{fontSize:9.5,fontWeight:700,letterSpacing:0.3,background:"var(--color-sel-tint)",color:"var(--color-accent)",borderRadius:7,padding:"2px 6px"}}>{KIND[day.kind]||day.kind}</span>
                      <span style={{fontSize:10.5,color:"var(--color-text-secondary)"}}>{day.format==="exam"?t.coachExamFormat:(t.quizTypes?.[day.format]||day.format)} · {day.numQ} Qs</span>
                      {pctScore!=null && <span style={{fontSize:10.5,fontWeight:700,color:"#16a34a"}}>· {t.coachScored.replace("{pct}",pctScore)}</span>}
                    </div>
                  </div>
                  <span style={{flexShrink:0,fontSize:9.5,fontWeight:700,color:stColor}}>{stLabel}</span>
                </div>
                <div style={{display:"flex",gap:8,marginTop:10}}>
                  {day.status==="done"
                    ? <button onClick={()=>setPlanDayStatus(activePlan.id,i,"pending")} style={{flex:1,background:"var(--color-background-secondary)",color:"var(--color-text-secondary)",border:"0.5px solid var(--color-border-secondary)",borderRadius:9,padding:"8px",fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>↻ {t.coachRedo}</button>
                    : <>
                        <button onClick={()=>startPlanDay(activePlan,i)} style={{flex:2,background:isNext?"#4338ca":"var(--color-background-secondary)",color:isNext?"#fff":"var(--color-text-primary)",border:isNext?"none":"0.5px solid var(--color-border-secondary)",borderRadius:9,padding:"8px",fontSize:12.5,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>▶ {t.coachStart}</button>
                        <button onClick={()=>setPlanDayStatus(activePlan.id,i,"done")} style={{flex:1,background:"none",color:"var(--color-text-secondary)",border:"0.5px solid var(--color-border-secondary)",borderRadius:9,padding:"8px",fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>✓ {t.coachMarkDone}</button>
                      </>}
                </div>
              </div>
            );
          })}
          {!confirmDelPlan
            ? <button onClick={()=>setConfirmDelPlan(true)} style={{...Sb.btnGhost,width:"100%",marginTop:8,color:"#dc2626"}}>{t.coachDelete}</button>
            : <div style={{background:"#fef2f2",border:"0.5px solid #fecaca",borderRadius:12,padding:"12px 14px",marginTop:8}}>
                <div style={{fontSize:12.5,color:"#b91c1c",marginBottom:10,lineHeight:1.5}}>{t.coachDeleteConfirm}</div>
                <div style={{display:"flex",gap:8}}>
                  <button onClick={()=>{deletePlan(activePlan.id);setConfirmDelPlan(false);setActivePlanId(null);setScreen("home");}} style={{flex:1,background:"#dc2626",color:"#fff",border:"none",borderRadius:9,padding:"9px",fontSize:12.5,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>{t.coachDeleteYes}</button>
                  <button onClick={()=>setConfirmDelPlan(false)} style={{...Sb.btnGhost,flex:1,padding:"9px"}}>{t.notNow||"Cancel"}</button>
                </div>
              </div>}
        </div>
      </div>
    );
  }

  // ── MOCK EXAMS: template picker ───────────────────────────────────
  if (screen==="mock_select") return (
    <div style={Sb.root}><style>{CSS}</style>
      <AdBanners isPro={isPro}/>
      <div style={Sb.topbar} className="rv-topbar">
        <button style={Sb.backBtn} onClick={()=>setScreen("upload")}>← {t.backWord}</button>
        <span style={Sb.brand}>{t.mockTitle}</span><span/>
      </div>
      <div className="rv-center-narrow" style={{padding:"22px 16px 40px"}}>
        <div style={{textAlign:"center",marginBottom:18}}>
          <div style={{marginBottom:8,display:"flex",justifyContent:"center",color:"var(--color-accent)"}}><Icon name="cap" size={34}/></div>
          <h2 style={{...Sb.h2,textAlign:"center",margin:"0 0 4px"}}>{t.mockChoose}</h2>
          <p style={{fontSize:12.5,color:"var(--color-text-secondary)",lineHeight:1.5}}>{t.mockSelectSub}</p>
        </div>
        {mockResume && (
          <div style={{background:"var(--color-background-primary)",border:"1px solid var(--color-accent)",borderRadius:14,padding:"14px 16px",marginBottom:16}}>
            <div style={{fontWeight:700,fontSize:14.5,color:"var(--color-text-primary)",marginBottom:2}}>{t.mockResumeTitle}</div>
            <div style={{fontSize:12,color:"var(--color-text-secondary)",marginBottom:12}}>{mockResume.name} · {t.mockSection} {(mockResume.secIdx||0)+1}/{mockResume.sectionsTotal||1}</div>
            <div style={{display:"flex",gap:8}}>
              <button onClick={resumeMock} style={{...Sb.btnPrimary,flex:1,margin:0}}>{t.mockResumeContinue}</button>
              <button onClick={discardMockResume} style={{...Sb.btnOutline,flex:1}}>{t.mockResumeStartOver}</button>
            </div>
          </div>
        )}
        {MOCK_EXAMS.map(exam=>(
          <div key={exam.id} onClick={()=>{setMockPresetId(exam.id);setMockGenErr("");setScreen("mock_intro");}}
            style={{display:"flex",alignItems:"center",gap:12,background:"var(--color-background-primary)",border:"0.5px solid var(--color-border-tertiary)",borderRadius:14,padding:"14px 16px",marginBottom:10,cursor:"pointer"}} className="exam-type-card">
            <div style={{width:46,height:46,borderRadius:11,background:"#2c2870",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,color:"#fff",fontWeight:800,fontSize:13,letterSpacing:0.2,fontFamily:"'Fraunces',Georgia,serif"}}>{exam.name.split("/")[0].slice(0,4)}</div>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontWeight:700,fontSize:15,color:"var(--color-text-primary)"}}>{exam.name}</div>
              <div style={{fontSize:11.5,color:"var(--color-text-secondary)",marginTop:1}}>{exam.blurb}</div>
              <div style={{fontSize:11,color:"var(--color-text-tertiary)",marginTop:2}}>{exam.note}</div>
            </div>
            <span style={{fontSize:20,color:"var(--color-text-tertiary)",flexShrink:0}}>›</span>
          </div>
        ))}
        <p style={{fontSize:11,color:"var(--color-text-tertiary)",textAlign:"center",marginTop:12,lineHeight:1.55}}>{t.mockNoPdf}</p>
      </div>
    </div>
  );

  // ── MOCK EXAM: intro ──────────────────────────────────────────────
  if (screen==="mock_intro") {
    const exam = getMock(mockPresetId) || MOCK_EXAMS[0];
    const totalMin = mockTotalMinutes(exam), totalQ = mockTotalQuestions(exam);
    return (
      <div style={Sb.root}><style>{CSS}</style>
        <AdBanners isPro={isPro}/>
        <div style={Sb.topbar} className="rv-topbar">
          <button style={Sb.backBtn} onClick={()=>setScreen("mock_select")}>← {t.backWord}</button>
          <span style={Sb.brand}>{t.mockTitle}</span><span/>
        </div>
        <div className="rv-center-narrow" style={{padding:"22px 16px 40px"}}>
          <div style={{textAlign:"center",marginBottom:18}}>
            <div style={{marginBottom:8,display:"flex",justifyContent:"center",color:"var(--color-accent)"}}><Icon name="cap" size={38}/></div>
            <h2 style={{...Sb.h2,textAlign:"center",margin:"0 0 4px"}}>{exam.name} {t.mockPracticeTest}</h2>
            <p style={{fontSize:12.5,color:"var(--color-text-secondary)"}}>{exam.note}</p>
          </div>
          <div style={Sb.settingsBox}>
            {exam.sections.map((s,i)=>(
              <div key={s.id} style={{...Sb.settingRow,borderBottom:"0.5px solid var(--color-border-tertiary)"}}>
                <span style={Sb.settingLabel}>{i+1}. {s.name}</span>
                <span style={{fontSize:12,color:"var(--color-text-secondary)"}}>{s.count} Qs · {s.minutes} min</span>
              </div>
            ))}
            <div style={{...Sb.settingRow,borderBottom:"none",background:"var(--color-background-secondary)"}}>
              <span style={Sb.settingLabel}>{t.mockTotal}</span>
              <span style={{fontSize:12,fontWeight:700,color:"var(--color-text-primary)"}}>{totalQ} Qs · {Math.floor(totalMin/60)}h {totalMin%60}m</span>
            </div>
          </div>
          {exam.adaptive && <div style={{display:"flex",alignItems:"flex-start",gap:8,background:"var(--color-sel-tint)",border:"0.5px solid #c7d2fe",borderRadius:10,padding:"11px 14px",fontSize:12,color:"var(--color-accent)",lineHeight:1.5,marginBottom:14}}><Icon name="spark" size={15} style={{flexShrink:0,marginTop:1}}/><span>{t.mockAdaptiveNote}</span></div>}
          <div style={{display:"flex",alignItems:"flex-start",gap:8,background:"#fffbeb",border:"0.5px solid #f59e0b44",borderRadius:10,padding:"11px 14px",fontSize:12,color:"#92400e",lineHeight:1.5,marginBottom:14}}><Icon name="clock" size={15} style={{flexShrink:0,marginTop:1}}/><span>{t.mockWarn}</span></div>
          {mockGenErr && <div style={{background:"#fef2f2",border:"0.5px solid #fecaca",borderRadius:10,padding:"10px 14px",fontSize:13,color:"#b91c1c",marginBottom:14,display:"flex",alignItems:"flex-start",gap:7}}><Icon name="alert" size={15} style={{flexShrink:0,marginTop:1}}/><span>{mockGenErr}</span></div>}
          {isPro
            ? <button style={{...Sb.btnPrimary,width:"100%",display:"inline-flex",alignItems:"center",justifyContent:"center",gap:8}} onClick={startMock}><Icon name="cap" size={17}/>{t.mockStart}</button>
            : <button style={{...Sb.btnPrimary,width:"100%",background:"#f59e0b",display:"inline-flex",alignItems:"center",justifyContent:"center",gap:8}} onClick={()=>{if(requireLogin())return;setShowProModal(true);}}><Icon name="spark" size={16}/>{t.mockProOnly}</button>}
          {isPro && usage && <p style={{fontSize:11,color:"var(--color-text-tertiary)",textAlign:"center",marginTop:8}}>{t.mockLeftLabel.replace("{n}",usage.mocks_remaining ?? 2).replace("{cap}",usage.mock_daily_cap ?? 2)}</p>}
          <p style={{fontSize:11,color:"var(--color-text-tertiary)",textAlign:"center",marginTop:12,lineHeight:1.5}}>{t.mockDisclaimer}</p>
        </div>
        {showProModal&&<ProModal onClose={()=>{setShowProModal(false);setCoErr("");}} t={t} onMonthly={()=>doCheckout(STRIPE_MONTHLY_PRICE,"monthly")} onYearly={()=>doCheckout(STRIPE_YEARLY_PRICE,"yearly")} busy={coBusy} error={coErr}/>}
      </div>
    );
  }

  // ── MOCK EXAM: generating ─────────────────────────────────────────
  if (screen==="mock_gen") return (
    <div style={{...Sb.root,alignItems:"center",justifyContent:"center",padding:"0 24px",textAlign:"center",minHeight:"100vh",display:"flex",flexDirection:"column"}}><style>{CSS}</style>
      <div className="spin-ring" style={{width:52,height:52,borderRadius:"50%",border:"4px solid var(--color-border-tertiary)",borderTopColor:"#4338ca"}}/>
      <h2 style={{...Sb.h2,textAlign:"center",marginTop:28}}>{t.mockBuilding}</h2>
      <p style={{marginTop:12,maxWidth:320,fontSize:13,lineHeight:1.55,color:"var(--color-text-secondary)"}}>{t.mockBuildingSub}</p>
    </div>
  );

  // ── MOCK EXAM: per-section timed runner ───────────────────────────
  if (screen==="mock_run" && mock) {
    const sec = mock.sections[mockSecIdx];
    const q = sec.questions[mockQIdx];
    const ans = mockAns[mockSecIdx] || [];
    const sel = ans[mockQIdx];
    const mm = Math.floor(mockSecTimeLeft/60), ss = mockSecTimeLeft%60;
    const low = mockSecTimeLeft <= 60;
    const answered = ans.filter(a=>a!=null).length;
    const pick = (i) => setMockAns(prev => { const n = prev.map(a=>[...a]); n[mockSecIdx][mockQIdx] = i; return n; });
    const hasPassage = !!(q && q._passage);
    const activeU = q && q._uIdx != null ? q._uIdx + 1 : null;
    const questionCol = (
      <div style={{flex:1,minWidth:0}}>
        <div style={{fontSize:12,color:"var(--color-text-secondary)",marginBottom:10}}>{t.question} {mockQIdx+1} {t.outOf} {sec.questions.length}</div>
        <h3 style={{fontFamily:"'Fraunces',Georgia,serif",fontSize:16.5,fontWeight:700,color:"var(--color-text-primary)",lineHeight:1.5,margin:0,whiteSpace:"pre-wrap"}}>{q.question}</h3>
        {q.svg && <div style={{margin:"14px 0 2px",display:"flex",justifyContent:"center"}}><img alt="Figure" src={"data:image/svg+xml;charset=utf-8,"+encodeURIComponent(q.svg)} style={{maxWidth:"100%",maxHeight:300,background:"#fff",borderRadius:10,border:"0.5px solid var(--color-border-tertiary)",padding:10,boxSizing:"border-box"}}/></div>}
        <div style={{display:"flex",flexDirection:"column",gap:9,marginTop:16}}>
          {q.options.map((opt,i)=>{
            const chosen = sel===i;
            return <button key={i} onClick={()=>pick(i)} style={{display:"flex",alignItems:"center",gap:12,background:chosen?"var(--color-sel-tint)":"var(--color-background-primary)",border:`1.5px solid ${chosen?"#4338ca":"var(--color-border-tertiary)"}`,borderRadius:12,padding:"12px 14px",cursor:"pointer",fontSize:14,color:"var(--color-text-primary)",fontFamily:"inherit",textAlign:"left"}}>
              <span style={{width:26,height:26,borderRadius:"50%",background:chosen?"#4338ca":"var(--color-background-secondary)",color:chosen?"#fff":"var(--color-text-primary)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,fontWeight:700,flexShrink:0}}>{LETTERS[i]}</span>
              <span style={{flex:1,lineHeight:1.4}}>{opt}</span>
            </button>;
          })}
        </div>
        <div style={{display:"flex",gap:10,marginTop:18}}>
          <button disabled={mockQIdx===0} onClick={()=>setMockQIdx(i=>Math.max(0,i-1))} style={{...Sb.btnOutline,flex:1,opacity:mockQIdx===0?0.4:1}}>← {t.prev}</button>
          {mockQIdx+1 < sec.questions.length
            ? <button onClick={()=>setMockQIdx(i=>i+1)} style={{...Sb.btnPrimary,flex:1,margin:0}}>{t.next}</button>
            : <button onClick={()=>setShowMockSubmit(true)} style={{...Sb.btnPrimary,flex:1,margin:0,background:"#16a34a"}}>{t.mockSubmitSection}</button>}
        </div>
        <button onClick={()=>setShowMockSubmit(true)} style={{...Sb.btnGhost,width:"100%",marginTop:12,fontSize:12}}>{t.mockEndSection} · {answered}/{sec.questions.length}</button>
      </div>
    );
    return (
      <div style={Sb.root}><style>{CSS}</style>
        <div style={Sb.topbar} className="rv-topbar">
          <span style={{fontSize:13,fontWeight:700,color:"var(--color-text-primary)"}}>{sec.name}</span>
          <span style={{fontSize:11,color:"var(--color-text-secondary)"}}>{t.mockSection} {mockSecIdx+1}/{mock.sections.length}</span>
          <span className={low?"rv-timer-flash":""} style={{fontSize:15,fontWeight:800,color:low?"#dc2626":"#4338ca",fontVariantNumeric:"tabular-nums"}}>{mm}:{String(ss).padStart(2,"0")}</span>
        </div>
        <PBar v={mockQIdx} max={sec.questions.length}/>
        <div className={hasPassage?"rv-center":"rv-center-narrow"} style={{padding:"16px 16px 32px"}}>
          {hasPassage
            ? <div className="rv-mock-split"><div className="rv-mock-passage"><MockPassagePanel passage={q._passage} svg={q._psvg} activeU={activeU} label={sec.name}/></div>{questionCol}</div>
            : questionCol}
        </div>
        {showMockSubmit && (
          <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.6)",zIndex:500,display:"flex",alignItems:"center",justifyContent:"center",padding:20}} onClick={()=>setShowMockSubmit(false)}>
            <div className="slide-up" onClick={e=>e.stopPropagation()} style={{background:"var(--color-background-primary)",borderRadius:16,padding:"22px 20px",maxWidth:360,width:"100%",boxSizing:"border-box"}}>
              <h3 style={{margin:"0 0 8px",fontSize:17,fontWeight:700,color:"var(--color-text-primary)"}}>{(t.mockSubmitConfirm||"Submit {s}?").replace("{s}",sec.name)}</h3>
              <p style={{margin:"0 0 16px",fontSize:13,color:"var(--color-text-secondary)",lineHeight:1.5}}>{t.mockSubmitWarn} {t.mockAnsweredCount?.replace("{a}",answered).replace("{n}",sec.questions.length) || `${answered}/${sec.questions.length} answered.`}</p>
              <div style={{display:"flex",gap:10}}>
                <button onClick={()=>setShowMockSubmit(false)} style={{...Sb.btnGhost,flex:1}}>{t.notNow||"Cancel"}</button>
                <button onClick={submitSection} style={{...Sb.btnPrimary,flex:1,margin:0,background:"#16a34a"}}>{t.mockSubmitSection}</button>
              </div>
            </div>
          </div>
        )}
        {mockPaused && <PauseOverlay onResume={()=>setMockPaused(false)}/>}
      </div>
    );
  }

  // ── MOCK EXAM: rest between sections ──────────────────────────────
  if (screen==="mock_break" && mock) {
    const next = mock.sections[mockSecIdx+1];
    return (
      <div style={Sb.root}><style>{CSS}</style>
        <div className="rv-center-narrow" style={{minHeight:"100vh",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",textAlign:"center",padding:"40px 20px"}}>
          <div style={{marginBottom:14,display:"flex",justifyContent:"center",color:"var(--color-accent)"}}><Icon name="pause" size={44} stroke={1.8}/></div>
          <h2 style={{...Sb.h2,margin:"0 0 6px"}}>{t.mockBreakTitle}</h2>
          <p style={{fontSize:14,color:"var(--color-text-secondary)",lineHeight:1.6,maxWidth:340,margin:"0 auto 6px"}}>{t.mockBreakSub}</p>
          <div style={{fontSize:12,color:"var(--color-text-tertiary)",marginBottom:24}}>{t.mockSectionDone.replace("{n}",mockSecIdx+1).replace("{total}",mock.sections.length)}</div>
          {next && (
            <div style={{background:"var(--color-background-primary)",border:"0.5px solid var(--color-border-tertiary)",borderRadius:14,padding:"16px 18px",maxWidth:360,width:"100%",boxSizing:"border-box",marginBottom:20}}>
              <div style={{fontSize:10.5,fontWeight:800,letterSpacing:0.8,color:"var(--color-text-tertiary)",textTransform:"uppercase",marginBottom:6}}>{t.mockUpNext}</div>
              <div style={{fontSize:18,fontWeight:700,color:"var(--color-text-primary)",fontFamily:"'Fraunces',Georgia,serif"}}>{next.name}</div>
              <div style={{fontSize:12.5,color:"var(--color-text-secondary)",marginTop:4}}>{next.count} {t.questionsLow} · {next.minutes} min</div>
            </div>
          )}
          {mockGenErr && <div style={{display:"flex",alignItems:"center",gap:8,background:"#fef2f2",border:"0.5px solid #fecaca",borderRadius:10,padding:"10px 14px",fontSize:13,color:"#b91c1c",marginBottom:14,maxWidth:360,width:"100%",boxSizing:"border-box"}}><Icon name="alert" size={15} style={{flexShrink:0}}/><span>{mockGenErr}</span></div>}
          <button onClick={startNextSection} style={{...Sb.btnPrimary,maxWidth:360,width:"100%",margin:0}}>{t.mockStartNext}</button>
        </div>
      </div>
    );
  }

  // ── MOCK EXAM: results ────────────────────────────────────────────
  if (screen==="mock_results" && mock) {
    const sc = scoreMock(mock, mockSecResults);
    return (
      <div style={Sb.root}><style>{CSS}</style>
        <AdBanners isPro={isPro}/>
        <div style={{background:"#2c2870",padding:"34px 20px 26px",textAlign:"center"}}>
          <div style={{fontSize:11,fontWeight:700,letterSpacing:1,color:"rgba(255,255,255,0.7)",textTransform:"uppercase"}}>{mock.name} {t.mockComposite}</div>
          <div style={{fontSize:58,fontWeight:800,color:"#fff",fontFamily:"'Fraunces',Georgia,serif",lineHeight:1.1}}>{sc.composite}</div>
          <div style={{fontSize:13,color:"rgba(255,255,255,0.7)"}}>{t.mockOutOf} {sc.compositeMax}</div>
          {sc.goodScore!=null && <div style={{fontSize:11.5,color:"rgba(255,255,255,0.55)",marginTop:6}}>{(t.mockGoodScore||"A strong score is around {n}+").replace("{n}",sc.goodScore)}</div>}
        </div>
        <div className="rv-center" style={{padding:"20px 16px 40px"}}>
          {/* Retake motivation: cheer an improvement, soften a dip. */}
          {mockPrev && (() => {
            const cur = sc.composite, prev = mockPrev.composite;
            const up = cur > prev, down = cur < prev;
            const bg = up?"#f0fdf4":down?"#fffbeb":"var(--color-sel-tint)";
            const bd = up?"#86efac":down?"#fcd34d":"#c7d2fe";
            const col = up?"#15803d":down?"#92400e":"var(--color-accent)";
            const msg = (up?t.mockImproved:down?t.mockWorse:t.mockSame).replace("{prev}",prev).replace("{cur}",cur);
            return (
              <div style={{display:"flex",alignItems:"center",gap:11,background:bg,border:`1px solid ${bd}`,borderRadius:12,padding:"13px 15px",marginBottom:16}}>
                <Icon name={up?"trophy":down?"flame":"target"} size={20} style={{color:col,flexShrink:0}}/>
                <span style={{flex:1,fontSize:13,fontWeight:600,color:col,lineHeight:1.45}}>{msg}</span>
              </div>
            );
          })()}
          <div style={Sb.settingsBox}>
            {sc.rows.map((r,i)=>(
              <div key={i} style={{...Sb.settingRow,borderBottom:(i<sc.rows.length-1||sc.extras.length)?"0.5px solid var(--color-border-tertiary)":"none"}}>
                <span style={Sb.settingLabel}>{r.name}</span>
                <span style={{fontSize:12.5,color:"var(--color-text-secondary)"}}>{r.raw}/{r.count} · <strong style={{color:"var(--color-text-primary)",fontSize:15}}>{r.scaled}</strong></span>
              </div>
            ))}
            {sc.extras.map((e,i)=>(
              <div key={"x"+i} style={{...Sb.settingRow,borderBottom:i<sc.extras.length-1?"0.5px solid var(--color-border-tertiary)":"none"}}>
                <span style={Sb.settingLabel}>{e.name}{e.band!=null?` · ${t.mockNotScored||"not in composite"}`:e.scaled!=null&&mock.id==="act"?` · ${t.mockNotScored||"not in composite"}`:""}</span>
                <span style={{fontSize:12.5,color:"var(--color-text-secondary)"}}>{e.raw}/{e.count} · <strong style={{color:"var(--color-text-primary)",fontSize:15}}>{e.band!=null?`${t.mockBand||"Band"} ${e.band}`:e.scaled}</strong></span>
              </div>
            ))}
          </div>
          <div style={{display:"flex",gap:10,marginBottom:16}}>
            <button style={{...Sb.btnPrimary,flex:1,margin:0}} onClick={()=>setScreen("mock_intro")}>{t.mockRetake}</button>
            <button style={{...Sb.btnOutline,flex:1}} onClick={()=>setScreen("upload")}>{t.newMat}</button>
          </div>
          <p style={Sb.secLabel}>{t.review}</p>
          {mock.sections.map((sec,si)=> sec.questions.length===0 ? null : (
            <div key={si}>
              <div style={{fontSize:12,fontWeight:700,color:"var(--color-text-secondary)",margin:"14px 0 8px",letterSpacing:0.3}}>{sec.name.toUpperCase()}</div>
              {sec.questions.map((q,i)=>{
                const chosen=(mockAns[si]||[])[i];
                const ok=chosen===q.correct;
                const newPassage = q._passage && (i===0 || q._pIdx !== sec.questions[i-1]?._pIdx);
                return <div key={i}>
                  {newPassage && <div style={{marginBottom:9}}><MockPassagePanel passage={q._passage} svg={q._psvg} label={sec.name}/></div>}
                  <div style={{background:"var(--color-background-primary)",borderRadius:10,padding:"12px 13px 12px 11px",marginBottom:9,border:"0.5px solid var(--color-border-tertiary)",borderLeft:`3px solid ${ok?"#22c55e":"#ef4444"}`}} className="fade-in">
                    <div style={{display:"flex",gap:8,alignItems:"flex-start"}}><span style={{flexShrink:0,display:"inline-flex",marginTop:1}}>{ok?<Icon name="check" size={15} stroke={2.6} style={{color:"#16a34a"}}/>:<Icon name="x" size={15} stroke={2.6} style={{color:"#dc2626"}}/>}</span><span style={{fontSize:13.5,fontWeight:600,color:"var(--color-text-primary)",lineHeight:1.4,whiteSpace:"pre-wrap"}}>{q.question}</span></div>
                    {q.svg && <div style={{margin:"10px 0 2px",paddingLeft:22,display:"flex"}}><img alt="Figure" src={"data:image/svg+xml;charset=utf-8,"+encodeURIComponent(q.svg)} style={{maxWidth:"100%",maxHeight:240,background:"#fff",borderRadius:10,border:"0.5px solid var(--color-border-tertiary)",padding:8,boxSizing:"border-box"}}/></div>}
                    {!ok&&<div style={{fontSize:12,color:"#dc2626",marginTop:5,paddingLeft:22}}>{t.yourAns} {chosen!=null?q.options[chosen]:", "}</div>}
                    <div style={{fontSize:12,color:"#16a34a",marginTop:3,paddingLeft:22,fontWeight:500}}>{t.correctAns} {q.options[q.correct]}</div>
                    {q.explanation&&<div style={{fontSize:12,color:"var(--color-text-secondary)",lineHeight:1.5,paddingTop:6,marginTop:6,borderTop:"0.5px solid var(--color-border-tertiary)",paddingLeft:22}}>{q.explanation}</div>}
                    {!ok&&<ExplainBox t={t} ctx={{question:q.question,correct:q.options[q.correct],picked:chosen!=null?q.options[chosen]:"",subject:sec.name}}/>}
                    <MockReport exam={mock.name} section={sec.name} question={q.question} t={t}/>
                  </div>
                </div>;
              })}
            </div>
          ))}
        </div>
      </div>
    );
  }

  return <SettingsPanel draft={settingsDraft} update={updateDraft} onApply={applySettings} onCancel={cancelSettings} onSignOut={()=>signOut()} onDeleteAccount={confirmDeleteAccount} requiresPassword={requiresPassword} onReauthenticate={reauthenticate} isPro={isPro} onManageSubscription={openPortal} signedIn={!!user} t={t}/>;
}

const Sb = {
  root:        { minHeight:"100vh", background:"var(--color-background-tertiary)", color:"var(--color-text-primary)", fontFamily:"'DM Sans','Helvetica Neue',sans-serif", display:"flex", flexDirection:"column" },
  brand:       { fontFamily:"'Fraunces',Georgia,serif", fontSize:16, fontWeight:700, color:"var(--color-text-primary)", letterSpacing:0.5, display:"flex", alignItems:"center", gap:8 },
  hero:        { background:"#2c2870", padding:"44px 24px 40px" },
  h1:          { fontFamily:"'Fraunces',Georgia,serif", fontSize:30, fontWeight:700, color:"#fff", lineHeight:1.2, margin:"14px 0 12px" },
  h2:          { fontFamily:"'Fraunces',Georgia,serif", fontSize:22, fontWeight:700, color:"var(--color-text-primary)", margin:"0 0 16px" },
  secLabel:    { fontSize:11, fontWeight:700, color:"var(--color-text-tertiary)", letterSpacing:1.5, margin:"0 0 12px", textTransform:"uppercase" },
  fCard:       { background:"var(--color-background-primary)", borderRadius:12, padding:"13px 12px", border:"0.5px solid var(--color-border-tertiary)", display:"flex", flexDirection:"column", gap:4, cursor:"default" },
  planCard:    { flex:1, background:"var(--color-background-primary)", borderRadius:12, padding:"14px 12px", border:"0.5px solid var(--color-border-tertiary)" },
  topbar:      { display:"flex", justifyContent:"space-between", alignItems:"center", padding:"12px 16px", background:"var(--color-background-primary)", borderBottom:"0.5px solid var(--color-border-tertiary)", position:"sticky", top:0, zIndex:10 },
  backBtn:     { background:"none", border:"none", cursor:"pointer", fontSize:13, color:"var(--color-text-secondary)", fontFamily:"inherit", padding:0, fontWeight:500 },
  dropzone:    { border:"1.5px dashed var(--color-border-secondary)", borderRadius:14, padding:"28px 20px", cursor:"pointer", background:"var(--color-background-primary)", textAlign:"center", marginBottom:14, transition:"all 0.2s", display:"flex", flexDirection:"column", alignItems:"center", gap:8 },
  textarea:    { width:"100%", height:180, borderRadius:12, border:"0.5px solid var(--color-border-secondary)", background:"var(--color-background-primary)", color:"var(--color-text-primary)", fontSize:14, padding:"13px 14px", resize:"vertical", fontFamily:"inherit", outline:"none", marginBottom:14, boxSizing:"border-box", lineHeight:1.6 },
  settingsBox: { background:"var(--color-background-primary)", borderRadius:12, border:"0.5px solid var(--color-border-tertiary)", marginBottom:14, overflow:"hidden" },
  settingRow:  { display:"flex", alignItems:"center", justifyContent:"space-between", padding:"11px 14px", borderBottom:"0.5px solid var(--color-border-tertiary)", gap:10, flexWrap:"wrap" },
  settingLabel:{ fontSize:13, fontWeight:600, color:"var(--color-text-primary)", flexShrink:0 },
  langSel:     { background:"var(--color-background-secondary)", border:"0.5px solid var(--color-border-secondary)", borderRadius:8, padding:"5px 8px", fontSize:12, color:"var(--color-text-primary)", cursor:"pointer", fontFamily:"inherit", outline:"none" },
  btnPrimary:  { background:"#4338ca", color:"#fff", border:"none", borderRadius:12, padding:"13px 20px", fontSize:15, fontWeight:600, cursor:"pointer", fontFamily:"'Fraunces',Georgia,serif", transition:"opacity 0.15s", margin:0 },
  btnHero:     { background:"#fff", color:"#2c2870", border:"none", borderRadius:12, padding:"13px 30px", fontSize:15, fontWeight:700, cursor:"pointer", fontFamily:"inherit" },
  btnOutline:  { background:"none", color:"var(--color-text-primary)", border:"1px solid var(--color-border-secondary)", borderRadius:12, padding:"12px 20px", fontSize:13, fontWeight:500, cursor:"pointer", fontFamily:"inherit" },
  btnGhost:    { background:"none", color:"var(--color-text-secondary)", border:"0.5px solid var(--color-border-tertiary)", borderRadius:12, padding:"11px 20px", fontSize:13, cursor:"pointer", fontFamily:"inherit" },
  coachLabel:  { display:"block", fontSize:12, fontWeight:700, color:"var(--color-text-secondary)", margin:"0 0 6px", letterSpacing:0.2 },
  coachInput:  { width:"100%", borderRadius:10, border:"1.5px solid var(--color-border-secondary)", background:"var(--color-background-primary)", color:"var(--color-text-primary)", fontSize:14, padding:"11px 13px", fontFamily:"inherit", outline:"none", boxSizing:"border-box", marginBottom:14 },
};

const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600;9..144,700&family=DM+Sans:wght@400;500;600&display=swap');
  *{box-sizing:border-box} body{margin:0}
  /* Small-font zoom (body{zoom:0.9}) leaves a gap below the app; painting html
     with the theme colour stops a white rectangle showing through there. */
  html,body{background:var(--color-background-tertiary)}
  /* Mock passage layout: passage stacks above the question on narrow screens,
     sits beside it (sticky) on wide ones, so it stays put across its questions. */
  .rv-mock-split{display:flex;flex-direction:column;gap:16px;align-items:stretch}
  .rv-mock-passage{width:100%}
  @media(min-width:900px){
    .rv-mock-split{flex-direction:row;align-items:flex-start;gap:24px}
    .rv-mock-passage{flex:1.15;position:sticky;top:64px;max-height:calc(100vh - 96px);overflow-y:auto}
  }
  .fade-in {animation:fadeIn 0.3s ease both}
  .slide-up{animation:slideUp 0.25s ease both}
  @keyframes fadeIn {from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
  @keyframes slideUp{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}
  @keyframes spin{to{transform:rotate(360deg)}}
  .spin-ring{animation:spin 0.9s linear infinite}
  .step{animation:fadeIn 0.4s ease forwards;opacity:0}
  .step-0{animation-delay:0.3s}.step-1{animation-delay:0.8s}.step-2{animation-delay:1.3s}.step-3{animation-delay:1.8s}
  .exam-type-card:hover{transform:translateY(-2px);box-shadow:0 4px 16px rgba(67,56,202,0.18)!important;border-color:#4338ca!important;background:var(--color-hover-tint)!important}
  button:hover:not(:disabled){transform:translateY(-1px)}
  button:active:not(:disabled){transform:scale(0.97)}
  .quiz-opt:hover:not(:disabled){transform:translateX(4px)!important;border-color:#4338ca!important;background:var(--color-hover-tint)!important;box-shadow:2px 0 0 0 #4338ca}
  .quiz-opt:active:not(:disabled){transform:translateX(2px)!important}
  textarea:focus,input:focus{border-color:#4338ca!important;box-shadow:0 0 0 2px #4338ca20}
  select{appearance:auto}
  .no-anim *{animation:none!important;transition:none!important}
  @keyframes slideFromRight{from{transform:translateX(100%)}to{transform:translateX(0)}}
  @keyframes rvTimerFlash{0%,100%{opacity:1}50%{opacity:0.25}}
  .rv-timer-flash{animation:rvTimerFlash 1s steps(1) infinite}
  @keyframes rvAutoBar{from{width:0%}to{width:100%}}
  .settings-panel{animation:slideFromRight 0.22s ease}
  ::-webkit-scrollbar{width:4px}::-webkit-scrollbar-thumb{background:var(--color-border-secondary);border-radius:2px}

  /* Hero (mobile base, stacks: back, brand bar, headline, sub, CTA) */
  .rv-hero-bar{display:flex;align-items:center;justify-content:space-between;gap:12px;}
  .rv-hero-tools{display:flex;align-items:center;gap:10px;}
  .rv-hero-sub{margin-top:14px!important;}
  .rv-hero-cta{margin-top:22px;}

  /* ── Desktop layout ────────────────────────────────────────────── */
  @media(min-width:768px){
    /* Root: wider centered card */
    .rv-root-inner{max-width:900px;margin:0 auto;width:100%;}

    /* Hero: two-column editorial layout, brand+sub on the left, headline+CTA
       on the right (back link spans the top). */
    .rv-hero-inner{
      max-width:900px;margin:0 auto;
      display:grid;grid-template-columns:1fr 1.05fr;
      grid-template-areas:"back back" "bar head" "sub cta";
      column-gap:48px;row-gap:20px;align-items:start;
    }
    .rv-hero-back{grid-area:back;margin-bottom:0!important;}
    .rv-hero-bar{grid-area:bar;}
    .rv-hero-head{grid-area:head;align-self:start;font-size:40px!important;margin:0!important;}
    .rv-hero-sub{grid-area:sub;align-self:end;}
    .rv-hero-cta{grid-area:cta;align-self:end;justify-self:start;}

    /* Home body: wider, 3-col features grid */
    .rv-home-body{max-width:900px;margin:0 auto;padding:40px 48px!important;}
    .rv-home-body .rv-feat-grid{grid-template-columns:repeat(3,1fr)!important;}
    .rv-plans-row{gap:16px!important;}

    /* Topbar full width with more breathing room */
    .rv-topbar{padding:12px 40px!important;}

    /* Upload: left=file input, right=settings */
    .rv-upload-body{display:grid;grid-template-columns:1fr 1fr;gap:0 36px;padding:28px 40px!important;max-width:1100px;margin:0 auto;align-items:start;}
    .rv-ul-right{padding-top:4px;}

    /* Quiz / Results / Loading / Exam: centered wider */
    .rv-center{max-width:800px;margin:0 auto;width:100%;padding:32px 40px!important;}
    .rv-center-narrow{max-width:680px;margin:0 auto;width:100%;padding:32px 40px!important;}
    .rv-exam-body{max-width:960px;margin:0 auto;width:100%;padding:28px 40px!important;}
  }
`;
