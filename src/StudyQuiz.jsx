import { useState, useRef, useCallback, useEffect } from "react";
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
import { computeReadiness, weakTopics } from "./lib/insights.js";
import { MOCK_EXAMS, getMock, mockTotalMinutes, mockTotalQuestions, scaledScore, compositeScore, compositeMax } from "./lib/mockExams.js";

// ── Limits ────────────────────────────────────────────────────────────
const FREE_MAX_Q   = 20;
const AD_MAX_Q     = 50;
const PRO_MAX_Q    = 100;
const FREE_FILE_MB = 5;
const AD_FILE_MB   = 10;
const PRO_FILE_MB  = 999;
const AD_HOURS     = 1;
const FREE_DAILY   = 50;  // free daily QUESTION allowance (shown in plan lists)
const Q_FREE       = [5, 10, 15, 20];
const Q_EXTRA      = [25, 30, 40, 50];
const QUIZ_TYPES   = ["mcq","cards","fill","match"];
const LETTERS      = ["A","B","C","D","E","F"];
// Model for all generation/grading. Haiku 4.5: cheap + fast, plenty for
// question writing. ($0.80/1M in, $4/1M out vs Sonnet's $3/$15.)
const AI_MODEL     = "claude-haiku-4-5-20251001";
// Difficulty rubric (index 0/1/2 = Easy/Medium/Hard). The label alone barely
// moves the model — the per-level guidance is what actually changes output.
const DIFFICULTY = [
  { name:"Easy",   guide:"Test basic recall and core definitions. Single concept per question, plain wording. For multiple choice, distractors should be clearly wrong." },
  { name:"Medium", guide:"Test understanding and application. Require connecting ideas or one reasoning step. For multiple choice, distractors should be plausible and require thought." },
  { name:"Hard",   guide:"Test analysis, synthesis, and edge cases. Require multi-step reasoning or distinguishing subtle differences. For multiple choice, distractors should be very close and tricky. Avoid trivially-recalled facts." },
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
// implemented — Android phones/tablets. iOS Safari and virtually all desktop
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
    return ctx;
  };
  const tone = (freq, type='sine', dur=0.08, vol=0.18, start=0) => {
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
  };
})();

const THEME_LIGHT = `
  :root,[data-theme="light"] {
    --color-background-primary:#ffffff !important;
    --color-background-secondary:#f8fafc !important;
    --color-background-tertiary:#f1f5f9 !important;
    --color-background-success:#f0fdf4 !important;
    --color-text-primary:#1e293b !important;
    --color-text-secondary:#64748b !important;
    --color-text-tertiary:#94a3b8 !important;
    --color-text-success:#15803d !important;
    --color-border-primary:#cbd5e1 !important;
    --color-border-secondary:#e2e8f0 !important;
    --color-border-tertiary:#f1f5f9 !important;
    --color-border-success:#86efac !important;
    --color-hover-tint:#f5f3ff !important;
    --color-sel-tint:#ede9fe !important;
  }
`;
const THEME_DARK = `
  :root,[data-theme="dark"] {
    --color-background-primary:#1e1e2e !important;
    --color-background-secondary:#252535 !important;
    --color-background-tertiary:#13131f !important;
    --color-background-success:#052e16 !important;
    --color-text-primary:#e2e8f0 !important;
    --color-text-secondary:#94a3b8 !important;
    --color-text-tertiary:#64748b !important;
    --color-text-success:#4ade80 !important;
    --color-border-primary:#334155 !important;
    --color-border-secondary:#2d3748 !important;
    --color-border-tertiary:#1e293b !important;
    --color-border-success:#166534 !important;
    --color-hover-tint:#2b2b45 !important;
    --color-sel-tint:#343152 !important;
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
async function callClaude({ blocks, numQ, diff, type, uiLangName }) {
  const typeMap = {
    mcq:   `Multiple choice: exactly 4 options. "correct" is 0-based index of the right answer.`,
    cards: `Flashcards: "question" = front (term/concept), "answer" = back (full explanation). Set options:[] correct:0.`,
    fill:  `Fill in the blank: each "question" has exactly one blank written as ___. "answer" = the missing word or phrase. Set options:[] correct:0.`,
    match: `Matching pairs: "question" = term, "answer" = definition. Set options:[] correct:0.`,
  };
  // `diff` is the 0/1/2 index; map to the difficulty rubric.
  const d = DIFFICULTY[typeof diff === "number" ? diff : 1] || DIFFICULTY[1];
  const prompt = `Generate EXACTLY ${numQ} study questions from the material — not ${numQ-1}, not ${numQ+1}, EXACTLY ${numQ}. This is a strict requirement: the "questions" array MUST contain exactly ${numQ} items. Do not stop early; produce all ${numQ}, then count them before responding.\nQuiz type: ${typeMap[type]}\nDIFFICULTY: ${d.name}. ${d.guide} Calibrate every question to this ${d.name} level.\nLANGUAGE: Write the ENTIRE quiz — every question, all answer options, the answer, the explanation, and the title/subject/topic — in the SAME language as the study material above. Match the material's language exactly; do NOT translate it into English.${uiLangName?` If the material is too short to tell its language, use ${uiLangName}.`:""}\nReturn ONLY raw JSON (no markdown, no backticks):\n{"title":"Short title","subject":"Subject","questions":[{"question":"...","options":["A","B","C","D"],"correct":0,"answer":"...","explanation":"One sentence","topic":"2-4 word sub-topic"}]}\nSet "topic" to the specific concept each question tests (2-4 words, e.g. "Photosynthesis", "Supply and demand") — used to track weak areas. Make all 4 options plausible. Vary question styles across the set. The "questions" array length MUST equal ${numQ}.`;

  // Scale output budget with the question count so big sets aren't truncated
  // (each Q ≈ 160 tokens, +generous headroom). Haiku 4.5 allows up to 64k
  // output and the proxy streams, so a high ceiling is safe; capped at 32k.
  // max_tokens is a ceiling, not a charge — you're billed only for tokens
  // actually generated.
  const maxTokens = Math.min(Math.max(Math.round(numQ * 220) + 2000, 4000), 32000);

  const res = await fetch("/api/anthropic", {
    method:"POST", headers:{"Content-Type":"application/json", ...(await authHeader())},
    body: JSON.stringify({ model:AI_MODEL, max_tokens:maxTokens,
      system:"You are an expert educator. Return ONLY valid raw JSON, no markdown.",
      messages:[{ role:"user", content:[...blocks,{type:"text",text:prompt}] }] }),
  });
  if (!res.ok) { const e=await res.json().catch(()=>({})); throw new Error(e.error?.message||`Error ${res.status}`); }
  const raw = stripFences(await readStream(res));
  return JSON.parse(raw);
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
      system:"You are a warm, encouraging tutor. Reply in plain text, 2-4 sentences, no markdown, no headings.",
      messages:[{ role:"user", content:[{type:"text",text:prompt}] }] }),
  });
  if (!res.ok) throw new Error("explain failed");
  return (await readStream(res)).trim();
}
function explainAnswer({ question, correct, picked, subject }) {
  return callClaudeText(
    `A student just answered a study question wrong.\nQuestion: ${question}\nCorrect answer: ${correct}\nStudent's answer: ${picked || "(left blank)"}${subject ? `\nSubject: ${subject}` : ""}\nIn 2-4 short sentences, explain clearly why the correct answer is right and gently point out the likely misunderstanding behind the student's answer. Be specific and concrete.`
  );
}
function followupAnswer({ question, correct, prior, ask }) {
  return callClaudeText(
    `A student is reviewing a quiz question they got wrong.\nQuestion: ${question}\nCorrect answer: ${correct}\nYour earlier explanation: ${prior}\nThe student now asks: "${ask}"\nAnswer their follow-up clearly and concisely (2-4 sentences).`
  );
}

// Generate one section of a standardized mock exam from its spec (no upload) —
// authentic style, self-contained MCQs. Lenient on count: returns whatever
// well-formed questions the model produces.
async function callMockSection(exam, section, tilt) {
  const nOpt = section.options || 4;
  const optTemplate = Array(nOpt).fill('"..."').join(",");
  // Pure test environment: the learner can't set difficulty. Each generated
  // form gets one randomly-chosen overall difficulty (luck of the draw), and
  // within it the questions span the authentic range — like a real exam.
  const diff = tilt === "easier"
    ? "OVERALL DIFFICULTY: an easier form of this exam — lean toward more approachable questions, but still include a few genuinely hard ones."
    : tilt === "harder"
    ? "OVERALL DIFFICULTY: a harder form of this exam — lean toward more challenging questions with subtle, close distractors, as tough test forms are."
    : "OVERALL DIFFICULTY: an authentic exam form — span the full real range, from a few easy questions to several genuinely hard ones.";
  const prompt = `You are writing a realistic ${exam.name} practice exam section for a student.
SECTION: ${section.name}. Generate EXACTLY ${section.count} multiple-choice questions.
${section.instr}
${diff} Do NOT make every question the same difficulty — this is a real, un-adjustable test, so vary it like the actual exam.
Each question needs: "question" (the full stem, with any passage/data/context written into it as text), "options" (an array of exactly ${nOpt} answer choices), "correct" (0-based index of the correct option), and "explanation" (one short sentence). Vary the skills/topics across the section and make every distractor plausible.
DIAGRAMS: when a question genuinely needs a figure to be answerable — a geometry diagram, a coordinate graph, a bar/line chart, a number line, or a labelled scientific figure — add an "svg" field containing a SELF-CONTAINED inline SVG that draws it accurately to the numbers in the question and is consistent with your correct answer. Use a viewBox, plain <line>/<rect>/<circle>/<polygon>/<path>/<text> with clear labels and units, and SINGLE quotes for attributes (e.g. <circle cx='50' cy='50' r='40'/>) so the JSON stays valid. Never include <script>, event handlers, external images, links or fonts. Most questions need NO figure — omit "svg" entirely for those; never add a decorative one.
CRITICAL — accuracy: for any question involving a calculation or data, work the answer out fully yourself FIRST, then set "correct" to the index of the option that exactly matches your computed result; double-check every calculation and unit. Every question must have exactly ONE clearly correct option, and its "explanation" must agree with that option. Discard any question you are not certain is correct.
Return ONLY raw JSON, no markdown: {"questions":[{"question":"...","options":[${optTemplate}],"correct":0,"explanation":"...","svg":"OPTIONAL — an inline <svg>…</svg>, only when a figure is required"}]}
The "questions" array MUST contain ${section.count} items.`;
  const maxTokens = Math.min(section.count * 500 + 4000, 64000); // roomy — data/diagram questions run long
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
    // Salvage a truncated response: close the array after the last complete object.
    const cut = raw.lastIndexOf("}");
    try { parsed = JSON.parse(raw.slice(0, cut + 1) + "]}"); } catch { parsed = {}; }
  }
  const qs = Array.isArray(parsed.questions) ? parsed.questions : [];
  // Keep only well-formed MCQs. A ballooning "explanation" is the tell-tale sign
  // the model couldn't solve the question cleanly — drop those rather than ship
  // a mis-keyed or incoherent question.
  return qs.filter((q) =>
    q && typeof q.question === "string" && q.question.length > 8 &&
    Array.isArray(q.options) && q.options.length >= 2 &&
    q.options.every((o) => typeof o === "string" && o.trim().length) &&
    Number.isInteger(q.correct) && q.correct >= 0 && q.correct < q.options.length &&
    String(q.explanation || "").length <= 400
  ).map((q) => {
    // Keep an optional figure only if it's a clean, self-contained <svg>. It is
    // rendered inside an <img> data-URI (which can't run scripts) as defence in
    // depth, and this strips anything scriptable before it ever gets there.
    const s = typeof q.svg === "string" ? q.svg.trim() : "";
    const safe = /^<svg[\s>]/i.test(s) && s.length < 8000 &&
      !/<script|<foreignobject|\son\w+\s*=|javascript:/i.test(s);
    const base = { question: q.question, options: q.options, correct: q.correct, explanation: q.explanation };
    return safe ? { ...base, svg: s } : base;
  });
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
  return <div style={{height:4,background:"var(--color-border-tertiary)",borderRadius:2}}><div style={{height:"100%",borderRadius:2,background:"#4f46e5",width:`${(v/max)*100}%`,transition:"width 0.35s"}}/></div>;
}

// Sliding countdown bar shown while auto-advance waits before the next
// question. Fills 0→100% over `sec` seconds via CSS animation. The `runId`
// key restarts the animation cleanly on each new question.
function AutoAdvanceBar({ sec, runId, t }) {
  return (
    <div style={{marginTop:16}}>
      <div style={{fontSize:11,color:"var(--color-text-tertiary)",marginBottom:5,textAlign:"center"}}>{t?.autoAdvancing||"Next question in a moment…"}</div>
      <div style={{height:4,background:"var(--color-border-tertiary)",borderRadius:2,overflow:"hidden"}}>
        <div key={runId} style={{height:"100%",background:"#4f46e5",borderRadius:2,animation:`rvAutoBar ${sec}s linear forwards`}}/>
      </div>
    </div>
  );
}

function Chip({ label, active, onClick, locked, small, hideBadge }) {
  return (
    <button onClick={onClick} style={{
      padding:small?"4px 10px":"6px 14px", borderRadius:20,
      fontSize:small?11:12, fontWeight:600, cursor:"pointer", fontFamily:"inherit",
      border:locked?"1.5px solid #f59e0b":"1px solid",
      transition:"all 0.15s",
      background:active?"#4f46e5":"transparent",
      color:active?"#fff":locked?"#92400e":"var(--color-text-secondary)",
      borderColor:active?"#4f46e5":locked?"#f59e0b":"var(--color-border-secondary)",
      boxShadow:locked?"0 0 0 1px #f59e0b33, inset 0 0 0 1px #f59e0b22":undefined,
    }}>
      {label}
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
          <div style={{fontSize:42,marginBottom:6}}>⭐</div>
          <h3 style={{margin:"0 0 4px",fontSize:21,fontWeight:700,fontFamily:"'Playfair Display',Georgia,serif",color:"var(--color-text-primary)"}}>{t.upgradeToPro}</h3>
        </div>
        <div style={{background:"linear-gradient(135deg,#ede9fe,#f5f3ff)",borderRadius:12,padding:"12px 14px",marginBottom:14,fontSize:12.5,color:"#3730a3",lineHeight:1.6,textAlign:"center"}}>{t.proDesc}</div>
        {error && <div style={{background:"#fef2f2",border:"1px solid #fecaca",color:"#b91c1c",borderRadius:10,padding:"9px 12px",fontSize:12.5,marginBottom:14}}>{error}</div>}
        <div style={{display:"flex",gap:12,marginBottom:14}}>
          {/* Monthly — subtle gold ring (less prominent than yearly) */}
          <div style={{flex:1,border:"1.5px solid #fcd34d",borderRadius:14,padding:"16px 12px",textAlign:"center"}}>
            <div style={{fontSize:12,fontWeight:700,letterSpacing:1,textTransform:"uppercase",color:"var(--color-text-secondary)",marginBottom:6}}>{t.planMonthly}</div>
            <div style={{fontSize:22,fontWeight:800,color:"var(--color-text-primary)"}}>€4.99</div>
            <button onClick={onMonthly} disabled={!!busy} style={{...Sb.btnPrimary,width:"100%",marginTop:14,background:"#4f46e5",fontFamily:"inherit",fontSize:13,opacity:busy?0.7:1}}>
              {busy==="monthly" ? "Starting…" : t.upgradeToPro}
            </button>
          </div>
          {/* Yearly — the standout: stronger gold ring + glow */}
          <div style={{flex:1,border:"2px solid #f59e0b",background:"#fffbeb",borderRadius:14,padding:"16px 12px",textAlign:"center",boxShadow:"0 4px 16px rgba(245,158,11,0.25)"}}>
            <div style={{fontSize:12,fontWeight:700,letterSpacing:1,textTransform:"uppercase",color:"#92400e",marginBottom:6}}>{t.planYearly}</div>
            <div style={{fontSize:22,fontWeight:800,color:"#92400e"}}>€39.99</div>
            <div style={{fontSize:10,fontWeight:700,color:"#b45309",marginTop:4}}>Save 33% ⭐ {t.bestValue}</div>
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
          <div style={{fontSize:36,marginBottom:6}}>💎</div>
          <h3 style={{margin:"0 0 6px",fontSize:20,fontWeight:700,fontFamily:"'Playfair Display',Georgia,serif",color:"var(--color-text-primary)"}}>{t.questionPacks || "Question packs"}</h3>
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
            <button onClick={()=>buy(p.id)} disabled={!!busy} style={{...Sb.btnPrimary,margin:0,padding:"10px 16px",fontSize:14,minWidth:78,background:p.best?"#f59e0b":"#4f46e5",opacity:(busy&&busy!==p.id)?0.5:1}}>
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
  flashcard:   { icon:"🃏", title:"Flashcards",        gives:"the Flashcards quiz type",        daily:false },
  fillinblank: { icon:"✏️", title:"Fill in the blank", gives:"the Fill-in-the-blank quiz type", daily:true  },
  matchterms:  { icon:"🔗", title:"Match terms",        gives:"the Match-terms quiz type",        daily:true  },
  questions:   { icon:"🔢", title:"50 questions",       gives:"up to 50 questions per quiz",      daily:true  },
  filesize:    { icon:"📦", title:"10 MB uploads",      gives:"file uploads up to 10 MB",         daily:true  },
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
          <div style={{fontSize:38,marginBottom:8}}>{active ? "🔓" : "🔒"}</div>
          <h3 style={{margin:"0 0 6px",fontSize:18,fontWeight:700,color:"var(--color-text-primary)",fontFamily:"'Playfair Display',Georgia,serif"}}>{m.title}</h3>
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
        <button onClick={onUpgrade} style={{...Sb.btnPrimary,width:"100%",marginBottom:10,fontFamily:"inherit",fontSize:14,background:"#4f46e5"}}>
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
        <div style={{background:flipped?"var(--color-background-secondary)":"var(--color-background-primary)",border:`1.5px solid ${flipped?"#4f46e5":"var(--color-border-tertiary)"}`,borderRadius:16,padding:"40px 24px",textAlign:"center",minHeight:200,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",transition:"all 0.25s"}}>
          <div style={{fontSize:10,fontWeight:700,color:"var(--color-text-tertiary)",letterSpacing:1.5,marginBottom:16}}>{flipped?t.fcAnswer:t.fcQuestion}</div>
          <div style={{fontFamily:"'Playfair Display',Georgia,serif",fontSize:18,fontWeight:700,color:"var(--color-text-primary)",lineHeight:1.5}}>{flipped?ans:q.question}</div>
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
      <div style={{fontFamily:"'Playfair Display',Georgia,serif",fontSize:18,fontWeight:700,color:"var(--color-text-primary)",lineHeight:1.6,marginBottom:20}}>
        {parts[0]}
        <span style={{display:"inline-block",borderBottom:"2px solid #4f46e5",minWidth:80,margin:"0 4px",padding:"0 6px",color:"#4f46e5",fontStyle:"italic"}}>
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
  const pickTerm = i => { if(checked||matches[i]!==undefined)return; setSel(s=>s===i?null:i); };
  const pickDef  = i => {
    if(checked||defUsed[i]||sel===null)return;
    Haptics.buzz();
    const n = Object.keys(matches).length + 1; // next free pair number
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
            const bc=isOk?"#22c55e":isBad?"#ef4444":isSel?"#4f46e5":matched?pc:"var(--color-border-tertiary)";
            return <button key={i} onClick={()=>pickTerm(i)} style={{display:"flex",alignItems:"flex-start",gap:8,padding:"10px 12px",borderRadius:10,border:"1.5px solid",borderColor:bc,background:isSel?"var(--color-sel-tint)":matched?"var(--color-background-secondary)":"var(--color-background-primary)",fontSize:12,fontWeight:600,cursor:matched||checked?"default":"pointer",color:"var(--color-text-primary)",fontFamily:"inherit",textAlign:"left",transition:"all 0.15s"}}>
              {matched && <PairBadge n={pairNo[i]} color={pc}/>}
              <span style={{flex:1}}>{isOk&&"✅ "}{isBad&&"❌ "}{term}</span>
            </button>;
          })}
        </div>
        <div style={{display:"flex",flexDirection:"column",gap:6}}>
          {defs.map((def,i)=>{
            const used=defUsed[i]; const ti=used?termForDef(i):null; const n=ti!==null?pairNo[ti]:null;
            const pc=n?pairColor(n):null;
            return <button key={i} onClick={()=>pickDef(i)} style={{display:"flex",alignItems:"flex-start",gap:8,padding:"10px 12px",borderRadius:10,border:"1.5px solid",borderColor:used?pc:"var(--color-border-tertiary)",background:used?"var(--color-background-secondary)":"var(--color-background-primary)",fontSize:11,cursor:(used||checked||sel===null)?"default":"pointer",color:"var(--color-text-primary)",fontFamily:"inherit",textAlign:"left",lineHeight:1.4,transition:"all 0.15s"}}>
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

// ── "Explain why" — AI tutor on a wrong answer ────────────────────────
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
    <button onClick={load} style={{marginTop:8,marginLeft:23,background:"none",border:"none",color:"#4f46e5",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit",padding:0}}>💡 {t.explainWhy}</button>
  );
  return (
    <div style={{marginTop:8,marginLeft:23,background:"var(--color-background-secondary)",border:"0.5px solid var(--color-border-tertiary)",borderRadius:10,padding:"10px 12px"}} className="fade-in">
      {loading && <div style={{fontSize:12.5,color:"var(--color-text-secondary)"}}>💡 {t.explainLoading}</div>}
      {err && <div style={{fontSize:12.5,color:"#b91c1c"}}>{err}</div>}
      {text && <div style={{fontSize:12.5,color:"var(--color-text-primary)",lineHeight:1.55,whiteSpace:"pre-wrap"}}>{text}</div>}
      {turns.map((turn,i)=>(
        <div key={i} style={{marginTop:8,paddingTop:8,borderTop:"0.5px solid var(--color-border-tertiary)"}}>
          <div style={{fontSize:12,fontWeight:700,color:"var(--color-text-secondary)"}}>❓ {turn.q}</div>
          <div style={{fontSize:12.5,color:"var(--color-text-primary)",lineHeight:1.55,marginTop:3,whiteSpace:"pre-wrap"}}>{turn.a}</div>
        </div>
      ))}
      {text && !loading && (
        <div style={{display:"flex",gap:6,marginTop:10}}>
          <input value={ask} onChange={(e)=>setAsk(e.target.value)} onKeyDown={(e)=>e.key==="Enter"&&doAsk()} placeholder={t.explainAsk} disabled={asking}
            style={{flex:1,borderRadius:8,border:"1px solid var(--color-border-secondary)",background:"var(--color-background-primary)",color:"var(--color-text-primary)",fontSize:12.5,padding:"7px 10px",fontFamily:"inherit",outline:"none",boxSizing:"border-box"}}/>
          <button onClick={doAsk} disabled={asking||!ask.trim()} style={{background:"#4f46e5",color:"#fff",border:"none",borderRadius:8,padding:"7px 12px",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit",opacity:(asking||!ask.trim())?0.5:1}}>{asking?"…":t.explainAskBtn}</button>
        </div>
      )}
    </div>
  );
}

// ── Share-a-quiz sheet ─────────────────────────────────────────────────
function ShareModal({ link, err, copied, onCopy, onClose, t }) {
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.6)",zIndex:500,display:"flex",alignItems:"flex-end"}} onClick={onClose}>
      <div className="slide-up" onClick={(e)=>e.stopPropagation()} style={{background:"var(--color-background-primary)",borderRadius:"20px 20px 0 0",padding:"26px 20px 36px",width:"100%",maxWidth:520,margin:"0 auto",boxSizing:"border-box"}}>
        <div style={{textAlign:"center",marginBottom:16}}>
          <div style={{fontSize:34,marginBottom:6}}>📤</div>
          <h3 style={{margin:"0 0 6px",fontSize:19,fontWeight:700,fontFamily:"'Playfair Display',Georgia,serif",color:"var(--color-text-primary)"}}>{t.shareTitle}</h3>
          <p style={{margin:0,fontSize:12.5,color:"var(--color-text-secondary)",lineHeight:1.5}}>{t.shareDesc}</p>
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
    const ctx = `\n\n— sent from the app —\npath: ${location.pathname} · lang: ${document.documentElement.lang} · ${navigator.userAgent}`;
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
          <div style={{fontSize:34,marginBottom:6}}>🐛</div>
          <h3 style={{margin:"0 0 6px",fontSize:19,fontWeight:700,fontFamily:"'Playfair Display',Georgia,serif",color:"var(--color-text-primary)"}}>{t.reportTitle}</h3>
          <p style={{margin:0,fontSize:12.5,color:"var(--color-text-secondary)",lineHeight:1.5}}>{t.reportSub}</p>
        </div>
        {state === "sent" ? (
          <div style={{textAlign:"center",padding:"14px 0 4px"}}>
            <div style={{fontSize:40,marginBottom:8}}>🙌</div>
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
      background:on?"#4f46e5":"var(--color-border-secondary)",
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
          <div style={{height:"100%",width:pct + "%",background:pct >= 100 ? "#ef4444" : "#4f46e5",borderRadius:4,transition:"width .3s"}}/>
        </div>
        {/* Additional (pack) questions — shown to everyone who has any. */}
        <div style={{fontSize:12,color:"var(--color-text-secondary)",marginTop:8}}>{s.usageBonus || "Extra questions (packs)"}: <strong style={{color:(u.bonus_questions_remaining > 0) ? "#16a34a" : "var(--color-text-primary)"}}>{u.bonus_questions_remaining ?? 0}</strong></div>

        {!isPro && <>
          {/* The X/2 here is scoped to the +questions ad — it's not all ads. */}
          {adsLeft > 0
            ? <button disabled={adBusy} onClick={onWatchAd} style={{marginTop:10,width:"100%",background:"#f59e0b",color:"#fff",border:"none",borderRadius:10,padding:"10px",fontSize:13,fontWeight:700,cursor:adBusy ? "default" : "pointer",fontFamily:"inherit",opacity:adBusy ? 0.6 : 1}}>
                {adBusy ? (s.loadingAd || "Loading ad…") : `📺 ${(s.watchAdForQuestions || "Watch ad for +{n} questions").replace("{n}", u.ad_question_bonus ?? 10)} · ${u.ad_watches_today ?? 0}/${u.max_ad_watches ?? 2}`}
              </button>
            : <div style={{marginTop:10,width:"100%",background:"var(--color-background-tertiary)",color:"var(--color-text-tertiary)",borderRadius:10,padding:"10px",fontSize:12.5,fontWeight:600,textAlign:"center",boxSizing:"border-box"}}>
                📵 {(s.adLimitReached || "Daily ad limit reached")} · {u.max_ad_watches ?? 2}/{u.max_ad_watches ?? 2}
              </div>}
          <button onClick={() => startCheckout?.(STRIPE_MONTHLY_PRICE)} style={{marginTop:8,width:"100%",background:"#4f46e5",color:"#fff",border:"none",borderRadius:10,padding:"10px",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>
            ⭐ {s.upgradeForMore || "Upgrade to Pro — 250 questions/day"}
          </button>
        </>}

        {/* Question packs — available to all users; other limits still apply. */}
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",margin:"14px 0 6px"}}>
          <span style={{fontSize:12,fontWeight:700,color:"var(--color-text-primary)"}}>{s.buyPacks || "Question packs"}</span>
          {onOpenPacks && <button onClick={onOpenPacks} style={{fontSize:11,color:"#4f46e5",background:"none",border:"none",cursor:"pointer",fontFamily:"inherit",fontWeight:700,padding:0}}>{s.comparePacks || "View all →"}</button>}
        </div>
        {QUESTION_PACKS.map((p) => (
          <div key={p.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",border:"0.5px solid var(--color-border-tertiary)",borderRadius:10,padding:"9px 12px",marginBottom:6}}>
            <span style={{fontSize:13,color:"var(--color-text-primary)"}}><strong>{p.q}</strong> {s.questionsWord || "questions"} · {p.price}</span>
            <button disabled={!!packBusy} onClick={() => onBuyPack(p.id)} style={{background:"#4f46e5",color:"#fff",border:"none",borderRadius:8,padding:"6px 14px",fontSize:12,fontWeight:700,cursor:packBusy ? "default" : "pointer",fontFamily:"inherit",opacity:(packBusy && packBusy !== p.id) ? 0.5 : 1}}>
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
              <div style={{width:40,height:40,borderRadius:"50%",background:"linear-gradient(135deg,#4f46e5,#6366f1)",color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",fontSize:17,fontWeight:700,flexShrink:0}}>{(user.email||"?").charAt(0).toUpperCase()}</div>
              <div style={{minWidth:0}}>
                <div style={{fontSize:13.5,fontWeight:700,color:"var(--color-text-primary)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:170}}>{user.email||"Your account"}</div>
                <span style={{fontSize:9.5,fontWeight:800,letterSpacing:0.5,padding:"2px 8px",borderRadius:999,color:isPro?"#422006":"var(--color-text-secondary)",background:isPro?"linear-gradient(135deg,#fde68a,#f59e0b)":"var(--color-background-tertiary)",border:isPro?"none":"0.5px solid var(--color-border-secondary)",display:"inline-block",marginTop:3}}>{isPro?"✦ PRO":t.freePlanBadge}</span>
              </div>
            </div>
          ) : (
            <span style={{fontSize:18,fontWeight:700,fontFamily:"'Playfair Display',Georgia,serif",color:"var(--color-text-primary)"}}>{s.title||"Settings"}</span>
          )}
          <button onClick={onCancel} style={{background:"none",border:"none",fontSize:20,
            cursor:"pointer",color:"var(--color-text-secondary)",lineHeight:1,padding:"2px 6px",flexShrink:0}}>✕</button>
        </div>

        <div style={{flex:1,overflowY:"auto"}}>
          {/* Your progress — makes the account a study home, not just billing */}
          <div style={{padding:"16px 18px 6px"}}>
            <div style={{fontSize:10.5,fontWeight:800,letterSpacing:0.8,color:"var(--color-text-tertiary)",textTransform:"uppercase",marginBottom:10}}>{t.progressTitle}</div>
            <div style={{display:"flex",gap:8}}>
              {[
                { v: `🔥 ${acctStats.streak}`, l: t.dayStreak },
                { v: acctStats.accuracy != null ? `${acctStats.accuracy}%` : "—", l: t.accuracyLbl },
                { v: acctSrs.totalCount, l: t.inReviewLbl },
              ].map(({ v, l }, i) => (
                <div key={i} style={{flex:1,background:"var(--color-background-secondary)",borderRadius:12,padding:"12px 4px",textAlign:"center",border:"0.5px solid var(--color-border-tertiary)"}}>
                  <div style={{fontSize:15.5,fontWeight:800,color:"var(--color-text-primary)"}}>{v}</div>
                  <div style={{fontSize:10,color:"var(--color-text-secondary)",marginTop:3}}>{l}</div>
                </div>
              ))}
            </div>
            {acctSrs.dueCount > 0 && <div style={{fontSize:11.5,color:"#4f46e5",fontWeight:600,marginTop:9,textAlign:"center"}}>🔁 {acctSrs.dueCount} card{acctSrs.dueCount>1?"s":""} due for review today</div>}
          </div>

          <SectionLabel label={s.secAppearance}/>
          <SettingRow label={s.theme} desc={draft.theme==="light"?s.themeLight:draft.theme==="dark"?s.themeDark:s.themeFollows}>
            <Seg options={[["system",s.segAuto],["light","☀️"],["dark","🌙"]]} value={draft.theme} onChange={v=>update("theme",v)}/>
          </SettingRow>
          <SettingRow label={s.fontSize} desc={draft.fontSize==="small"?s.fontCompact:""}>
            <Seg options={[["small","S"],["medium","M"],["large","L"]]} value={draft.fontSize} onChange={v=>update("fontSize",v)}/>
          </SettingRow>
          <SettingRow label={s.animations} desc={s.animationsDesc}>
            <Toggle on={draft.animations} onChange={v=>update("animations",v)}/>
          </SettingRow>
          <SettingRow label={"🌍 "+(s.language||"Language")} desc={LANGS[draft.lang]?.name}>
            <select value={draft.lang} onChange={e=>update("lang",e.target.value)} style={{border:"0.5px solid var(--color-border-secondary)",borderRadius:8,background:"var(--color-background-tertiary)",color:"var(--color-text-primary)",fontSize:13,padding:"6px 8px",fontFamily:"inherit",outline:"none",maxWidth:150,cursor:"pointer"}}>
              {Object.entries(LANGS).map(([code,l])=><option key={code} value={code}>{l.flag} {l.name}</option>)}
            </select>
          </SettingRow>

          <SectionLabel label={s.secSound}/>
          <SettingRow label={s.soundEffects}>
            <Toggle on={draft.sound} onChange={v=>update("sound",v)}/>
          </SettingRow>
          <SettingRow label={s.volume+"  "+draft.volume+"%"} desc={!draft.sound?s.volumeNeedSound:undefined}>
            <div style={{display:"flex",alignItems:"center",gap:6,width:130}}>
              <span style={{fontSize:13}}>🔇</span>
              <input type="range" min={0} max={100} step={5} value={draft.volume}
                onChange={e=>update("volume",parseInt(e.target.value))}
                disabled={!draft.sound}
                style={{flex:1,accentColor:"#4f46e5",cursor:draft.sound?"pointer":"not-allowed",opacity:draft.sound?1:0.4}}/>
              <span style={{fontSize:13}}>🔊</span>
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
                  style={{flex:1,accentColor:"#4f46e5",cursor:"pointer"}}/>
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
            <span>🐛 {s.reportBug}</span><span style={{color:"var(--color-text-tertiary)",fontSize:18}}>›</span>
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
                  <span style={{fontSize:15,fontWeight:700,color:"var(--color-text-primary)"}}>⭐ Revyy Pro</span>
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
                  {portalBusy==="manage" ? s.opening : `💳 ${t.manageSubscription}`}
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
                  {checkingSub ? "Checking…" : "🔄 Refresh subscription status"}
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
                  style={{width:"100%",marginTop:10,background:"#4f46e5",color:"#fff",
                    border:"none",borderRadius:12,padding:"12px",fontSize:14,fontWeight:700,
                    cursor:"pointer",fontFamily:"'Playfair Display',Georgia,serif",boxShadow:"0 2px 12px #4f46e544"}}>
                  {t.upgradeToPro} →
                </button>
                <p style={{fontSize:11,color:"var(--color-text-tertiary)",textAlign:"center",margin:"9px 0 0",lineHeight:1.5}}>{t.cancelAnytime}</p>
                <button onClick={doRefreshSub} disabled={checkingSub}
                  style={{width:"100%",marginTop:8,background:"none",border:"none",
                    fontSize:12,fontWeight:500,color:"var(--color-text-tertiary)",cursor:checkingSub?"default":"pointer",fontFamily:"inherit"}}>
                  {checkingSub ? "Checking…" : "🔄 Already paid? Refresh status"}
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
              🔐 Manage login &amp; security
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
                style={{width:"100%",background:"#4f46e5",color:"#fff",border:"none",borderRadius:12,padding:"12px",fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:"'Playfair Display',Georgia,serif",boxShadow:"0 2px 12px #4f46e544"}}>
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
          <button onClick={onApply} style={{flex:2,background:"#4f46e5",color:"#fff",
            border:"none",borderRadius:12,padding:"12px",fontSize:14,fontWeight:700,
            cursor:"pointer",fontFamily:"'Playfair Display',Georgia,serif",
            boxShadow:"0 2px 12px #4f46e544"}}>✓ {s.applySave}</button>
        </div>
      </div>

      {confirmDel && (
        <div style={{position:"fixed",inset:0,zIndex:700,background:"rgba(0,0,0,0.6)",display:"flex",alignItems:"center",justifyContent:"center",padding:"20px"}} onClick={closeConfirm}>
          <div className="slide-up" onClick={e=>e.stopPropagation()} style={{background:"var(--color-background-primary)",borderRadius:16,padding:"26px 22px",maxWidth:340,width:"100%",textAlign:"center",boxShadow:"0 8px 32px rgba(0,0,0,0.28)"}}>
            <div style={{fontSize:38,marginBottom:10}}>⚠️</div>
            <h3 style={{margin:"0 0 8px",fontSize:18,fontWeight:700,color:"var(--color-text-primary)",fontFamily:"'Playfair Display',Georgia,serif"}}>{s.confirmTitle}</h3>
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
        <div style={{fontSize:36,marginBottom:10}}>⚠️</div>
        <h3 style={{margin:"0 0 8px",fontSize:17,fontWeight:700,color:"var(--color-text-primary)",fontFamily:"'Playfair Display',Georgia,serif"}}>{title||t.exitTitle||"Leave this page?"}</h3>
        <p style={{margin:"0 0 22px",fontSize:13,color:"var(--color-text-secondary)",lineHeight:1.5}}>{message||t.exitMsg||"Your progress will be lost and cannot be recovered."}</p>
        <div style={{display:"flex",gap:10}}>
          <button onClick={onStay}  style={{flex:1,background:stayGreen?"#16a34a":"var(--color-background-secondary)",color:stayGreen?"#fff":"var(--color-text-primary)",border:stayGreen?"none":"1px solid var(--color-border-secondary)",borderRadius:12,padding:"12px",fontSize:14,fontWeight:stayGreen?700:500,cursor:"pointer",fontFamily:"inherit"}}>{stayLabel||t.stayBtn||"Stay"}</button>
          <button onClick={onLeave} style={{flex:1,background:"#ef4444",color:"#fff",border:"none",borderRadius:12,padding:"12px",fontSize:14,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>{leaveLabel||t.leaveBtn||"Leave"}</button>
        </div>
      </div>
    </div>
  );
}

// Pause overlay — strong blur over the whole exam so nothing is visible/clickable.
function PauseOverlay({ onResume }) {
  const lc=useLang(); const t=(lc&&lc.t)||{};
  return (
    <div style={{position:"fixed",inset:0,zIndex:900,display:"flex",alignItems:"center",justifyContent:"center",padding:"20px",background:"rgba(15,16,32,0.45)",backdropFilter:"blur(20px)",WebkitBackdropFilter:"blur(20px)"}}>
      <div className="slide-up" style={{textAlign:"center",maxWidth:340}}>
        <div style={{fontSize:30,fontWeight:800,color:"#fff",fontFamily:"'Playfair Display',Georgia,serif",marginBottom:8}}>{t.examPausedTitle}</div>
        <div style={{fontSize:14,color:"rgba(255,255,255,0.85)",marginBottom:24}}>{t.progressSaved}</div>
        <button onClick={onResume} style={{background:"#4f46e5",color:"#fff",border:"none",borderRadius:14,padding:"15px 40px",fontSize:16,fontWeight:700,cursor:"pointer",fontFamily:"inherit",boxShadow:"0 8px 24px rgba(79,70,229,0.4)"}}>{t.resumeExamBtn}</button>
      </div>
    </div>
  );
}

// Time's-up — non-dismissable, shown while the exam auto-submits.
function TimeUpModal() {
  const lc=useLang(); const t=(lc&&lc.t)||{};
  return (
    <div style={{position:"fixed",inset:0,zIndex:950,display:"flex",alignItems:"center",justifyContent:"center",padding:"20px",background:"rgba(15,16,32,0.7)",backdropFilter:"blur(8px)",WebkitBackdropFilter:"blur(8px)"}}>
      <div style={{background:"var(--color-background-primary)",borderRadius:18,padding:"32px 26px",maxWidth:320,width:"100%",textAlign:"center",boxShadow:"0 12px 40px rgba(0,0,0,0.4)"}}>
        <div style={{fontSize:46,marginBottom:10}}>⏰</div>
        <h3 style={{margin:"0 0 6px",fontSize:22,fontWeight:800,color:"#dc2626",fontFamily:"'Playfair Display',Georgia,serif"}}>{t.timesUp}</h3>
        <p style={{margin:"0 0 20px",fontSize:14,color:"var(--color-text-secondary)",lineHeight:1.5}}>{t.examSubmittingNow}</p>
        <div style={{width:36,height:36,margin:"0 auto",border:"3px solid var(--color-border-secondary)",borderTopColor:"#4f46e5",borderRadius:"50%",animation:"spin 0.8s linear infinite"}}/>
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
        <div style={{fontSize:36,marginBottom:10}}>📝</div>
        <h3 style={{margin:"0 0 8px",fontSize:18,fontWeight:700,color:"var(--color-text-primary)",fontFamily:"'Playfair Display',Georgia,serif"}}>{t.examInProgressQ}</h3>
        <p style={{margin:"0 0 20px",fontSize:13,color:"var(--color-text-secondary)",lineHeight:1.5}}>
          {t.resumeQInfo.replace("{q}",info.examQs?.length||0).replace("{a}",answered)}{info.examTimerOn && info.examTimeLeft!=null ? " · "+fmtClock(info.examTimeLeft)+" left" : ""}
        </p>
        <div style={{display:"flex",gap:10}}>
          <button onClick={onDiscard} style={{flex:1,background:"var(--color-background-secondary)",color:"var(--color-text-primary)",border:"1px solid var(--color-border-secondary)",borderRadius:12,padding:"12px",fontSize:14,fontWeight:500,cursor:"pointer",fontFamily:"inherit"}}>{t.discardBtn}</button>
          <button onClick={onResume} style={{flex:2,background:"#4f46e5",color:"#fff",border:"none",borderRadius:12,padding:"12px",fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>{t.continueExamBtn}</button>
        </div>
      </div>
    </div>
  );
}

function Confetti() {
  const pieces = Array.from({length:60},(_,i)=>({
    id:i, x:Math.random()*100, delay:Math.random()*2.5, dur:1.8+Math.random()*2,
    color:["#4f46e5","#f59e0b","#22c55e","#ec4899","#3b82f6","#f97316","#8b5cf6","#06b6d4"][i%8],
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
      <div style={{color:"#fff",fontSize:18,fontWeight:700,fontFamily:"'Playfair Display',Georgia,serif"}}>{t.activatingPro}</div>
      <div style={{color:"rgba(255,255,255,0.8)",fontSize:13.5,maxWidth:320,lineHeight:1.5}}>{t.refreshingAccount}</div>
    </div>
  );
}

export default function StudyQuiz() {
  const [screen,       setScreen]       = useState("home");
  const { t, lang, setLang } = useLang(); // language control now lives inside the account panel
  const dev = useDev();
  const { isPro, signOut, deleteAccount, reauthenticate, user, startCheckout, openPortal, refreshProfile, getToken, usage, refreshUsage, consumeQuestions, watchAd: watchAdQuestions, buyPack } = useAuth();
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
  // Email/password accounts must re-enter their password to delete; OAuth-only
  // (e.g. Google) accounts have no password to verify.
  const requiresPassword = !!user?.identities?.some(i => i.provider === "email");
  const [tab,          setTab]          = useState("file");
  const [file,         setFile]         = useState(null);
  const [textVal,      setTextVal]      = useState("");
  const [numQ,         setNumQ]         = useState(10);
  const [customQ,      setCustomQ]      = useState("25");
  const [useCustomQ,   setUseCustomQ]   = useState(false);
  const [diff,         setDiff]         = useState(1);
  const [qType,        setQType]        = useState("mcq");
  const [quiz,         setQuiz]         = useState(null);
  const [qIdx,         setQIdx]         = useState(0);
  const [answers,      setAnswers]      = useState([]);
  const [selected,     setSelected]     = useState(null);
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
  // ── Standardized mock exams (ACT) — self-contained, per-section timed ──
  const [mockPresetId, setMockPresetId] = useState("act");
  const [mock, setMock] = useState(null);
  const [mockSecIdx, setMockSecIdx] = useState(0);
  const [mockQIdx, setMockQIdx] = useState(0);
  const [mockAns, setMockAns] = useState([]); // [secIdx] => [selected index per question]
  const [mockSecResults, setMockSecResults] = useState([]);
  const [mockSecTimeLeft, setMockSecTimeLeft] = useState(0);
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
    const scaled = scaledScore(raw, sec.questions.length, mock.scaleMin, mock.scaleMax);
    setMockSecResults((prev) => { const n = [...prev]; n[mockSecIdx] = { sectionId: sec.id, name: sec.name, raw, count: sec.questions.length, scaled }; return n; });
    setShowMockSubmit(false);
    if (mockSecIdx + 1 < mock.sections.length) {
      setScreen("mock_break");   // pause between sections; the next timer only starts from the break screen
    } else {
      setScreen("mock_results");
    }
  };
  // Begin the next section from the between-section break — this is what starts
  // the next section's timer, so finishing one section never rolls straight into
  // the next with the clock already running.
  const startNextSection = () => {
    if (!mock) return;
    const ni = mockSecIdx + 1;
    if (ni >= mock.sections.length) { setScreen("mock_results"); return; }
    setMockSecIdx(ni); setMockQIdx(0); setMockSecTimeLeft(mock.sections[ni].minutes * 60);
    setScreen("mock_run");
  };
  useEffect(() => { submitSectionRef.current = submitSection; }); // keep latest closure
  // Per-section countdown: one interval per section, auto-submits at 0.
  useEffect(() => {
    if (screen !== "mock_run") return;
    const id = setInterval(() => setMockSecTimeLeft((t) => { if (t <= 1) { clearInterval(id); return 0; } return t - 1; }), 1000);
    return () => clearInterval(id);
  }, [screen, mockSecIdx]);
  useEffect(() => {
    if (screen === "mock_run" && mockSecTimeLeft === 0 && mock && submittedSecRef.current !== mockSecIdx) submitSectionRef.current();
  }, [mockSecTimeLeft, screen, mockSecIdx, mock]);
  const sortedPlans = [...plans].sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));
  const homePlan = sortedPlans.find(p=>!isPlanComplete(p)) || sortedPlans[0] || null;
  const activePlan = plans.find(p=>p.id===activePlanId) || homePlan;
  const topicsWeak = weakTopics(srs.cards); // weak areas from the review deck
  // Best-effort browser reminder — fires only while Revyy is open in the tab
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
  const srsAddedRef = useRef(null);
  const fileRef  = useRef();
  const photoRef = useRef();
  const examFileRef0=useRef(),examFileRef1=useRef(),examFileRef2=useRef(),examFileRef3=useRef(),examFileRef4=useRef();
  const examFileRefs=[examFileRef0,examFileRef1,examFileRef2,examFileRef3,examFileRef4];
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
  // (once per result set — keyed on the object identity).
  useEffect(() => {
    if (screen === "results" && quiz && srsAddedRef.current !== quiz) {
      srsAddedRef.current = quiz;
      const missed = quiz.questions.filter((_, i) => answers[i] && answers[i].isCorrect === false).map(toCard);
      setSrsAdded(missed.length ? srs.addMissed(missed) : 0);
      stats.recordSession(answers.length, answers.filter((a) => a && a.isCorrect).length);
    } else if (screen === "exam_results" && examEvals && srsAddedRef.current !== examEvals) {
      srsAddedRef.current = examEvals;
      const missed = examQs.filter((_, i) => (examEvals[i]?.score ?? 0) < 1).map(toCard);
      setSrsAdded(missed.length ? srs.addMissed(missed) : 0);
      stats.recordSession(examEvals.length, examEvals.filter((e) => (e?.score ?? 0) >= 1).length);
    }
  }, [screen, quiz, answers, examEvals, examQs, srs, stats]);
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
  const [settingsDraft,  setSettingsDraft]  = useState(null);
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
  useEffect(()=>{ Haptics.on = settings.haptics; },[settings.haptics]);
  // Apply the saved "default difficulty / questions" to the quiz-setup controls
  // on load (and whenever the default changes) so they persist across reloads
  // and logout/login — not only when Apply is pressed.
  useEffect(()=>{ setDiff(settings.defaultDiff); },[settings.defaultDiff]);
  useEffect(()=>{ setNumQ(settings.defaultQCount); },[settings.defaultQCount]);

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
    let el=document.getElementById("revyy-font");
    if(!el){el=document.createElement("style");el.id="revyy-font";document.head.appendChild(el);}
    const s=settings.fontSize==="small"?"13px":settings.fontSize==="large"?"17px":"15px";
    el.textContent="body,input,textarea,select,button{font-size:"+s+" !important;}";
  },[settings.fontSize]);

  useEffect(()=>{
    if(settings.animations) document.body.classList.remove("no-anim");
    else document.body.classList.add("no-anim");
  },[settings.animations]);

  const autoAdvanceSec = Math.min(Math.max(parseInt(settings.autoAdvanceSec)||5,1),15);
  // Auto-advance (normal MCQ quiz only — exam mode is separate): once an answer
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

  // Banner-ads master switch (mirrors AdBanners) — separate from feature unlocks.
  const adsOn = dev.devMode && dev.ads!==null ? dev.ads : ADS_ENABLED;
  const openUpgrade = () => { setUnlockFeature(null); setShowProModal(true); };

  const addExamFile=useCallback(async(f,idx)=>{
    if(!f)return;
    const lim=fileLimitMB();
    if(f.size/1024/1024>lim){setError(t.errFileTooLarge.replace("{n}",lim));return;}
    const isPdf=f.type==="application/pdf",isImg=f.type.startsWith("image/"),isTxt=f.type.startsWith("text/")||/\.(txt|md|csv)$/i.test(f.name);
    if(!isPdf&&!isImg&&!isTxt){setError(t.errFileType);return;}
    try{
      let p;
      if(isTxt){const text=await readText(f);p={type:"text",content:text,mime:null,name:f.name};}
      else{p={type:isPdf?"pdf":"image",raw:f,mime:f.type,name:f.name};}
      setExamFiles(prev=>{const a=[...prev];a[idx]=p;return a.filter(Boolean);});
      setError("");
    }catch{setError(t.errReadFile);}
  },[fileLimitMB]);

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

    // Exam questions count toward the daily question limit (reserve them first).
    const consumed = await consumeQuestions(totalQ);
    if (consumed && consumed.allowed === false) {
      const left = consumed.remaining ?? 0;
      setLimitHit(true); // Pro-only screen → offer the question-pack button
      setError(t.errExamOverLimit.replace("{q}",totalQ).replace("{left}",left).replace("{limit}",consumed.daily_limit));
      setScreen("exam_setup");
      return;
    }

    // Exams carry model answers/explanations → ~200 tokens/Q. Cap at 20k.
    const maxTokens = Math.min(Math.max(Math.round(totalQ*200)+2000, 6000), 20000);

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
      const prompt="You are creating a real graded exam.\n"+typeInst+"\nDIFFICULTY: "+dg.name+". "+dg.guide+" Calibrate every question to this "+dg.name+" level.\nLANGUAGE: Write the ENTIRE exam — every question, all options, model answers, explanations and the title — in the SAME language as the study material provided. Match the material's language exactly; do NOT translate it into English."+(LANGS[lang]?.name?" If the material is too short to tell its language, use "+LANGS[lang].name+".":"")+"\nReturn ONLY raw JSON (no markdown):\n{\"title\":\"Exam title\",\"questions\":[{\"section\":1,\"type\":\"mcq\",\"question\":\"...\",\"options\":[\"A\",\"B\",\"C\",\"D\"],\"correct\":0,\"answer\":\"model answer\",\"explanation\":\"...\",\"topic\":\"2-4 word sub-topic\"}]}\nSet \"topic\" to the specific concept each question tests (2-4 words) — used to track weak areas. For written/fill: options:[], correct:0. Keep questions in section order.";
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
      const attempt=async(scale)=>{
        const { prompt, marksMap }=buildPrompt(scale);
        const res=await fetch("/api/anthropic",{method:"POST",headers:{"Content-Type":"application/json", ...(await authHeader())},
          body:JSON.stringify({model:AI_MODEL,max_tokens:maxTokens,
            system:"You are an expert exam setter. Return ONLY valid raw JSON, no markdown.",
            messages:[{role:"user",content:[...blocks,{type:"text",text:prompt}]}]})});
        if(!res.ok){const e=await res.json().catch(()=>({}));throw new Error(e.error?.message||"Error "+res.status);}
        return { parsed: JSON.parse(stripFences(await readStream(res))), marksMap };
      };
      let parsed, marksMap;
      try { ({ parsed, marksMap }=await attempt(1)); }
      catch(e1){
        const truncated=/JSON|Unexpected end|Unterminated|parse/i.test(e1.message||"");
        if(truncated && totalQ>25){ ({ parsed, marksMap }=await attempt(0.5)); }
        else throw e1;
      }
      if(!parsed.questions?.length) throw new Error("No questions generated");
      const annotated = parsed.questions.map(q=>({
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
  },[examFiles,examMode,examSections,examTotalQ,diff,sectionTotalQs,examTimerOn,examTimerMin,uploadFileToAnthropic,consumeQuestions,requireLogin,isPro,unlocks]);

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
      "Grade each student answer ONLY against the question and model answer under the SAME number — never carry over or mix answers between numbers. "+
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
  // Countdown tick — only during an active, unpaused, timed exam.
  useEffect(()=>{
    if(screen!=="exam_run" || !examTimerOn || examPaused || examTimeUp) return;
    const id=setInterval(()=>setExamTimeLeft(s=> s===null ? null : Math.max(0, s-1)),1000);
    return ()=>clearInterval(id);
  },[screen,examTimerOn,examPaused,examTimeUp]);
  // Fire time-up once when the clock reaches zero.
  useEffect(()=>{
    if(screen==="exam_run" && examTimerOn && examTimeLeft===0 && !examTimeUp) handleTimeUp();
  },[screen,examTimerOn,examTimeLeft,examTimeUp,handleTimeUp]);
  // Auto-pause when the tab is hidden/switched.
  useEffect(()=>{
    if(screen!=="exam_run" || !examTimerOn) return;
    const onVis=()=>{ if(document.hidden) setExamPaused(true); };
    document.addEventListener("visibilitychange",onVis);
    return ()=>document.removeEventListener("visibilitychange",onVis);
  },[screen,examTimerOn]);
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
      // PDFs/images are uploaded to the Anthropic Files API at generate time —
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
    if (tab==="file"||tab==="photo") {
      if (!file) { setError(t.errUploadFirst); return; }
    } else if (!textVal.trim()) { setError(t.errPasteFirst); return; }

    // Enforce the daily question limit (server-side; reserves the questions).
    const consumed = await consumeQuestions(finalNumQ);
    if (consumed && consumed.allowed === false) {
      const left = consumed.remaining ?? 0;
      setLimitHit(true); // offer the question-pack button under the error (all users)
      setError(
        isPro
          ? `Daily limit reached (${consumed.daily_limit}/day). You have ${left} questions left — grab a question pack for more.`
          : left > 0
            ? `That's ${finalNumQ} questions but you only have ${left} left today. Lower the count, watch an ad for +10, buy a question pack, or go Pro.`
            : `Daily question limit reached. Watch an ad for +10, buy a question pack, or upgrade to Pro.`
      );
      return;
    }

    setScreen("loading");
    try {
      let blocks = [];
      if (tab==="file"||tab==="photo") {
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
      // Generate, then validate the count. The model sometimes returns fewer
      // questions than asked — if so, regenerate (up to 2 extra tries) and keep
      // whichever attempt produced the most questions. A parse error (usually a
      // truncated response) counts as a failed attempt rather than aborting.
      let res = null, lastErr = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        let r = null;
        try {
          r = await callClaude({blocks, numQ:finalNumQ, diff, type:finalType, uiLangName:LANGS[lang]?.name});
        } catch (e1) { lastErr = e1; }
        if (r?.questions?.length) {
          // Keep the best-so-far (most questions).
          if (!res || r.questions.length > res.questions.length) res = r;
          if (res.questions.length >= finalNumQ) break; // got the full set
        }
      }
      if (!res?.questions?.length) throw (lastErr || new Error("No questions returned"));
      setQuiz({...res, type:finalType});
      setQIdx(0); setAnswers([]); setSelected(null);
      setScreen("quiz");
    } catch(err) {
      setError(err.message.includes("parse")?t.errAiFormat:err.message);
      setScreen("upload");
    }
  },[isPro,qType,tab,file,textVal,diff,canUseQType,effectiveNumQ,consumeQuestions,uploadFileToAnthropic,requireLogin]);

  const pick    = i => { if(selected===null){ setSelected(i); haptic(); } };
  const nextQ   = (isCorrect, detail) => {
    // `detail` carries what the learner picked (e.g. {selected} for MCQ) so the
    // results screen can show "Your answer" next to the correct one.
    const upd=[...answers,{isCorrect,...(detail||{})}]; setAnswers(upd); setSelected(null);
    if (qIdx+1>=quiz.questions.length) setScreen("results");
    else setQIdx(i=>i+1);
  };
  const nextMCQ = () => { if(selected===null)return; nextQ(selected===quiz.questions[qIdx].correct,{selected}); };
  const retry   = () => { setQIdx(0);setAnswers([]);setSelected(null);setScreen("quiz"); };
  const newMat  = () => { setScreen("upload");setQuiz(null);setFile(null);setTextVal("");setError(""); };

  const score = answers.filter(a=>a.isCorrect).length;
  const pct   = quiz ? Math.round((score/quiz.questions.length)*100) : 0;
  const badge = pct>=90?{emoji:"🏆",text:t.excellent}:pct>=75?{emoji:"🎯",text:t.great}:pct>=60?{emoji:"📚",text:t.good}:{emoji:"💪",text:t.keep};

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
    setTab("file"); setFile(null); setTextVal(""); setError(""); setLimitHit(false);
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
      const ownerName = (user?.email || "").split("@")[0] || "";
      const res = await fetch("/api/study", {
        method:"POST",
        headers:{ "Content-Type":"application/json", ...(token ? { Authorization:`Bearer ${token}` } : {}) },
        body: JSON.stringify({ action:"createShare", quiz:{ title:quiz?.title, subject:quiz?.subject, type:quiz?.type, diff, questions:quiz?.questions, owner:ownerName } }),
      });
      const d = await res.json().catch(()=>({}));
      if (!res.ok || !d.id) throw new Error();
      setShareLink(`${window.location.origin}/q/${d.id}`);
      setShareOpen(true);
    } catch { setShareErr(t.shareErr); setShareOpen(true); }
    setShareBusy(false);
  };
  const copyShare = async () => { try { await navigator.clipboard.writeText(shareLink); setShareCopied(true); setTimeout(()=>setShareCopied(false),1800); } catch { /* ignore */ } };
  // Generate a full standardized mock (all sections, from spec — no upload).
  const startMock = async () => {
    if (requireLogin()) return;
    if (!isPro) { setShowProModal(true); return; }
    const exam = getMock(mockPresetId) || MOCK_EXAMS[0];
    setMockGenErr(""); setScreen("mock_gen");
    try {
      // One difficulty tilt for the whole form (luck of the draw) — the learner
      // can't choose it. Weighted: ~25% easier, ~50% standard, ~25% harder.
      const tilt = ["easier", "standard", "standard", "harder"][Math.floor(Math.random() * 4)];
      const settled = await Promise.allSettled(exam.sections.map((s) => callMockSection(exam, s, tilt)));
      const usable = exam.sections
        .map((s, i) => ({ ...s, questions: settled[i].status === "fulfilled" ? settled[i].value : [] }))
        .filter((s) => s.questions.length);
      if (!usable.length) throw new Error("Couldn't generate the exam — please try again.");
      submittedSecRef.current = -1;
      setMock({ presetId: exam.id, name: exam.name, scaleMin: exam.scaleMin, scaleMax: exam.scaleMax, sections: usable });
      setMockSecIdx(0); setMockQIdx(0); setMockAns(usable.map(() => []));
      setMockSecResults([]); setMockSecTimeLeft(usable[0].minutes * 60);
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
            </div>
          </div>
          <h1 className="rv-hero-head" style={Sb.h1}>{t.tagline}</h1>
          <p className="rv-hero-sub" style={{fontSize:14,color:"#c7d2fe",lineHeight:1.6,margin:0,maxWidth:300}}>{t.sub}</p>
          <button className="rv-hero-cta" style={Sb.btnHero} onClick={()=>setScreen("upload")}>{t.start}</button>
        </div>
      </div>

      <div className="rv-home-body" style={{padding:"20px 16px 32px"}}>
        {/* Smart Review — spaced repetition of missed questions + exam countdown */}
        <div style={{background:srs.dueCount>0?"linear-gradient(135deg,#4f46e5,#6366f1)":"var(--color-background-primary)",border:srs.dueCount>0?"none":"0.5px solid var(--color-border-tertiary)",borderRadius:14,padding:"14px 16px",marginBottom:18,boxShadow:srs.dueCount>0?"0 4px 16px rgba(79,70,229,0.3)":"none"}}>
          <div style={{display:"flex",alignItems:"center",gap:12}}>
            <span style={{fontSize:24,flexShrink:0}}>🔁</span>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontWeight:700,fontSize:14,color:srs.dueCount>0?"#fff":"var(--color-text-primary)"}}>{t.srsTitle}</div>
              <div style={{fontSize:11.5,marginTop:2,lineHeight:1.4,color:srs.dueCount>0?"rgba(255,255,255,0.85)":"var(--color-text-secondary)"}}>
                {srs.dueCount>0 ? t.srsDue.replace("{n}",srs.dueCount).replace("{s}",srs.dueCount>1?"s":"") :
                 srs.totalCount>0 ? t.srsCaughtUp.replace("{n}",srs.totalCount).replace("{s}",srs.totalCount>1?"s":"") :
                 t.srsEmpty}
              </div>
            </div>
            {srs.dueCount>0
              ? <button onClick={startReview} style={{flexShrink:0,background:"#fff",color:"#4f46e5",border:"none",borderRadius:10,padding:"9px 16px",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>{t.srsReview}</button>
              : srs.totalCount>0 && <span style={{flexShrink:0,fontSize:20}}>✅</span>}
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
        {/* Weak-topic nudge — from the review deck */}
        {topicsWeak.length>0 && (
          <div style={{display:"flex",alignItems:"center",gap:10,background:"#fff7ed",border:"0.5px solid #fed7aa",borderRadius:12,padding:"10px 14px",marginBottom:18}}>
            <span style={{fontSize:16,flexShrink:0}}>🎯</span>
            <div style={{flex:1,fontSize:12,color:"#9a3412",lineHeight:1.4,overflow:"hidden",textOverflow:"ellipsis"}}>{t.weakestLabel}: <strong>{topicsWeak.map(x=>x.label).join(", ")}</strong></div>
          </div>
        )}
        {/* AI Study Coach — day-by-day exam plan */}
        {!homePlan ? (
          <div style={{background:"var(--color-background-primary)",border:"0.5px solid var(--color-border-tertiary)",borderRadius:14,padding:"14px 16px",marginBottom:18}}>
            <div style={{display:"flex",alignItems:"center",gap:12}}>
              <span style={{fontSize:24,flexShrink:0}}>🧭</span>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontWeight:700,fontSize:14,color:"var(--color-text-primary)"}}>{t.coachTitle}</div>
                <div style={{fontSize:11.5,marginTop:2,lineHeight:1.4,color:"var(--color-text-secondary)"}}>{t.coachTagline}</div>
              </div>
              <button onClick={openPlanSetup} style={{flexShrink:0,background:"#4f46e5",color:"#fff",border:"none",borderRadius:10,padding:"9px 14px",fontSize:12.5,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>{t.coachCreate}</button>
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
            <div style={{background:due?"linear-gradient(135deg,#4f46e5,#6366f1)":"var(--color-background-primary)",border:due?"none":"0.5px solid var(--color-border-tertiary)",borderRadius:14,padding:"14px 16px",marginBottom:18,boxShadow:due?"0 4px 16px rgba(79,70,229,0.3)":"none"}}>
              <div style={{display:"flex",alignItems:"center",gap:12}}>
                <span style={{fontSize:24,flexShrink:0}}>🧭</span>
                <div style={{flex:1,minWidth:0,cursor:"pointer"}} onClick={()=>{setActivePlanId(homePlan.id);setConfirmDelPlan(false);setScreen("plan");}}>
                  <div style={{fontWeight:700,fontSize:14,color:due?"#fff":"var(--color-text-primary)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{homePlan.title}</div>
                  <div style={{fontSize:11.5,marginTop:2,lineHeight:1.4,color:due?"rgba(255,255,255,0.85)":"var(--color-text-secondary)"}}>
                    {complete ? t.coachAllDone : `${t.coachProgressLbl.replace("{done}",prog.done).replace("{total}",prog.total)} · ${countdown}`}
                  </div>
                </div>
                {complete
                  ? <button onClick={()=>{setActivePlanId(homePlan.id);setScreen("plan");}} style={{flexShrink:0,background:"var(--color-background-secondary)",color:"var(--color-text-primary)",border:"0.5px solid var(--color-border-secondary)",borderRadius:10,padding:"9px 14px",fontSize:12.5,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>{t.coachViewPlan}</button>
                  : <button onClick={()=>startPlanDay(homePlan, nd)} style={{flexShrink:0,background:due?"#fff":"#4f46e5",color:due?"#4f46e5":"#fff",border:"none",borderRadius:10,padding:"9px 14px",fontSize:12.5,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>{due?t.coachStart:t.coachContinue}</button>}
              </div>
              {!complete && day && (
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:10,marginTop:12,paddingTop:12,borderTop:due?"0.5px solid rgba(255,255,255,0.2)":"0.5px solid var(--color-border-tertiary)"}}>
                  <span style={{fontSize:12,fontWeight:600,color:due?"rgba(255,255,255,0.9)":"var(--color-text-secondary)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>📖 {day.label}</span>
                  <span style={{flexShrink:0,fontSize:10,fontWeight:700,letterSpacing:0.3,background:due?"rgba(255,255,255,0.2)":"#ede9fe",color:due?"#fff":"#4f46e5",borderRadius:8,padding:"3px 8px"}}>{day.format==="exam"?t.coachExamFormat:(t.quizTypes?.[day.format]||day.format)}</span>
                </div>
              )}
            </div>
          );
        })()}
        <p style={Sb.secLabel}>{t.whatUpload}</p>
        <div className="rv-feat-grid" style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:20}}>
          {[...t.features.filter(([icon])=>icon!=="🔗"), t.langFeature].map(([icon,title,sub],i)=>(
            <div key={i} style={Sb.fCard}>
              <span style={{fontSize:22}}>{icon}</span>
              <span style={{fontSize:13,fontWeight:600,color:"var(--color-text-primary)"}}>{title}</span>
              <span style={{fontSize:11,color:"var(--color-text-secondary)",lineHeight:1.4}}>{sub}</span>
            </div>
          ))}
        </div>

        <div className="rv-plans-row" style={{display:"flex",gap:10,marginBottom:18}}>
          {/* Free card only shown to free users — hidden once Pro. */}
          {!isPro && (
            <div style={Sb.planCard}>
              <div style={{fontWeight:700,fontSize:14,marginBottom:4}}>{t.freeLabel}</div>
              <div style={{fontSize:11,color:"var(--color-text-secondary)",lineHeight:1.7}}>{t.freeDesc}</div>
              <button style={{...Sb.btnPrimary,width:"100%",marginTop:10,fontSize:13}} onClick={()=>setScreen("upload")}>{t.startFree}</button>
            </div>
          )}
          <div style={{...Sb.planCard,border:"2px solid #f59e0b",background:"#fffbeb",position:"relative",overflow:"hidden"}}>
            <div style={{position:"absolute",top:0,left:0,right:0,height:3,background:"linear-gradient(90deg,#f59e0b,#fbbf24)"}}/>
            <div style={{fontWeight:700,fontSize:14,marginBottom:2,color:"#92400e"}}>✦ {t.proLabel}</div>
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
          <button onClick={()=>setSoundOn(s=>!s)} title={soundOn?t.soundOn:t.soundOff} style={{background:"none",border:"none",fontSize:16,cursor:"pointer",padding:"2px 4px",opacity:soundOn?1:0.4}}>{soundOn?"🔊":"🔇"}</button>
          <button onClick={()=>openSettings()} title={t.set.title} style={{background:"none",border:"none",fontSize:16,cursor:"pointer",padding:"2px 4px",color:"var(--color-text-secondary)"}}>⚙️</button>
        </div>
      </div>
      <div className="rv-upload-body" style={{padding:"18px 16px 32px"}}>
        <div className="rv-ul-left">
        {planSession && (
          <div style={{display:"flex",alignItems:"center",gap:10,background:"linear-gradient(135deg,#4f46e5,#6366f1)",borderRadius:12,padding:"11px 14px",marginBottom:14,color:"#fff"}}>
            <span style={{fontSize:18,flexShrink:0}}>🧭</span>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontSize:12.5,fontWeight:700,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{t.coachSessionBanner} · {planSession.label}</div>
              <div style={{fontSize:11,opacity:0.85,marginTop:1}}>{t.quizTypes?.[planSession.format]||planSession.format} · {planSession.numQ} Qs</div>
            </div>
            <button onClick={backToPlan} style={{flexShrink:0,background:"rgba(255,255,255,0.2)",color:"#fff",border:"none",borderRadius:8,padding:"6px 10px",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>{t.coachBackToPlan}</button>
          </div>
        )}
        <h2 style={Sb.h2}>{t.uploadTitle}</h2>
        <div style={{display:"flex",gap:5,marginBottom:16}}>
          {[["file",t.tabs[0]],["text",t.tabs[1]],["photo",t.tabs[3]]].map(([id,lb])=> <button key={id} onClick={()=>setTab(id)} style={{flex:1,padding:"8px 4px",borderRadius:8,border:"0.5px solid",borderColor:tab===id?"#4f46e5":"var(--color-border-secondary)",background:tab===id?"#4f46e5":"var(--color-background-primary)",color:tab===id?"#fff":"var(--color-text-secondary)",fontSize:11,cursor:"pointer",fontFamily:"inherit",fontWeight:500,transition:"all 0.15s"}}>{lb}</button>)}
        </div>
        {tab==="file" && (
          <div style={{...Sb.dropzone,...(drag?{borderColor:"#4f46e5",background:"#ede9fe"}:{}),...(file?{borderStyle:"solid",borderColor:"#4f46e5"}:{})}}
            onDragOver={e=>{e.preventDefault();setDrag(true);}} onDragLeave={()=>setDrag(false)}
            onDrop={e=>{e.preventDefault();setDrag(false);loadFile(e.dataTransfer.files[0]);}}
            onClick={()=>fileRef.current.click()}>
            <input ref={fileRef} type="file" accept=".pdf,.txt,.md,.csv,image/*" style={{display:"none"}} onChange={e=>loadFile(e.target.files[0])}/>
            {file?(<><div style={{fontSize:32}}>{file.type==="pdf"?"📄":file.type==="image"?"🖼️":"📝"}</div><div style={{fontWeight:600,fontSize:14,color:"var(--color-text-primary)"}}>{file.name}</div><div style={{fontSize:11,color:"var(--color-text-tertiary)"}}>{fmtMB(file.sizeMB*1024*1024)} · {t.tapChange}</div></>):(<><div style={{fontSize:32}}>📂</div><div style={{fontSize:14,fontWeight:600,color:"var(--color-text-primary)"}}>{t.dropTitle}</div><div style={{fontSize:12,color:"var(--color-text-secondary)"}}>{t.dropSub}</div><div style={{fontSize:11,color:"var(--color-text-tertiary)",marginTop:2}}>{isPro?t.unlimited:t.maxFileFree.replace("{n}",fileLimitMB())}</div></>)}
          </div>
        )}
        {tab==="file" && !isPro && (
          unlocks.isUnlocked("filesize")
            ? <div style={{fontSize:11,color:"var(--color-text-success)",marginTop:8,fontWeight:600}}>🔓 {AD_FILE_MB}MB uploads unlocked · {unlocks.remainingLabel("filesize")} left</div>
            : <button onClick={()=>setUnlockFeature("filesize")} style={{fontSize:11,color:"#f59e0b",background:"none",border:"none",cursor:"pointer",fontFamily:"inherit",padding:"6px 0 0",textAlign:"left",display:"block"}}>
                {unlocks.canUnlock("filesize") ? t.adWatchFile.replace("{n}",AD_FILE_MB) : t.adFileUsed.replace("{n}",AD_FILE_MB)}
              </button>
        )}
        {tab==="photo" && (
          <div style={{...Sb.dropzone,...(file&&file.type==="image"?{borderStyle:"solid",borderColor:"#4f46e5"}:{})}} onClick={()=>photoRef.current.click()}>
            <input ref={photoRef} type="file" accept="image/*" capture="environment" style={{display:"none"}} onChange={e=>loadFile(e.target.files[0])}/>
            {file&&file.type==="image"?(<><div style={{fontSize:32}}>🖼️</div><div style={{fontWeight:600,fontSize:14,color:"var(--color-text-primary)"}}>{file.name}</div><div style={{fontSize:11,color:"var(--color-text-tertiary)"}}>{t.tapChange}</div></>):(<><div style={{fontSize:48}}>📷</div><div style={{fontSize:14,fontWeight:600,color:"var(--color-text-primary)"}}>{t.photoTitle}</div><div style={{fontSize:12,color:"var(--color-text-secondary)"}}>{t.photoHint}</div></>)}
          </div>
        )}
        {tab==="text" && <textarea value={textVal} onChange={e=>setTextVal(e.target.value)} placeholder={t.pasteHint} style={Sb.textarea}/>}
        {error && <div style={{background:"#fef2f2",border:"0.5px solid #fecaca",borderRadius:10,padding:"10px 14px",fontSize:13,color:"#b91c1c",marginBottom:14,lineHeight:1.5}}>⚠️ {error}</div>}
        {limitHit && <button onClick={()=>setShowPacks(true)} style={{...Sb.btnPrimary,width:"100%",marginBottom:14,background:"#4f46e5"}}>💎 {t.getMoreQuestions}</button>}
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
              <span style={{fontWeight:700,fontSize:14,color:"#4f46e5",minWidth:32,textAlign:"right"}}>{Math.min(numQ,qCap())}</span>
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
                  onChange={e=>{const v=parseInt(e.target.value);setNumQ(v);setCustomQ(String(v));if(!canCustomQ())setUseCustomQ(false);}}
                  style={{flex:1,accentColor:"#4f46e5",cursor:"pointer"}}
                />
                {useCustomQ&&canCustomQ()&&(
                  <input type="number" min={1} max={qCap()} inputMode="numeric" value={customQ}
                    onChange={e=>{const s=e.target.value.replace(/[^0-9]/g,"").slice(0,3);setCustomQ(s);const n=parseInt(s,10);if(!isNaN(n))setNumQ(Math.min(Math.max(n,1),qCap()));}}
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
              {t.diffOpts.map((d,i)=><Chip key={d} small label={d} active={diff===i} onClick={()=>setDiff(i)}/>)}
            </div>
          </div>
        </div>
        {/* Usage strip — questions remaining today (server-tracked). */}
        <div style={{background:isPro?"var(--color-background-secondary)":"#fffbeb",border:isPro?"0.5px solid var(--color-border-tertiary)":"1px solid #f59e0b44",borderRadius:10,padding:"10px 14px",fontSize:12,color:isPro?"var(--color-text-secondary)":"#92400e",marginBottom:14}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:8}}>
            <span><strong>{usage?.remaining ?? (isPro?250:50)}</strong> {t.questionsLeftToday} · {usage?.questions_used_today ?? 0}/{usage?.daily_limit ?? (isPro?250:50)} {t.used}{(usage?.bonus_questions_remaining>0)?` · +${usage.bonus_questions_remaining} ${t.bonusWord}`:""} · {t.maxPerQuiz.replace("{n}",isPro?PRO_MAX_Q:FREE_MAX_Q)}</span>
            {!isPro&&<span onClick={()=>setShowProModal(true)} style={{color:"#f59e0b",fontWeight:700,cursor:"pointer",flexShrink:0,fontSize:11,textDecoration:"underline"}}>{t.goPro}</span>}
          </div>
          {!isPro&&(usage?.remaining??99)<=10&&((usage?.max_ad_watches??2)-(usage?.ad_watches_today??0))>0&&
            <button disabled={adBusy} onClick={handleWatchAd} style={{marginTop:8,width:"100%",background:"#f59e0b",color:"#fff",border:"none",borderRadius:8,padding:"9px",fontSize:12,fontWeight:700,cursor:adBusy?"default":"pointer",fontFamily:"inherit",opacity:adBusy?0.6:1}}>
              {adBusy?t.loadingAd:`📺 ${t.watchAdForQuestions.replace("{n}",usage?.ad_question_bonus??10)} · ${usage?.ad_watches_today??0}/${usage?.max_ad_watches??2}`}
            </button>}
        </div>
        {isPro&&<button style={{width:"100%",marginBottom:14,background:"linear-gradient(135deg,#1e1b4b,#4f46e5)",color:"#fff",border:"none",borderRadius:12,padding:"14px 20px",fontSize:15,fontWeight:600,cursor:"pointer",fontFamily:"'Playfair Display',Georgia,serif",display:"flex",alignItems:"center",justifyContent:"space-between"}} onClick={()=>setScreen("exam_setup")}><span>{t.examModeLabel}</span><span style={{fontSize:10,background:"rgba(255,255,255,0.2)",borderRadius:8,padding:"3px 8px",fontWeight:700}}>{t.badgeUnlimited}</span></button>}
        {!isPro&&(
          <div
            onClick={unlocks.examUsedToday()?undefined:enterExamMode}
            style={{background:"#f5f3ff",border:"1.5px solid "+(unlocks.examUnlocked()?"#4f46e5":"#f59e0b55"),borderRadius:12,padding:"14px 16px",marginBottom:14,display:"flex",alignItems:"center",gap:12,cursor:unlocks.examUsedToday()?"default":"pointer",opacity:unlocks.examUsedToday()?0.65:1}}>
            <span style={{fontSize:22,flexShrink:0}}>🎓</span>
            <div style={{flex:1}}>
              <div style={{fontWeight:700,fontSize:14,color:"var(--color-text-primary)"}}>{t.examModeLabel}</div>
              <div style={{fontSize:11,color:"var(--color-text-secondary)",marginTop:2,lineHeight:1.45}}>
                {examAdBusy?t.loadingAd:unlocks.examUsedToday()?t.examAdUsed:unlocks.examUnlocked()?t.examAdUnlocked:t.examAdWatch}
              </div>
            </div>
            <span style={{fontSize:10,background:unlocks.examUsedToday()?"#94a3b8":unlocks.examUnlocked()?"#4f46e5":"#f59e0b",color:"#fff",borderRadius:8,padding:"3px 8px",fontWeight:700,flexShrink:0,whiteSpace:"nowrap"}}>
              {unlocks.examUsedToday()?t.examBadgeUsed:unlocks.examUnlocked()?t.examBadgeReady:t.examBadgeFree}
            </span>
          </div>
        )}
        <div onClick={()=>{ if(requireLogin())return; setMockGenErr(""); setScreen("mock_select"); }}
          style={{background:"linear-gradient(135deg,#1e1b4b,#4f46e5)",borderRadius:12,padding:"14px 16px",marginBottom:14,display:"flex",alignItems:"center",gap:10,cursor:"pointer"}}>
          <span style={{fontSize:22,flexShrink:0}}>🎓</span>
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
      {showPacks&&<PacksModal onClose={()=>setShowPacks(false)} buyPack={buyPack} t={t}/>}
      {showSettings&&<SettingsPanel draft={settingsDraft} update={updateDraft} onApply={applySettings} onCancel={cancelSettings} onSignOut={()=>signOut()} onDeleteAccount={confirmDeleteAccount} requiresPassword={requiresPassword} onReauthenticate={reauthenticate} isPro={isPro} onManageSubscription={openPortal} signedIn={!!user} t={t}/>}
    </div>
  );

  // ── LOADING ──────────────────────────────────────────────────────
  if (screen==="loading") return (
    <div style={{...Sb.root,alignItems:"center",justifyContent:"center",padding:"0 24px",textAlign:"center",minHeight:"100vh",display:"flex",flexDirection:"column"}}><style>{CSS}</style>
      <div className="spin-ring" style={{width:52,height:52,borderRadius:"50%",border:"4px solid var(--color-border-tertiary)",borderTopColor:"#4f46e5"}}/>
      <h2 style={{...Sb.h2,textAlign:"center",marginTop:28}}>{t.generating}</h2>
      <div style={{display:"flex",flexDirection:"column",gap:12,marginTop:24,alignItems:"flex-start"}}>
        {t.genSteps.map((s,i)=>(
          <div key={i} className={`step step-${i}`} style={{display:"flex",alignItems:"center",gap:10,fontSize:13,color:"var(--color-text-secondary)",opacity:0}}>
            <span style={{width:8,height:8,borderRadius:"50%",background:"#4f46e5",flexShrink:0,display:"block"}}/>
            {s}
          </div>
        ))}
      </div>
      <p style={{marginTop:28,maxWidth:300,fontSize:12,lineHeight:1.55,color:"var(--color-text-tertiary)"}}>
        ⏳ {t.genNotice || "Bigger files or a high question count can make generation take a little longer — hang tight."}
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
            <span style={{background:"#ede9fe",color:"#4f46e5",borderRadius:20,padding:"4px 12px",fontSize:11,fontWeight:700}}>{t.diffOpts[diff]}</span>
            <span style={{background:"#ede9fe",color:"#4f46e5",borderRadius:20,padding:"4px 12px",fontSize:11,fontWeight:700}}>{t.quizTypes[quiz.type]}</span>
          </div>
          {quiz.type==="cards"&&<Flashcard key={qIdx} q={q} isLast={isLast} t={t} onNext={ok=>{const u=[...answers,{isCorrect:ok}];setAnswers(u);setSelected(null);if(qIdx+1>=quiz.questions.length)setScreen("results");else setQIdx(i=>i+1);}}/>}
          {quiz.type==="fill" &&<FillBlank  key={qIdx} q={q} isLast={isLast} t={t} feedback={settings.feedback} autoAdvance={settings.autoAdvance} autoSec={autoAdvanceSec} onNext={(ok,picked)=>{const u=[...answers,{isCorrect:ok,picked}];setAnswers(u);setSelected(null);if(qIdx+1>=quiz.questions.length)setScreen("results");else setQIdx(i=>i+1);}}/>}
          {quiz.type==="mcq"  &&(
            <>
              <h3 style={{fontFamily:"'Playfair Display',Georgia,serif",fontSize:19,fontWeight:700,color:"var(--color-text-primary)",lineHeight:1.4,margin:0}}>{q.question}</h3>
              <div style={{display:"flex",flexDirection:"column",gap:9,marginTop:20}}>
                {q.options.map((opt,i)=>{
                  const isChosen=selected===i,isCorrect=q.correct===i;
                  let extra={};
                  if(selected!==null){
                    // Instant: reveal right/wrong. At-end: just mark the picked
                    // option (no correctness shown until the results review).
                    if(instant){if(isCorrect)extra={border:"1.5px solid #22c55e",background:"#f0fdf4",color:"#15803d"};else if(isChosen)extra={border:"1.5px solid #ef4444",background:"#fef2f2",color:"#b91c1c"};else extra={opacity:0.45};}
                    else if(isChosen)extra={border:"1.5px solid #4f46e5",background:"var(--color-sel-tint)"};
                    else extra={opacity:0.55};
                  }
                  return <button key={i} onClick={()=>pick(i)} disabled={selected!==null} className={selected===null?"quiz-opt":""} style={{display:"flex",alignItems:"center",gap:12,background:"var(--color-background-primary)",border:"1.5px solid var(--color-border-tertiary)",borderRadius:12,padding:"13px 14px",cursor:selected!==null?"default":"pointer",fontSize:14,color:"var(--color-text-primary)",fontFamily:"inherit",transition:"all 0.18s",...extra}}>
                    <span style={{width:28,height:28,borderRadius:"50%",background:"var(--color-background-secondary)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,fontWeight:700,flexShrink:0}}>{LETTERS[i]}</span>
                    <span style={{flex:1,textAlign:"left",lineHeight:1.4}}>{opt}</span>
                    {instant&&selected!==null&&isCorrect&&"✅"}{instant&&selected!==null&&isChosen&&!isCorrect&&"❌"}
                  </button>;
                })}
              </div>
              {selected!==null&&instant&&<div style={{borderRadius:10,padding:"12px 14px",marginTop:14,...(selected===q.correct?{background:"#f0fdf4",border:"0.5px solid #86efac",color:"#15803d"}:{background:"#fef2f2",border:"0.5px solid #fca5a5",color:"#b91c1c"})}} className="slide-up"><strong style={{fontSize:14}}>{selected===q.correct?t.correct:t.incorrect}</strong><p style={{margin:"5px 0 0",fontSize:13,lineHeight:1.5}}>{q.explanation}</p></div>}
              {settings.autoAdvance && instant && selected!==null && <AutoAdvanceBar sec={autoAdvanceSec} runId={qIdx} t={t}/>}
              {(!settings.autoAdvance || instant) && <button style={{...Sb.btnPrimary,width:"100%",marginTop:settings.autoAdvance?12:20,opacity:selected===null?0.35:1,cursor:selected===null?"not-allowed":"pointer"}} onClick={nextMCQ} disabled={selected===null}>{settings.autoAdvance?t.skip||t.next:(isLast?t.finish:t.next)}</button>}
            </>
          )}
        </div>
        <ExitModal show={showExitConfirm} onStay={()=>setShowExitConfirm(false)} onLeave={()=>{setShowExitConfirm(false);newMat();}}/>
      </div>
    );
  }

  // ── RESULTS ──────────────────────────────────────────────────────
  if (screen==="results" && quiz) return (
    <div style={Sb.root}><style>{CSS}</style>
      <AdBanners isPro={isPro} bottom={false}/>
      {upgraded && <div style={{position:"fixed",top:0,left:0,right:0,zIndex:800,background:"#16a34a",color:"#fff",textAlign:"center",padding:"11px 14px",fontSize:14,fontWeight:700,fontFamily:"inherit",boxShadow:"0 2px 12px rgba(0,0,0,0.25)"}}>{t.welcomePro}</div>}
      <div style={{background:"linear-gradient(145deg,#1e1b4b,#4f46e5)",padding:"36px 20px 28px",textAlign:"center"}}>
        <div style={{fontSize:50,marginBottom:8}}>{badge.emoji}</div>
        <h2 style={{margin:"0 0 4px",fontSize:22,fontWeight:700,color:"#fff"}}>{badge.text}</h2>
        <div style={{fontSize:46,fontWeight:800,color:"#fff",letterSpacing:-1,fontFamily:"'Playfair Display',Georgia,serif"}}>{pct}%</div>
        <div style={{fontSize:14,color:"rgba(255,255,255,0.7)",marginTop:4}}>{score} {t.outOf} {quiz.questions.length}</div>
        <div style={{fontSize:22,letterSpacing:4,marginTop:14}}>{answers.map((a,i)=><span key={i}>{a.isCorrect?"🟩":"🟥"}</span>)}</div>
      </div>
      <div className="rv-center" style={{padding:"20px 16px"}}>
        {srsAdded>0 && (
          <div style={{display:"flex",alignItems:"center",gap:10,background:"#ede9fe",border:"1px solid #c7d2fe",borderRadius:12,padding:"11px 14px",marginBottom:16}}>
            <span style={{fontSize:18}}>🔁</span>
            <span style={{flex:1,fontSize:12.5,color:"#4338ca",lineHeight:1.4}}>{t.srsAddedMsg.replace("{n}",srsAdded).replace("{s}",srsAdded>1?"s":"")}</span>
            <button onClick={startReview} style={{flexShrink:0,background:"#4f46e5",color:"#fff",border:"none",borderRadius:9,padding:"7px 12px",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>{t.srsReview}</button>
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
        {planSession && (
          <div style={{display:"flex",alignItems:"center",gap:10,background:"linear-gradient(135deg,#4f46e5,#6366f1)",borderRadius:12,padding:"11px 14px",marginBottom:14,color:"#fff"}}>
            <span style={{fontSize:18}}>🧭</span>
            <span style={{flex:1,fontSize:12.5,fontWeight:700,lineHeight:1.4}}>{t.coachComplete}</span>
            <button onClick={backToPlan} style={{flexShrink:0,background:"rgba(255,255,255,0.2)",color:"#fff",border:"none",borderRadius:9,padding:"7px 12px",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>{t.coachBackToPlan}</button>
          </div>
        )}
        <div style={{display:"flex",gap:10,marginBottom:14}}>
          <button style={{...Sb.btnPrimary,flex:1,margin:0}} onClick={retry}>{t.retry}</button>
          <button style={{...Sb.btnOutline,flex:1}} onClick={newMat}>{t.newMat}</button>
        </div>
        <button style={{...Sb.btnOutline,width:"100%",marginBottom:14,borderColor:"#4f46e5",color:"#4f46e5"}} onClick={createShareLink} disabled={shareBusy}>{shareBusy?t.shareCreating:`📤 ${t.shareQuiz}`}</button>
        {shareOpen && <ShareModal link={shareLink} err={shareErr} copied={shareCopied} onCopy={copyShare} onClose={()=>setShareOpen(false)} t={t}/>}
        {!isPro&&adsOn&&<div style={{background:"var(--color-background-secondary)",border:"0.5px dashed var(--color-border-secondary)",borderRadius:10,padding:"8px 14px",textAlign:"center",fontSize:12,color:"var(--color-text-tertiary)",marginBottom:14}}>📣 {t.advertisement}</div>}
        <p style={Sb.secLabel}>{t.review}</p>
        {quiz.type==="match"?
          quiz.questions.map((q,i)=>{
            const a=answers[i];
            return <div key={i} style={{background:"var(--color-background-primary)",borderRadius:10,padding:"14px 14px 14px 11px",marginBottom:10,border:"0.5px solid var(--color-border-tertiary)",borderLeft:`3px solid ${a?.isCorrect?"#22c55e":"#ef4444"}`}} className="fade-in">
              <div style={{display:"flex",gap:8,alignItems:"flex-start",marginBottom:8}}><span style={{fontSize:15,flexShrink:0}}>{a?.isCorrect?"✅":"❌"}</span><span style={{fontSize:14,fontWeight:600,color:"var(--color-text-primary)",lineHeight:1.4}}>{q.question}</span></div>
              {!a?.isCorrect&&a&&<div style={{fontSize:12,color:"#dc2626",marginBottom:4,paddingLeft:23}}>{t.yourAns} {a.chosen||"—"}</div>}
              <div style={{fontSize:12,color:"#16a34a",marginBottom:6,paddingLeft:23,fontWeight:500}}>{t.correctAns} {q.answer||""}</div>
              {!a?.isCorrect&&<ExplainBox t={t} ctx={{question:q.question,correct:q.answer||"",picked:a?.chosen||"",subject:quiz.subject}}/>}
            </div>;
          })
        :
          quiz.questions.map((q,i)=>{
            const a=answers[i];
            return <div key={i} style={{background:"var(--color-background-primary)",borderRadius:10,padding:"14px 14px 14px 11px",marginBottom:10,border:"0.5px solid var(--color-border-tertiary)",borderLeft:`3px solid ${a?.isCorrect?"#22c55e":"#ef4444"}`}} className="fade-in">
              <div style={{display:"flex",gap:8,alignItems:"flex-start",marginBottom:8}}><span style={{fontSize:15,flexShrink:0}}>{a?.isCorrect?"✅":"❌"}</span><span style={{fontSize:14,fontWeight:600,color:"var(--color-text-primary)",lineHeight:1.4}}>{q.question}</span></div>
              {!a?.isCorrect&&a&&(quiz.type==="mcq"||quiz.type==="fill")&&<div style={{fontSize:12,color:"#dc2626",marginBottom:4,paddingLeft:23}}>{t.yourAns} {quiz.type==="mcq"?(q.options?.[a.selected]??"—"):(a.picked||"—")}</div>}
              <div style={{fontSize:12,color:"#16a34a",marginBottom:6,paddingLeft:23,fontWeight:500}}>{t.correctAns} {quiz.type==="mcq"?q.options?.[q.correct]:(q.answer||"")}</div>
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
    return (
      <div style={Sb.root}><style>{CSS}</style>
        <AdBanners isPro={isPro}/>
        <div style={Sb.topbar} className="rv-topbar">
          <button style={Sb.backBtn} onClick={()=>setScreen("home")}>← {t.homeWord}</button>
          <span style={{...Sb.brand,color:"#4f46e5"}}>🔁 {t.srsReview}</span>
          <span style={{fontSize:12,color:"var(--color-text-secondary)",fontWeight:600}}>{done?"":`${Math.min(reviewPos+1,reviewQueue.length)}/${reviewQueue.length}`}</span>
        </div>
        {!done && <PBar v={reviewPos} max={reviewQueue.length||1}/>}
        <div className="rv-center-narrow" style={{padding:"22px 16px 32px"}}>
          {done ? (
            <div style={{textAlign:"center",padding:"30px 0"}}>
              <div style={{fontSize:52,marginBottom:10}}>{reviewQueue.length?"🎉":"✅"}</div>
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
                <div style={{fontSize:11,fontWeight:700,letterSpacing:0.8,color:"var(--color-text-tertiary)",marginBottom:10,textTransform:"uppercase"}}>{t.question}</div>
                <div style={{fontSize:18,fontWeight:600,color:"var(--color-text-primary)",lineHeight:1.45,fontFamily:"'Playfair Display',Georgia,serif"}}>{card.front}</div>
                {reviewShown && (
                  <div className="slide-up" style={{marginTop:18,paddingTop:16,borderTop:"0.5px solid var(--color-border-tertiary)"}}>
                    <div style={{fontSize:11,fontWeight:700,letterSpacing:0.8,color:"#16a34a",marginBottom:8,textTransform:"uppercase"}}>{t.answerWord}</div>
                    <div style={{fontSize:15,fontWeight:600,color:"var(--color-text-primary)",lineHeight:1.5}}>{card.back||"—"}</div>
                    {card.explanation && <p style={{margin:"12px 0 0",fontSize:13,color:"var(--color-text-secondary)",lineHeight:1.55}}>{card.explanation}</p>}
                  </div>
                )}
              </div>
              {!reviewShown ? (
                <button style={{...Sb.btnPrimary,width:"100%",marginTop:18}} onClick={()=>setReviewShown(true)}>{t.showAnswer}</button>
              ) : (
                <div style={{display:"flex",gap:10,marginTop:18}}>
                  <button style={{flex:1,background:"#fef2f2",border:"1.5px solid #fca5a5",color:"#b91c1c",borderRadius:12,padding:"14px",fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}} onClick={()=>gradeCard(false)}>{t.againBtn}</button>
                  <button style={{flex:1,background:"#16a34a",border:"none",color:"#fff",borderRadius:12,padding:"14px",fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}} onClick={()=>gradeCard(true)}>{t.gotIt}</button>
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
        <span style={{...Sb.brand,color:"#4f46e5"}}>{t.examModeLabel}</span>
        <span style={{fontSize:10,background:isPro?"#f59e0b":"#4f46e5",color:"#fff",borderRadius:8,padding:"2px 8px",fontWeight:700,whiteSpace:"nowrap"}}>{isPro?"PRO":t.oneFreePerDay}</span>
      </div>
      <div className="rv-exam-body" style={{padding:"20px 16px 40px"}}>
        <p style={{fontSize:13,color:"var(--color-text-secondary)",marginBottom:20,lineHeight:1.6}}>{t.examModeSub}</p>
        <p style={Sb.secLabel}>{t.examType}</p>
        <div style={{display:"flex",flexDirection:"column",gap:10,marginBottom:22}}>
          {[{id:"mcq",icon:"📋",title:t.fullMCQ,desc:t.fullMCQDesc},{id:"written",icon:"✍️",title:t.fullWritten,desc:t.fullWrittenDesc},{id:"custom",icon:"🎛️",title:t.customMix,desc:t.customMixDesc}].filter(m=>isPro||m.id!=="custom").map(m=>(
            <div key={m.id} onClick={()=>setExamMode(m.id)} className="exam-type-card" style={{display:"flex",alignItems:"center",gap:14,borderRadius:12,padding:"14px 16px",cursor:"pointer",border:"1.5px solid "+(examMode===m.id?"#4f46e5":"var(--color-border-tertiary)"),background:examMode===m.id?"#ede9fe":"var(--color-background-primary)",transition:"all 0.18s",boxShadow:examMode===m.id?"0 4px 16px #4f46e533":"none"}}>
              <span style={{fontSize:26,flexShrink:0}}>{m.icon}</span>
              <div style={{flex:1}}><div style={{fontWeight:600,fontSize:14,color:"var(--color-text-primary)"}}>{m.title}</div><div style={{fontSize:12,color:"var(--color-text-secondary)",marginTop:2}}>{m.desc}</div></div>
              {examMode===m.id&&<span style={{color:"#4f46e5",fontWeight:700,fontSize:18}}>✓</span>}
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
                  <span style={{fontWeight:700,fontSize:18,color:"#4f46e5"}}>{Math.min(Math.max(parseInt(examTotalQ)||1,1),100)}</span>
                </div>
                <input type="range" min={1} max={100} step={1} value={Math.min(Math.max(parseInt(examTotalQ)||1,1),100)} onChange={e=>setExamTotalQ(e.target.value)} style={{width:"100%",accentColor:"#4f46e5",cursor:"pointer"}}/>
                <div style={{display:"flex",justifyContent:"space-between",fontSize:10,color:"var(--color-text-tertiary)",marginTop:2}}><span>1</span><span>100</span></div>
              </div>
            ) : (
              <div style={{background:"var(--color-background-primary)",borderRadius:12,padding:"14px 16px",border:"0.5px solid var(--color-border-tertiary)"}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <span style={{fontSize:13,color:"var(--color-text-secondary)"}}>{t.freeDailyExam}</span>
                  <span style={{fontWeight:700,fontSize:18,color:"#4f46e5"}}>{t.examFreeQCount}</span>
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
              {examSections.length<5&&<button onClick={addSection} style={{background:"#ede9fe",border:"1px solid #a5b4fc",color:"#4f46e5",borderRadius:8,padding:"5px 12px",fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>{t.addSectionBtn}</button>}
            </div>
            <div style={{display:"flex",flexDirection:"column",gap:10}}>
              {examSections.map((sec,si)=>{
                const secMarks=(parseInt(sec.count)||0)*(parseFloat(sec.marksPerQ)||1);
                return (
                  <div key={sec.id} style={{background:"var(--color-background-primary)",borderRadius:12,border:"0.5px solid var(--color-border-tertiary)",overflow:"hidden"}}>
                    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"10px 14px",borderBottom:"0.5px solid var(--color-border-tertiary)",background:si%2===0?"#f5f3ff":"#fef3c7"}}>
                      <span style={{fontWeight:700,fontSize:13,color:si%2===0?"#4f46e5":"#92400e"}}>{t.sectionNum.replace("{n}",si+1)}</span>
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
                          <span style={{fontWeight:700,fontSize:14,color:"#4f46e5"}}>{Math.min(Math.max(parseInt(sec.count)||1,1),100)}</span>
                        </div>
                        <input type="range" min={1} max={100} step={1} value={Math.min(Math.max(parseInt(sec.count)||1,1),100)} onChange={e=>updateSection(sec.id,"count",e.target.value)} style={{width:"100%",accentColor:"#4f46e5",cursor:"pointer"}}/>
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
            <div style={{marginTop:12,background:"linear-gradient(135deg,#1e1b4b,#4f46e5)",borderRadius:10,padding:"12px 16px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
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
          <div style={{display:"flex",gap:8}}>{t.diffOpts.map((d,i)=><Chip key={d} label={d} active={diff===i} onClick={()=>setDiff(i)}/>)}</div>
        </div>
        <p style={Sb.secLabel}>{t.examFiles.toUpperCase()} ({examFiles.filter(Boolean).length}/5)</p>
        <p style={{fontSize:12,color:"var(--color-text-secondary)",marginBottom:12,marginTop:-8}}>{t.examFilesHint}</p>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:22}}>
          {[0,1,2,3,4].map(idx=>{
            const ef=examFiles[idx];
            return (
              <div key={idx}>
                <input ref={examFileRefs[idx]} type="file" accept=".pdf,.txt,.md,.csv,image/*" style={{display:"none"}} onChange={e=>addExamFile(e.target.files[0],idx)}/>
                {ef?(
                  <div style={{background:"#ede9fe",border:"1px solid #a5b4fc",borderRadius:10,padding:"10px",display:"flex",alignItems:"center",gap:8,cursor:"pointer",minHeight:56}} onClick={()=>removeExamFile(idx)}>
                    <span style={{fontSize:18,flexShrink:0}}>{ef.type==="pdf"?"📄":ef.type==="image"?"🖼️":"📝"}</span>
                    <div style={{flex:1,minWidth:0}}><div style={{fontSize:10,fontWeight:600,color:"#3730a3",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{ef.name}</div><div style={{fontSize:9,color:"#6d28d9"}}>{t.tapToRemove}</div></div>
                  </div>
                ):(
                  <div style={{border:"1.5px dashed var(--color-border-secondary)",borderRadius:10,padding:"14px 8px",textAlign:"center",cursor:"pointer",background:"var(--color-background-primary)",minHeight:56,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center"}} onClick={()=>examFileRefs[idx].current.click()}>
                    <div style={{fontSize:18,marginBottom:2}}>📎</div>
                    <div style={{fontSize:10,color:"var(--color-text-tertiary)"}}>{t.addFile}</div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {error&&<div style={{background:"#fef2f2",border:"0.5px solid #fecaca",borderRadius:10,padding:"10px 14px",fontSize:13,color:"#b91c1c",marginBottom:14}}>⚠️ {error}</div>}
        {limitHit && <button onClick={()=>setShowPacks(true)} style={{...Sb.btnPrimary,width:"100%",marginBottom:14,background:"#4f46e5"}}>💎 {t.getMoreQuestions}</button>}
        <button disabled={!examMode||examFiles.filter(Boolean).length===0} style={{...Sb.btnPrimary,width:"100%",opacity:(!examMode||examFiles.filter(Boolean).length===0)?0.35:1,background:"linear-gradient(135deg,#312e81,#4f46e5)"}} onClick={generateExam}>{t.startExam}</button>
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
              <span className={examTimeLeft<60?"rv-timer-flash":""} style={{display:"inline-flex",alignItems:"center",gap:4,fontSize:14,fontWeight:800,fontVariantNumeric:"tabular-nums",color: examTimeLeft<60?"#ef4444" : (examTimeLeft/examTotalSec)>0.5?"var(--color-text-primary)" : (examTimeLeft/examTotalSec)>0.25?"#f59e0b":"#ef4444"}}>🕐 {fmtClock(examTimeLeft)}</span>
            )}
          </div>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            {examTimerOn && !examTimeUp && <button onClick={()=>setExamPaused(true)} title={t.pauseLbl} style={{background:"none",border:"1px solid var(--color-border-secondary)",borderRadius:8,padding:"3px 9px",fontSize:13,cursor:"pointer",color:"var(--color-text-secondary)",fontFamily:"inherit"}}>⏸</button>}
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
            <div style={{background:"linear-gradient(135deg,#1e1b4b,#4f46e5)",borderRadius:10,padding:"10px 16px",marginBottom:14,display:"flex",justifyContent:"space-between",alignItems:"center"}} className="fade-in">
              <span style={{fontWeight:700,fontSize:14,color:"#fff"}}>{t.sectionNum.replace("{n}",q.section)}</span>
              {examMode==="custom"&&examSections[q.section-1]&&(
                <span style={{fontSize:11,color:"rgba(255,255,255,0.75)"}}>{t.qsAndMarks.replace("{q}",examSections[q.section-1].count).replace("{m}",(parseInt(examSections[q.section-1].count)||0)*(parseFloat(examSections[q.section-1].marksPerQ)||1))}</span>
              )}
            </div>
          )}
          <div style={{display:"flex",gap:8,marginBottom:16,flexWrap:"wrap"}}>
            <span style={{background:q.type==="mcq"?"#ede9fe":"#fef3c7",color:q.type==="mcq"?"#4f46e5":"#92400e",borderRadius:20,padding:"4px 12px",fontSize:11,fontWeight:700}}>{q.type==="mcq"?t.quizTypes.mcq:q.type==="fill"?t.quizTypes.fill:t.writtenWord}</span>
            {examAns[examIdx]!==undefined&&<span style={{background:"#f0fdf4",color:"#16a34a",borderRadius:20,padding:"4px 10px",fontSize:11,fontWeight:600}}>{t.answeredWord}</span>}
          </div>
          <h3 style={{fontFamily:"'Playfair Display',Georgia,serif",fontSize:19,fontWeight:700,color:"var(--color-text-primary)",lineHeight:1.4,margin:"0 0 20px"}}>{q.question}</h3>
          {q.type==="mcq"&&(
            <div style={{display:"flex",flexDirection:"column",gap:9}}>
              {q.options.map((opt,i)=>{
                const isSel=examAns[examIdx]===i;
                return <button key={i} onClick={()=>pickExam(i)} className="quiz-opt" style={{display:"flex",alignItems:"center",gap:12,background:isSel?"#ede9fe":"var(--color-background-primary)",border:"1.5px solid "+(isSel?"#4f46e5":"var(--color-border-tertiary)"),borderRadius:12,padding:"13px 14px",cursor:"pointer",fontSize:14,color:"var(--color-text-primary)",fontFamily:"inherit",transition:"all 0.18s"}}>
                  <span style={{width:28,height:28,borderRadius:"50%",background:isSel?"#4f46e5":"var(--color-background-secondary)",color:isSel?"#fff":"var(--color-text-secondary)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,fontWeight:700,flexShrink:0}}>{LETTERS[i]}</span>
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
              <button onClick={nextExam} style={{...Sb.btnPrimary,flex:1,margin:0,background:isLast?"#16a34a":"#4f46e5",fontSize:14}}>{isLast?t.submitExam:t.next}</button>
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
              <div style={{fontSize:34,marginBottom:8}}>📋</div>
              <h3 style={{margin:"0 0 8px",fontSize:18,fontWeight:700,color:"var(--color-text-primary)",fontFamily:"'Playfair Display',Georgia,serif"}}>{t.submitExamQ}</h3>
              <p style={{margin:"0 0 18px",fontSize:13,color:"var(--color-text-secondary)",lineHeight:1.5}}>{t.submitStillHave} <strong style={{color:"#4f46e5"}}>{fmtClock(examTimeLeft||0)}</strong> {t.submitReviewBefore}</p>
              <div style={{display:"flex",flexDirection:"column",gap:10}}>
                <button onClick={()=>{setShowSubmitPrompt(false);setExamReview(true);setExamIdx(0);}} style={{...Sb.btnPrimary,width:"100%",margin:0,background:"#4f46e5",fontSize:14}}>{t.reviewAnswersBtn}</button>
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
      <div style={{fontSize:52,marginBottom:16}}>🤖</div>
      <h2 style={{...Sb.h2,textAlign:"center"}}>{t.evaluating}</h2>
      <p style={{fontSize:13,color:"var(--color-text-secondary)",marginBottom:24}}>{t.aiGradingMsg}</p>
      <div style={{display:"flex",flexDirection:"column",gap:12,alignItems:"flex-start"}}>
        {t.evalSteps.map((s,i)=>(<div key={i} className={"step step-"+i} style={{display:"flex",alignItems:"center",gap:10,fontSize:13,color:"var(--color-text-secondary)",opacity:0}}><span style={{width:8,height:8,borderRadius:"50%",background:"#4f46e5",flexShrink:0,display:"block"}}/>{s}</div>))}
      </div>
    </div>
  );

  // ── EXAM RESULTS ──────────────────────────────────────────────────
  if(screen==="exam_results"&&examEvals){
    const totalPossible=examQs.reduce((s,q)=>s+(q.marksPerQ||1),0);
    const total=examEvals.reduce((s,e,i)=>s+(e.score||0)*(examQs[i]?.marksPerQ||1),0);
    const pct=Math.round((total/totalPossible)*100);
    const passed=pct>=50,excellent=pct>=90;
    const theme=excellent?{bg:"linear-gradient(145deg,#052e16,#16a34a)",emoji:"🏆",title:t.excellentTitle,msg:t.excellentMsg}:passed?{bg:"linear-gradient(145deg,#451a03,#b45309)",emoji:"🎯",title:t.passTitle,msg:t.passMsg}:{bg:"linear-gradient(145deg,#1c0f0f,#b91c1c)",emoji:"📚",title:t.failTitle,msg:t.failMsg};
    return (
      <div style={Sb.root}><style>{CSS}</style>
      <AdBanners isPro={isPro}/>
      {upgraded && <div style={{position:"fixed",top:0,left:0,right:0,zIndex:800,background:"#16a34a",color:"#fff",textAlign:"center",padding:"11px 14px",fontSize:14,fontWeight:700,fontFamily:"inherit",boxShadow:"0 2px 12px rgba(0,0,0,0.25)"}}>{t.welcomePro}</div>}
        {showConfetti&&<Confetti/>}
        <div style={{background:theme.bg,padding:"40px 20px 32px",textAlign:"center"}}>
          <div style={{fontSize:56,marginBottom:8}}>{theme.emoji}</div>
          <h2 style={{margin:"0 0 8px",fontSize:24,fontWeight:700,color:"#fff",fontFamily:"'Playfair Display',Georgia,serif"}}>{theme.title}</h2>
          <div style={{fontSize:52,fontWeight:900,color:"#fff",letterSpacing:-2,fontFamily:"'Playfair Display',Georgia,serif"}}>{pct}%</div>
          <div style={{fontSize:13,color:"rgba(255,255,255,0.7)",marginTop:4}}>
            {(Math.round(total*10)/10)+" / "+totalPossible+(examMode==="custom"?" "+t.marksSuffix:" "+t.ptsSuffix)} · {t.passMark}
          </div>
          {excellent&&<div style={{marginTop:12,fontSize:28,letterSpacing:4}}>🎉🎓🎉</div>}
          <p style={{margin:"14px 0 0",fontSize:14,color:"rgba(255,255,255,0.88)",lineHeight:1.6,maxWidth:300,marginLeft:"auto",marginRight:"auto"}}>{theme.msg}</p>
        </div>
        <div className="rv-center" style={{padding:"20px 16px"}}>
          {srsAdded>0 && (
            <div style={{display:"flex",alignItems:"center",gap:10,background:"#ede9fe",border:"1px solid #c7d2fe",borderRadius:12,padding:"11px 14px",marginBottom:16}}>
              <span style={{fontSize:18}}>🔁</span>
              <span style={{flex:1,fontSize:12.5,color:"#4338ca",lineHeight:1.4}}>{t.srsAddedMsg.replace("{n}",srsAdded).replace("{s}",srsAdded>1?"s":"")}</span>
              <button onClick={startReview} style={{flexShrink:0,background:"#4f46e5",color:"#fff",border:"none",borderRadius:9,padding:"7px 12px",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>{t.srsReview}</button>
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
                {v: examTimeExpired ? t.timeExpiredLbl : (examTimeUsedSec!=null ? Math.floor(examTimeUsedSec/60)+" min "+(examTimeUsedSec%60)+" sec" : "—"), l:t.timeUsedLbl, red:examTimeExpired},
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
                    <span style={{width:22,height:22,borderRadius:"50%",background:si%2===0?"#ede9fe":"#fef3c7",color:si%2===0?"#4f46e5":"#92400e",display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:700,flexShrink:0}}>{si+1}</span>
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
            <div style={{display:"flex",alignItems:"center",gap:10,background:"linear-gradient(135deg,#4f46e5,#6366f1)",borderRadius:12,padding:"11px 14px",marginBottom:16,color:"#fff"}}>
              <span style={{fontSize:18}}>🧭</span>
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
                  <span style={{fontSize:9,fontWeight:700,background:q.type==="mcq"?"#ede9fe":"#fef3c7",color:q.type==="mcq"?"#4f46e5":"#92400e",borderRadius:8,padding:"2px 6px",flexShrink:0,marginTop:2}}>{q.type==="mcq"?t.badgeMcq:q.type==="fill"?t.badgeFill:t.badgeWritten}</span>
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
            <button key={v} onClick={()=>setPlanForm(f=>({...f,mode:v}))} style={{textAlign:"left",display:"flex",gap:10,alignItems:"flex-start",padding:"12px 14px",borderRadius:12,border:"1.5px solid "+(planForm.mode===v?"#4f46e5":"var(--color-border-secondary)"),background:planForm.mode===v?"var(--color-sel-tint)":"var(--color-background-primary)",cursor:"pointer",fontFamily:"inherit"}}>
              <span style={{width:18,height:18,borderRadius:"50%",border:"2px solid "+(planForm.mode===v?"#4f46e5":"var(--color-border-secondary)"),flexShrink:0,marginTop:1,background:planForm.mode===v?"#4f46e5":"transparent",boxShadow:planForm.mode===v?"inset 0 0 0 2px var(--color-background-primary)":"none"}}/>
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
        {planErr && <div style={{background:"#fef2f2",border:"0.5px solid #fecaca",borderRadius:10,padding:"10px 14px",fontSize:13,color:"#b91c1c",marginBottom:14}}>⚠️ {planErr}</div>}
        <button style={{...Sb.btnPrimary,width:"100%"}} onClick={buildAndSavePlan}>🧭 {t.coachBuild}</button>
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
        <div style={{background:"linear-gradient(145deg,#1e1b4b,#4f46e5)",padding:"22px 20px 20px"}}>
          <div style={{fontSize:11,fontWeight:700,letterSpacing:1,color:"rgba(255,255,255,0.7)",textTransform:"uppercase",marginBottom:4}}>{t.coachYourPlan}</div>
          <h2 style={{margin:0,fontSize:21,fontWeight:700,color:"#fff",fontFamily:"'Playfair Display',Georgia,serif"}}>{activePlan.title}</h2>
          <div style={{display:"flex",alignItems:"center",gap:10,marginTop:10,flexWrap:"wrap"}}>
            <span style={{fontSize:12,fontWeight:700,color:"#fff",background:"rgba(255,255,255,0.18)",borderRadius:20,padding:"4px 12px"}}>🎯 {countdown}</span>
            <span style={{fontSize:12,color:"rgba(255,255,255,0.85)"}}>{t.coachProgressLbl.replace("{done}",prog.done).replace("{total}",prog.total)}</span>
          </div>
          <div style={{height:6,background:"rgba(255,255,255,0.2)",borderRadius:3,overflow:"hidden",marginTop:12}}>
            <div style={{height:"100%",width:prog.pct+"%",background:"#fff",borderRadius:3,transition:"width .3s"}}/>
          </div>
        </div>
        <div className="rv-center" style={{padding:"18px 16px 40px"}}>
          {activePlan.mode==="remind" && activePlan.reminderTime && (
            <div style={{display:"flex",alignItems:"center",gap:8,fontSize:12,color:"var(--color-text-secondary)",background:"var(--color-background-secondary)",border:"0.5px solid var(--color-border-tertiary)",borderRadius:10,padding:"9px 12px",marginBottom:14}}>
              🔔 <span style={{flex:1}}>{t.coachReminderTime} <strong style={{color:"var(--color-text-primary)"}}>{activePlan.reminderTime}</strong></span>
              {notifPerm!=="granted" && notifPerm!=="unsupported" && <button onClick={enableReminders} style={{background:"none",border:"none",color:"#4f46e5",fontWeight:700,fontSize:11.5,cursor:"pointer",fontFamily:"inherit",padding:0}}>{t.coachEnableNotif}</button>}
            </div>
          )}
          {rd.score!=null && (
            <div style={{background:"var(--color-background-primary)",border:"0.5px solid var(--color-border-tertiary)",borderRadius:12,padding:"14px 16px",marginBottom:14}}>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
                <span style={{fontSize:12,fontWeight:700,color:"var(--color-text-secondary)",letterSpacing:0.3}}>{t.readinessTitle}</span>
                <span style={{fontSize:12,fontWeight:700,color:rd.score>=75?"#16a34a":rd.score>=45?"#b45309":"#dc2626"}}>{rd.label}</span>
              </div>
              <div style={{display:"flex",alignItems:"center",gap:12}}>
                <span style={{fontSize:30,fontWeight:800,color:"var(--color-text-primary)",fontFamily:"'Playfair Display',Georgia,serif",minWidth:58}}>{rd.score}%</span>
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
            const stColor = st==="done"?"#16a34a":st==="today"?"#4f46e5":st==="missed"?"#b45309":"var(--color-text-tertiary)";
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
                      <span style={{fontSize:9.5,fontWeight:700,letterSpacing:0.3,background:"#ede9fe",color:"#4f46e5",borderRadius:7,padding:"2px 6px"}}>{KIND[day.kind]||day.kind}</span>
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
                        <button onClick={()=>startPlanDay(activePlan,i)} style={{flex:2,background:isNext?"#4f46e5":"var(--color-background-secondary)",color:isNext?"#fff":"var(--color-text-primary)",border:isNext?"none":"0.5px solid var(--color-border-secondary)",borderRadius:9,padding:"8px",fontSize:12.5,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>▶ {t.coachStart}</button>
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
          <div style={{fontSize:36,marginBottom:6}}>🎓</div>
          <h2 style={{...Sb.h2,textAlign:"center",margin:"0 0 4px"}}>{t.mockChoose}</h2>
          <p style={{fontSize:12.5,color:"var(--color-text-secondary)",lineHeight:1.5}}>{t.mockSelectSub}</p>
        </div>
        {MOCK_EXAMS.map(exam=>(
          <div key={exam.id} onClick={()=>{setMockPresetId(exam.id);setMockGenErr("");setScreen("mock_intro");}}
            style={{display:"flex",alignItems:"center",gap:12,background:"var(--color-background-primary)",border:"0.5px solid var(--color-border-tertiary)",borderRadius:14,padding:"14px 16px",marginBottom:10,cursor:"pointer"}} className="exam-type-card">
            <div style={{width:46,height:46,borderRadius:11,background:"linear-gradient(135deg,#1e1b4b,#4f46e5)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,color:"#fff",fontWeight:800,fontSize:13,letterSpacing:0.2,fontFamily:"'Playfair Display',Georgia,serif"}}>{exam.name.split("/")[0].slice(0,4)}</div>
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
            <div style={{fontSize:40,marginBottom:6}}>🎓</div>
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
          <div style={{background:"#fffbeb",border:"0.5px solid #f59e0b44",borderRadius:10,padding:"11px 14px",fontSize:12,color:"#92400e",lineHeight:1.5,marginBottom:14}}>⏱️ {t.mockWarn}</div>
          {mockGenErr && <div style={{background:"#fef2f2",border:"0.5px solid #fecaca",borderRadius:10,padding:"10px 14px",fontSize:13,color:"#b91c1c",marginBottom:14}}>⚠️ {mockGenErr}</div>}
          {isPro
            ? <button style={{...Sb.btnPrimary,width:"100%"}} onClick={startMock}>🎓 {t.mockStart}</button>
            : <button style={{...Sb.btnPrimary,width:"100%",background:"#f59e0b"}} onClick={()=>{if(requireLogin())return;setShowProModal(true);}}>⭐ {t.mockProOnly}</button>}
          <p style={{fontSize:11,color:"var(--color-text-tertiary)",textAlign:"center",marginTop:12,lineHeight:1.5}}>{t.mockDisclaimer}</p>
        </div>
        {showProModal&&<ProModal onClose={()=>{setShowProModal(false);setCoErr("");}} t={t} onMonthly={()=>doCheckout(STRIPE_MONTHLY_PRICE,"monthly")} onYearly={()=>doCheckout(STRIPE_YEARLY_PRICE,"yearly")} busy={coBusy} error={coErr}/>}
      </div>
    );
  }

  // ── MOCK EXAM: generating ─────────────────────────────────────────
  if (screen==="mock_gen") return (
    <div style={{...Sb.root,alignItems:"center",justifyContent:"center",padding:"0 24px",textAlign:"center",minHeight:"100vh",display:"flex",flexDirection:"column"}}><style>{CSS}</style>
      <div className="spin-ring" style={{width:52,height:52,borderRadius:"50%",border:"4px solid var(--color-border-tertiary)",borderTopColor:"#4f46e5"}}/>
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
    return (
      <div style={Sb.root}><style>{CSS}</style>
        <div style={Sb.topbar} className="rv-topbar">
          <span style={{fontSize:13,fontWeight:700,color:"var(--color-text-primary)"}}>{sec.name}</span>
          <span style={{fontSize:11,color:"var(--color-text-secondary)"}}>{t.mockSection} {mockSecIdx+1}/{mock.sections.length}</span>
          <span className={low?"rv-timer-flash":""} style={{fontSize:15,fontWeight:800,color:low?"#dc2626":"#4f46e5",fontVariantNumeric:"tabular-nums"}}>{mm}:{String(ss).padStart(2,"0")}</span>
        </div>
        <PBar v={mockQIdx} max={sec.questions.length}/>
        <div className="rv-center-narrow" style={{padding:"16px 16px 32px"}}>
          <div style={{fontSize:12,color:"var(--color-text-secondary)",marginBottom:10}}>{t.question} {mockQIdx+1} {t.outOf} {sec.questions.length}</div>
          <h3 style={{fontFamily:"'Playfair Display',Georgia,serif",fontSize:16.5,fontWeight:700,color:"var(--color-text-primary)",lineHeight:1.5,margin:0,whiteSpace:"pre-wrap"}}>{q.question}</h3>
          {q.svg && <div style={{margin:"14px 0 2px",display:"flex",justifyContent:"center"}}><img alt="Figure" src={"data:image/svg+xml;charset=utf-8,"+encodeURIComponent(q.svg)} style={{maxWidth:"100%",maxHeight:300,background:"#fff",borderRadius:10,border:"0.5px solid var(--color-border-tertiary)",padding:10,boxSizing:"border-box"}}/></div>}
          <div style={{display:"flex",flexDirection:"column",gap:9,marginTop:16}}>
            {q.options.map((opt,i)=>{
              const chosen = sel===i;
              return <button key={i} onClick={()=>pick(i)} style={{display:"flex",alignItems:"center",gap:12,background:chosen?"var(--color-sel-tint)":"var(--color-background-primary)",border:`1.5px solid ${chosen?"#4f46e5":"var(--color-border-tertiary)"}`,borderRadius:12,padding:"12px 14px",cursor:"pointer",fontSize:14,color:"var(--color-text-primary)",fontFamily:"inherit",textAlign:"left"}}>
                <span style={{width:26,height:26,borderRadius:"50%",background:chosen?"#4f46e5":"var(--color-background-secondary)",color:chosen?"#fff":"var(--color-text-primary)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,fontWeight:700,flexShrink:0}}>{LETTERS[i]}</span>
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
      </div>
    );
  }

  // ── MOCK EXAM: rest between sections ──────────────────────────────
  if (screen==="mock_break" && mock) {
    const next = mock.sections[mockSecIdx+1];
    return (
      <div style={Sb.root}><style>{CSS}</style>
        <div className="rv-center-narrow" style={{minHeight:"100vh",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",textAlign:"center",padding:"40px 20px"}}>
          <div style={{fontSize:52,marginBottom:12}}>☕</div>
          <h2 style={{...Sb.h2,margin:"0 0 6px"}}>{t.mockBreakTitle}</h2>
          <p style={{fontSize:14,color:"var(--color-text-secondary)",lineHeight:1.6,maxWidth:340,margin:"0 auto 6px"}}>{t.mockBreakSub}</p>
          <div style={{fontSize:12,color:"var(--color-text-tertiary)",marginBottom:24}}>{t.mockSectionDone.replace("{n}",mockSecIdx+1).replace("{total}",mock.sections.length)}</div>
          {next && (
            <div style={{background:"var(--color-background-primary)",border:"0.5px solid var(--color-border-tertiary)",borderRadius:14,padding:"16px 18px",maxWidth:360,width:"100%",boxSizing:"border-box",marginBottom:20}}>
              <div style={{fontSize:10.5,fontWeight:800,letterSpacing:0.8,color:"var(--color-text-tertiary)",textTransform:"uppercase",marginBottom:6}}>{t.mockUpNext}</div>
              <div style={{fontSize:18,fontWeight:700,color:"var(--color-text-primary)",fontFamily:"'Playfair Display',Georgia,serif"}}>{next.name}</div>
              <div style={{fontSize:12.5,color:"var(--color-text-secondary)",marginTop:4}}>{next.questions.length} {t.questionsLow} · {next.minutes} min</div>
            </div>
          )}
          <button onClick={startNextSection} style={{...Sb.btnPrimary,maxWidth:360,width:"100%",margin:0}}>{t.mockStartNext}</button>
        </div>
      </div>
    );
  }

  // ── MOCK EXAM: results ────────────────────────────────────────────
  if (screen==="mock_results" && mock) {
    const comp = compositeScore(mockSecResults.map(r=>r.scaled), mock);
    return (
      <div style={Sb.root}><style>{CSS}</style>
        <AdBanners isPro={isPro}/>
        <div style={{background:"linear-gradient(145deg,#1e1b4b,#4f46e5)",padding:"34px 20px 26px",textAlign:"center"}}>
          <div style={{fontSize:11,fontWeight:700,letterSpacing:1,color:"rgba(255,255,255,0.7)",textTransform:"uppercase"}}>{mock.name} {t.mockComposite}</div>
          <div style={{fontSize:58,fontWeight:800,color:"#fff",fontFamily:"'Playfair Display',Georgia,serif",lineHeight:1.1}}>{comp}</div>
          <div style={{fontSize:13,color:"rgba(255,255,255,0.7)"}}>{t.mockOutOf} {compositeMax(mock)}</div>
        </div>
        <div className="rv-center" style={{padding:"20px 16px 40px"}}>
          <div style={Sb.settingsBox}>
            {mockSecResults.map((r,i)=>(
              <div key={i} style={{...Sb.settingRow,borderBottom:i<mockSecResults.length-1?"0.5px solid var(--color-border-tertiary)":"none"}}>
                <span style={Sb.settingLabel}>{r.name}</span>
                <span style={{fontSize:12.5,color:"var(--color-text-secondary)"}}>{r.raw}/{r.count} · <strong style={{color:"var(--color-text-primary)",fontSize:15}}>{r.scaled}</strong></span>
              </div>
            ))}
          </div>
          <div style={{display:"flex",gap:10,marginBottom:16}}>
            <button style={{...Sb.btnPrimary,flex:1,margin:0}} onClick={()=>setScreen("mock_intro")}>{t.mockRetake}</button>
            <button style={{...Sb.btnOutline,flex:1}} onClick={()=>setScreen("upload")}>{t.newMat}</button>
          </div>
          <p style={Sb.secLabel}>{t.review}</p>
          {mock.sections.map((sec,si)=>(
            <div key={si}>
              <div style={{fontSize:12,fontWeight:700,color:"var(--color-text-secondary)",margin:"14px 0 8px",letterSpacing:0.3}}>{sec.name.toUpperCase()}</div>
              {sec.questions.map((q,i)=>{
                const chosen=(mockAns[si]||[])[i];
                const ok=chosen===q.correct;
                return <div key={i} style={{background:"var(--color-background-primary)",borderRadius:10,padding:"12px 13px 12px 11px",marginBottom:9,border:"0.5px solid var(--color-border-tertiary)",borderLeft:`3px solid ${ok?"#22c55e":"#ef4444"}`}} className="fade-in">
                  <div style={{display:"flex",gap:8,alignItems:"flex-start"}}><span style={{fontSize:14,flexShrink:0}}>{ok?"✅":"❌"}</span><span style={{fontSize:13.5,fontWeight:600,color:"var(--color-text-primary)",lineHeight:1.4,whiteSpace:"pre-wrap"}}>{q.question}</span></div>
                  {!ok&&<div style={{fontSize:12,color:"#dc2626",marginTop:5,paddingLeft:22}}>{t.yourAns} {chosen!=null?q.options[chosen]:"—"}</div>}
                  <div style={{fontSize:12,color:"#16a34a",marginTop:3,paddingLeft:22,fontWeight:500}}>{t.correctAns} {q.options[q.correct]}</div>
                  {q.explanation&&<div style={{fontSize:12,color:"var(--color-text-secondary)",lineHeight:1.5,paddingTop:6,marginTop:6,borderTop:"0.5px solid var(--color-border-tertiary)",paddingLeft:22}}>{q.explanation}</div>}
                  {!ok&&<ExplainBox t={t} ctx={{question:q.question,correct:q.options[q.correct],picked:chosen!=null?q.options[chosen]:"",subject:sec.name}}/>}
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
  root:        { minHeight:"100vh", background:"var(--color-background-tertiary)", fontFamily:"'DM Sans','Helvetica Neue',sans-serif", display:"flex", flexDirection:"column" },
  brand:       { fontFamily:"'Playfair Display',Georgia,serif", fontSize:16, fontWeight:700, color:"var(--color-text-primary)", letterSpacing:0.5, display:"flex", alignItems:"center", gap:8 },
  hero:        { background:"linear-gradient(145deg,#1e1b4b 0%,#312e81 60%,#1d4ed8 100%)", padding:"44px 24px 40px" },
  h1:          { fontFamily:"'Playfair Display',Georgia,serif", fontSize:30, fontWeight:700, color:"#fff", lineHeight:1.2, margin:"14px 0 12px" },
  h2:          { fontFamily:"'Playfair Display',Georgia,serif", fontSize:22, fontWeight:700, color:"var(--color-text-primary)", margin:"0 0 16px" },
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
  btnPrimary:  { background:"#4f46e5", color:"#fff", border:"none", borderRadius:12, padding:"13px 20px", fontSize:15, fontWeight:600, cursor:"pointer", fontFamily:"'Playfair Display',Georgia,serif", transition:"opacity 0.15s", margin:0 },
  btnHero:     { background:"#fff", color:"#312e81", border:"none", borderRadius:12, padding:"13px 30px", fontSize:15, fontWeight:700, cursor:"pointer", fontFamily:"inherit" },
  btnOutline:  { background:"none", color:"var(--color-text-primary)", border:"1px solid var(--color-border-secondary)", borderRadius:12, padding:"12px 20px", fontSize:13, fontWeight:500, cursor:"pointer", fontFamily:"inherit" },
  btnGhost:    { background:"none", color:"var(--color-text-secondary)", border:"0.5px solid var(--color-border-tertiary)", borderRadius:12, padding:"11px 20px", fontSize:13, cursor:"pointer", fontFamily:"inherit" },
  coachLabel:  { display:"block", fontSize:12, fontWeight:700, color:"var(--color-text-secondary)", margin:"0 0 6px", letterSpacing:0.2 },
  coachInput:  { width:"100%", borderRadius:10, border:"1.5px solid var(--color-border-secondary)", background:"var(--color-background-primary)", color:"var(--color-text-primary)", fontSize:14, padding:"11px 13px", fontFamily:"inherit", outline:"none", boxSizing:"border-box", marginBottom:14 },
};

const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;700&family=DM+Sans:wght@400;500;600&display=swap');
  *{box-sizing:border-box} body{margin:0}
  .fade-in {animation:fadeIn 0.3s ease both}
  .slide-up{animation:slideUp 0.25s ease both}
  @keyframes fadeIn {from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
  @keyframes slideUp{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}
  @keyframes spin{to{transform:rotate(360deg)}}
  .spin-ring{animation:spin 0.9s linear infinite}
  .step{animation:fadeIn 0.4s ease forwards;opacity:0}
  .step-0{animation-delay:0.3s}.step-1{animation-delay:0.8s}.step-2{animation-delay:1.3s}.step-3{animation-delay:1.8s}
  .exam-type-card:hover{transform:translateY(-2px);box-shadow:0 4px 16px rgba(79,70,229,0.18)!important;border-color:#4f46e5!important;background:var(--color-hover-tint)!important}
  button:hover:not(:disabled){transform:translateY(-1px)}
  button:active:not(:disabled){transform:scale(0.97)}
  .quiz-opt:hover:not(:disabled){transform:translateX(4px)!important;border-color:#4f46e5!important;background:var(--color-hover-tint)!important;box-shadow:2px 0 0 0 #4f46e5}
  .quiz-opt:active:not(:disabled){transform:translateX(2px)!important}
  textarea:focus,input:focus{border-color:#4f46e5!important;box-shadow:0 0 0 2px #4f46e520}
  select{appearance:auto}
  .no-anim *{animation:none!important;transition:none!important}
  @keyframes slideFromRight{from{transform:translateX(100%)}to{transform:translateX(0)}}
  @keyframes rvTimerFlash{0%,100%{opacity:1}50%{opacity:0.25}}
  .rv-timer-flash{animation:rvTimerFlash 1s steps(1) infinite}
  @keyframes rvAutoBar{from{width:0%}to{width:100%}}
  .settings-panel{animation:slideFromRight 0.22s ease}
  ::-webkit-scrollbar{width:4px}::-webkit-scrollbar-thumb{background:var(--color-border-secondary);border-radius:2px}

  /* Hero (mobile base — stacks: back, brand bar, headline, sub, CTA) */
  .rv-hero-bar{display:flex;align-items:center;justify-content:space-between;gap:12px;}
  .rv-hero-tools{display:flex;align-items:center;gap:10px;}
  .rv-hero-sub{margin-top:14px!important;}
  .rv-hero-cta{margin-top:22px;}

  /* ── Desktop layout ────────────────────────────────────────────── */
  @media(min-width:768px){
    /* Root: wider centered card */
    .rv-root-inner{max-width:900px;margin:0 auto;width:100%;}

    /* Hero: two-column editorial layout — brand+sub on the left, headline+CTA
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
