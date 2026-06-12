import { useState, useRef, useCallback, useEffect } from "react";
import { LANGS } from "./i18n.js";
import { useAuth } from "./context/AuthContext.jsx";
import { useLang } from "./context/LanguageContext.jsx";
import { useDev, DevBadge } from "./context/DevContext.jsx";
import { UserButton } from "@clerk/clerk-react";
import { useNavigate } from "react-router-dom";
import { upload as blobUpload } from "@vercel/blob/client";

// ── Limits ────────────────────────────────────────────────────────────
const FREE_MAX_Q   = 20;
const AD_MAX_Q     = 50;
const PRO_MAX_Q    = 100;
const FREE_FILE_MB = 5;
const AD_FILE_MB   = 20;
const PRO_FILE_MB  = 999;
const AD_HOURS     = 1;
const FREE_DAILY   = 3;
const Q_FREE       = [5, 10, 15, 20];
const Q_EXTRA      = [25, 30, 40, 50];
const QUIZ_TYPES   = ["mcq","cards","fill","match"];
const LETTERS      = ["A","B","C","D"];
// Model for all generation/grading. Haiku 4.5: cheap + fast, plenty for
// question writing. ($0.80/1M in, $4/1M out vs Sonnet's $3/$15.)
const AI_MODEL     = "claude-haiku-4-5-20251001";
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
  }
`;

// ── Claude API ────────────────────────────────────────────────────────
async function callClaude({ blocks, numQ, diff, type }) {
  const typeMap = {
    mcq:   `Multiple choice: exactly 4 options. "correct" is 0-based index of the right answer.`,
    cards: `Flashcards: "question" = front (term/concept), "answer" = back (full explanation). Set options:[] correct:0.`,
    fill:  `Fill in the blank: each "question" has exactly one blank written as ___. "answer" = the missing word or phrase. Set options:[] correct:0.`,
    match: `Matching pairs: "question" = term, "answer" = definition. Set options:[] correct:0.`,
  };
  const prompt = `Generate exactly ${numQ} study questions from the material.\nQuiz type: ${typeMap[type]}\nDifficulty: ${diff}.\nReturn ONLY raw JSON (no markdown, no backticks):\n{"title":"Short title","subject":"Subject","questions":[{"question":"...","options":["A","B","C","D"],"correct":0,"answer":"...","explanation":"One sentence"}]}\nMake all 4 options plausible. Vary question styles across the set.`;

  // Scale output budget with the question count so big sets aren't truncated
  // (each Q ≈ 130 tokens). Capped at 16k. max_tokens is a ceiling, not a
  // charge — you're only billed for tokens actually generated.
  const maxTokens = Math.min(Math.max(Math.round(numQ * 160) + 1200, 4000), 16000);

  const res = await fetch("/api/anthropic", {
    method:"POST", headers:{"Content-Type":"application/json"},
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

function Chip({ label, active, onClick, locked, small }) {
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
      {locked && <span style={{marginLeft:4,fontSize:7,background:"#f59e0b",color:"#fff",borderRadius:8,padding:"1px 4px",fontWeight:700,verticalAlign:"middle"}}>PRO</span>}
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

// ── Locked Feature Modal ──────────────────────────────────────────────
function LockedModal({ info, adWatchedToday, adUnlocked, adsOn, onClose, onUpgrade, onWatchAd, t }) {
  if (!info) return null;
  const adLabelKey = info.featureKey.startsWith("quizType:")
    ? info.featureKey.replace("quizType:", "")
    : info.featureKey;
  const adLabel = (t.lockedAdLabels || {})[adLabelKey] || null;
  const adStillActive = adUnlocked && adUnlocked.until > Date.now();
  const timeLeft = adStillActive ? msUntil(adUnlocked.until) : null;
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.55)",zIndex:300,display:"flex",alignItems:"flex-end"}} onClick={onClose}>
      <div className="slide-up" onClick={e=>e.stopPropagation()} style={{background:"var(--color-background-primary)",borderRadius:"20px 20px 0 0",padding:"24px 20px 36px",width:"100%",maxHeight:"80vh",overflowY:"auto",boxSizing:"border-box"}}>
        <div style={{textAlign:"center",marginBottom:20}}>
          <div style={{fontSize:38,marginBottom:8}}>🔒</div>
          <h3 style={{margin:"0 0 6px",fontSize:18,fontWeight:700,color:"var(--color-text-primary)",fontFamily:"'Playfair Display',Georgia,serif"}}>{t.proFeature}</h3>
          <p style={{margin:0,fontSize:13,color:"var(--color-text-secondary)",lineHeight:1.5}}>
            <strong style={{color:"#f59e0b"}}>{t.lockedTitles && t.lockedTitles[info.featureKey]}</strong>
          </p>
        </div>
        {adStillActive && (
          <div style={{background:"#f5f3ff",border:"0.5px solid #c4b5fd",borderRadius:10,padding:"10px 14px",marginBottom:12,fontSize:12,color:"#5b21b6"}}>
            {t.adCurrently} <strong>{t.lockedTitles && t.lockedTitles[adUnlocked.feature]}</strong><br/>
            {t.adExpires}: <strong>{timeLeft}</strong>
          </div>
        )}
        <button onClick={onUpgrade} style={{...Sb.btnPrimary,width:"100%",marginBottom:10,fontFamily:"inherit",fontSize:14,background:"#4f46e5"}}>
          ✦ {t.upgradeToPro}
        </button>
        {adsOn && adLabel && !adWatchedToday && (
          <button onClick={()=>onWatchAd(info.featureKey)} style={{width:"100%",marginBottom:10,background:"#fefce8",border:"1.5px solid #f59e0b",color:"#92400e",borderRadius:12,padding:"12px 14px",fontSize:13,cursor:"pointer",fontFamily:"inherit",lineHeight:1.6,textAlign:"center"}}>
            {t.watchAdBtn}<br/>
            <span style={{fontSize:11,opacity:0.8}}>Unlocks: {adLabel} for {AD_HOURS} hour{AD_HOURS!==1?"s":""}</span>
          </button>
        )}
        {adsOn && adLabel && adWatchedToday && (
          <div style={{background:"var(--color-background-secondary)",borderRadius:10,padding:"10px 14px",marginBottom:10,fontSize:12,color:"var(--color-text-secondary)",textAlign:"center"}}>
            📵 {t.adUsedToday} — {t.adUsedDesc}
          </div>
        )}
        <button onClick={onClose} style={{...Sb.btnGhost,width:"100%",fontSize:13}}>{t.notNow}</button>
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
          <div style={{fontSize:10,fontWeight:700,color:"var(--color-text-tertiary)",letterSpacing:1.5,marginBottom:16}}>{flipped?"ANSWER":"QUESTION"}</div>
          <div style={{fontFamily:"'Playfair Display',Georgia,serif",fontSize:18,fontWeight:700,color:"var(--color-text-primary)",lineHeight:1.5}}>{flipped?ans:q.question}</div>
          <div style={{marginTop:20,fontSize:12,color:"var(--color-text-tertiary)"}}>{flipped?t.flipBack:t.flip}</div>
        </div>
      </div>
      {flipped && (
        <div style={{display:"flex",gap:10,marginTop:14}} className="slide-up">
          <button onClick={()=>{setFlipped(false);setTimeout(()=>onNext(false),200);}} style={{flex:1,background:"#fef2f2",border:"1px solid #fca5a5",color:"#b91c1c",borderRadius:12,padding:"12px",fontSize:14,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>✗ Didn't know</button>
          <button onClick={()=>{setFlipped(false);setTimeout(()=>onNext(true),200);}} style={{flex:1,background:"#f0fdf4",border:"1px solid #86efac",color:"#15803d",borderRadius:12,padding:"12px",fontSize:14,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>✓ Got it</button>
        </div>
      )}
    </div>
  );
}

// ── Fill in Blank ─────────────────────────────────────────────────────
function FillBlank({ q, onNext, isLast, t }) {
  const [val,setVal]         = useState("");
  const [checked,setChecked] = useState(false);
  const correct = (q.answer||"").toLowerCase().trim();
  const isRight = val.toLowerCase().trim()===correct || correct.includes(val.toLowerCase().trim().slice(0,5));
  const parts = q.question.split("___");
  return (
    <div>
      <div style={{fontFamily:"'Playfair Display',Georgia,serif",fontSize:18,fontWeight:700,color:"var(--color-text-primary)",lineHeight:1.6,marginBottom:20}}>
        {parts[0]}
        <span style={{display:"inline-block",borderBottom:"2px solid #4f46e5",minWidth:80,margin:"0 4px",padding:"0 6px",color:"#4f46e5",fontStyle:"italic"}}>
          {checked?(q.answer||""):(val||"\u00a0\u00a0\u00a0\u00a0\u00a0\u00a0\u00a0\u00a0")}
        </span>
        {parts[1]||""}
      </div>
      {!checked && <input value={val} onChange={e=>setVal(e.target.value)} onKeyDown={e=>e.key==="Enter"&&val.trim()&&setChecked(true)} placeholder={t.typeIn} style={{width:"100%",borderRadius:12,border:"1.5px solid var(--color-border-secondary)",background:"var(--color-background-primary)",color:"var(--color-text-primary)",fontSize:14,padding:"12px 14px",fontFamily:"inherit",outline:"none",boxSizing:"border-box",marginBottom:10}}/>}
      {!checked && <button disabled={!val.trim()} onClick={()=>setChecked(true)} style={{...Sb.btnPrimary,width:"100%",opacity:val.trim()?1:0.35}}>{t.check}</button>}
      {checked && (
        <div style={{borderRadius:10,padding:"12px 14px",background:isRight?"#f0fdf4":"#fef2f2",border:`0.5px solid ${isRight?"#86efac":"#fca5a5"}`,color:isRight?"#15803d":"#b91c1c",marginBottom:14}} className="slide-up">
          <strong>{isRight?t.correct:t.incorrect}</strong>
          {!isRight && <div style={{fontSize:13,marginTop:4}}>Answer: <strong>{q.answer}</strong></div>}
          {q.explanation && <p style={{margin:"6px 0 0",fontSize:13,lineHeight:1.5}}>{q.explanation}</p>}
        </div>
      )}
      {checked && <button onClick={()=>onNext(isRight)} style={{...Sb.btnPrimary,width:"100%"}}>{isLast?t.finish:t.next}</button>}
    </div>
  );
}

// ── Match Quiz ────────────────────────────────────────────────────────
function MatchQuiz({ questions, onDone, t }) {
  const terms = questions.map(q=>q.question);
  const defs  = useRef(questions.map(q=>q.answer||"").sort(()=>Math.random()-0.5)).current;
  const [sel,setSel]         = useState(null);
  const [matches,setMatches] = useState({});
  const [defUsed,setDefUsed] = useState({});
  const [checked,setChecked] = useState(false);
  const [results,setResults] = useState({});
  const pickTerm = i => { if(checked||matches[i]!==undefined)return; setSel(s=>s===i?null:i); };
  const pickDef  = i => {
    if(checked||defUsed[i]||sel===null)return;
    setMatches(m=>({...m,[sel]:i})); setDefUsed(d=>({...d,[i]:true})); setSel(null);
  };
  const check = () => {
    const r={};
    terms.forEach((_,i)=>{ r[i]=defs[matches[i]]===questions[i].answer; });
    setResults(r); setChecked(true);
    setTimeout(()=>onDone(Object.values(r).filter(Boolean).length,terms.length),1800);
  };
  const allMatched = Object.keys(matches).length===terms.length;
  return (
    <div>
      <p style={{fontSize:13,color:"var(--color-text-secondary)",marginBottom:14,lineHeight:1.5}}>{t.matchTitle}</p>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:14}}>
        <div style={{display:"flex",flexDirection:"column",gap:6}}>
          {terms.map((term,i)=>{
            const matched=matches[i]!==undefined,isSel=sel===i,isOk=checked&&results[i],isBad=checked&&!results[i]&&matched;
            return <button key={i} onClick={()=>pickTerm(i)} style={{padding:"10px 12px",borderRadius:10,border:"1.5px solid",borderColor:isOk?"#22c55e":isBad?"#ef4444":isSel?"#4f46e5":matched?"#a5b4fc":"var(--color-border-tertiary)",background:isSel?"#ede9fe":matched?"#f5f3ff":"var(--color-background-primary)",fontSize:12,fontWeight:600,cursor:matched||checked?"default":"pointer",color:"var(--color-text-primary)",fontFamily:"inherit",textAlign:"left",transition:"all 0.15s"}}>
              {isOk&&"✅ "}{isBad&&"❌ "}{term}
            </button>;
          })}
        </div>
        <div style={{display:"flex",flexDirection:"column",gap:6}}>
          {defs.map((def,i)=>{
            const used=defUsed[i];
            return <button key={i} onClick={()=>pickDef(i)} style={{padding:"10px 12px",borderRadius:10,border:"1.5px solid",borderColor:used?"#a5b4fc":"var(--color-border-tertiary)",background:used?"#f5f3ff":"var(--color-background-primary)",fontSize:11,cursor:(used||checked||sel===null)?"default":"pointer",color:used?"var(--color-text-tertiary)":"var(--color-text-primary)",fontFamily:"inherit",textAlign:"left",lineHeight:1.4,transition:"all 0.15s"}}>
              {def}
            </button>;
          })}
        </div>
      </div>
      {!checked && <button disabled={!allMatched} onClick={check} style={{...Sb.btnPrimary,width:"100%",opacity:allMatched?1:0.35}}>{t.checkAll}</button>}
      {checked && <div style={{textAlign:"center",fontSize:14,color:"var(--color-text-secondary)",marginTop:8}}>{t.matchDone}{Object.values(results).filter(Boolean).length}/{terms.length}</div>}
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

function SettingsPanel({ draft, update, onApply, onCancel, onSignOut, onDeleteAccount, requiresPassword, onReauthenticate, isPro, onManageSubscription, t }) {
  const s = t.set || {};
  const { subPlan, periodEnd, cancelAtPeriodEnd, openPortal, startCheckout, refreshProfile } = useAuth();
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
    volume:70,haptics:false,feedback:'immediate',autoAdvance:false,defaultDiff:1,defaultQCount:10};
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
          padding:"18px 18px 14px",borderBottom:"0.5px solid var(--color-border-tertiary)",flexShrink:0}}>
          <span style={{fontSize:18,fontWeight:700,
            fontFamily:"'Playfair Display',Georgia,serif",color:"var(--color-text-primary)"}}>
            ⚙️ {s.title}
          </span>
          <button onClick={onCancel} style={{background:"none",border:"none",fontSize:20,
            cursor:"pointer",color:"var(--color-text-secondary)",lineHeight:1,padding:"2px 6px"}}>✕</button>
        </div>

        <div style={{flex:1,overflowY:"auto"}}>
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
          <div style={{padding:"4px 18px 6px"}}>
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
    </div>
  );
}

function ExitModal({ show, onStay, onLeave, message, title, stayLabel, leaveLabel, stayGreen }) {
  if (!show) return null;
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.55)",zIndex:550,display:"flex",alignItems:"center",justifyContent:"center",padding:"20px"}}>
      <div className="slide-up" style={{background:"var(--color-background-primary)",borderRadius:16,padding:"28px 22px",maxWidth:320,width:"100%",textAlign:"center",boxShadow:"0 8px 32px rgba(0,0,0,0.2)"}}>
        <div style={{fontSize:36,marginBottom:10}}>⚠️</div>
        <h3 style={{margin:"0 0 8px",fontSize:17,fontWeight:700,color:"var(--color-text-primary)",fontFamily:"'Playfair Display',Georgia,serif"}}>{title||"Leave this page?"}</h3>
        <p style={{margin:"0 0 22px",fontSize:13,color:"var(--color-text-secondary)",lineHeight:1.5}}>{message||"Your progress will be lost and cannot be recovered."}</p>
        <div style={{display:"flex",gap:10}}>
          <button onClick={onStay}  style={{flex:1,background:stayGreen?"#16a34a":"var(--color-background-secondary)",color:stayGreen?"#fff":"var(--color-text-primary)",border:stayGreen?"none":"1px solid var(--color-border-secondary)",borderRadius:12,padding:"12px",fontSize:14,fontWeight:stayGreen?700:500,cursor:"pointer",fontFamily:"inherit"}}>{stayLabel||"Stay"}</button>
          <button onClick={onLeave} style={{flex:1,background:"#ef4444",color:"#fff",border:"none",borderRadius:12,padding:"12px",fontSize:14,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>{leaveLabel||"Leave"}</button>
        </div>
      </div>
    </div>
  );
}

// Pause overlay — strong blur over the whole exam so nothing is visible/clickable.
function PauseOverlay({ onResume }) {
  return (
    <div style={{position:"fixed",inset:0,zIndex:900,display:"flex",alignItems:"center",justifyContent:"center",padding:"20px",background:"rgba(15,16,32,0.45)",backdropFilter:"blur(20px)",WebkitBackdropFilter:"blur(20px)"}}>
      <div className="slide-up" style={{textAlign:"center",maxWidth:340}}>
        <div style={{fontSize:30,fontWeight:800,color:"#fff",fontFamily:"'Playfair Display',Georgia,serif",marginBottom:8}}>⏸ Exam Paused</div>
        <div style={{fontSize:14,color:"rgba(255,255,255,0.85)",marginBottom:24}}>Your progress is saved</div>
        <button onClick={onResume} style={{background:"#4f46e5",color:"#fff",border:"none",borderRadius:14,padding:"15px 40px",fontSize:16,fontWeight:700,cursor:"pointer",fontFamily:"inherit",boxShadow:"0 8px 24px rgba(79,70,229,0.4)"}}>Resume Exam</button>
      </div>
    </div>
  );
}

// Time's-up — non-dismissable, shown while the exam auto-submits.
function TimeUpModal() {
  return (
    <div style={{position:"fixed",inset:0,zIndex:950,display:"flex",alignItems:"center",justifyContent:"center",padding:"20px",background:"rgba(15,16,32,0.7)",backdropFilter:"blur(8px)",WebkitBackdropFilter:"blur(8px)"}}>
      <div style={{background:"var(--color-background-primary)",borderRadius:18,padding:"32px 26px",maxWidth:320,width:"100%",textAlign:"center",boxShadow:"0 12px 40px rgba(0,0,0,0.4)"}}>
        <div style={{fontSize:46,marginBottom:10}}>⏰</div>
        <h3 style={{margin:"0 0 6px",fontSize:22,fontWeight:800,color:"#dc2626",fontFamily:"'Playfair Display',Georgia,serif"}}>Time's Up!</h3>
        <p style={{margin:"0 0 20px",fontSize:14,color:"var(--color-text-secondary)",lineHeight:1.5}}>Your exam is being submitted now.</p>
        <div style={{width:36,height:36,margin:"0 auto",border:"3px solid var(--color-border-secondary)",borderTopColor:"#4f46e5",borderRadius:"50%",animation:"spin 0.8s linear infinite"}}/>
      </div>
    </div>
  );
}

// Offered on a refresh that interrupted an exam.
function ResumeModal({ info, onResume, onDiscard, fmtClock }) {
  if (!info) return null;
  const answered = info.examAns ? Object.values(info.examAns).filter(v=>v!==undefined&&v!=="").length : 0;
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.55)",zIndex:560,display:"flex",alignItems:"center",justifyContent:"center",padding:"20px"}}>
      <div className="slide-up" style={{background:"var(--color-background-primary)",borderRadius:16,padding:"28px 22px",maxWidth:330,width:"100%",textAlign:"center",boxShadow:"0 8px 32px rgba(0,0,0,0.25)"}}>
        <div style={{fontSize:36,marginBottom:10}}>📝</div>
        <h3 style={{margin:"0 0 8px",fontSize:18,fontWeight:700,color:"var(--color-text-primary)",fontFamily:"'Playfair Display',Georgia,serif"}}>Exam in progress — Continue?</h3>
        <p style={{margin:"0 0 20px",fontSize:13,color:"var(--color-text-secondary)",lineHeight:1.5}}>
          {(info.examQs?.length||0)} questions · {answered} answered{info.examTimerOn && info.examTimeLeft!=null ? " · "+fmtClock(info.examTimeLeft)+" left" : ""}
        </p>
        <div style={{display:"flex",gap:10}}>
          <button onClick={onDiscard} style={{flex:1,background:"var(--color-background-secondary)",color:"var(--color-text-primary)",border:"1px solid var(--color-border-secondary)",borderRadius:12,padding:"12px",fontSize:14,fontWeight:500,cursor:"pointer",fontFamily:"inherit"}}>Discard</button>
          <button onClick={onResume} style={{flex:2,background:"#4f46e5",color:"#fff",border:"none",borderRadius:12,padding:"12px",fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>Continue exam</button>
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
// Ads are master-switched by VITE_ADS_ENABLED — set it to "true" once
// AdSense is approved and redeploy; nothing renders until then.
const ADS_ENABLED = import.meta.env.VITE_ADS_ENABLED === "true";
function AdBanners({ isPro }) {
  const dev = useDev();
  const adsOn = dev.devMode && dev.ads !== null ? dev.ads : ADS_ENABLED;
  if (isPro || !adsOn) return null;
  return (
    <>
      <div className="ad-placeholder rv-ad rv-ad-side rv-ad-left"><span className="rv-ad-label">Advertisement</span></div>
      <div className="ad-placeholder rv-ad rv-ad-side rv-ad-right"><span className="rv-ad-label">Advertisement</span></div>
      <div className="ad-placeholder rv-ad rv-ad-bottom"><span className="rv-ad-label">Advertisement</span></div>
    </>
  );
}

// Full-screen overlay shown while we poll Supabase for Pro status after a
// successful Stripe checkout (the webhook writes is_pro asynchronously).
function ActivatingOverlay({ show }) {
  if (!show) return null;
  return (
    <div style={{position:"fixed",inset:0,zIndex:1000,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:18,padding:24,textAlign:"center",background:"rgba(15,16,32,0.55)",backdropFilter:"blur(8px)",WebkitBackdropFilter:"blur(8px)"}}>
      <div style={{width:48,height:48,borderRadius:"50%",border:"4px solid rgba(255,255,255,0.25)",borderTopColor:"#fff",animation:"spin 0.8s linear infinite"}}/>
      <div style={{color:"#fff",fontSize:18,fontWeight:700,fontFamily:"'Playfair Display',Georgia,serif"}}>✨ Activating your Pro account…</div>
      <div style={{color:"rgba(255,255,255,0.8)",fontSize:13.5,maxWidth:320,lineHeight:1.5}}>Refreshing your account — this takes a few seconds after payment.</div>
    </div>
  );
}

export default function StudyQuiz() {
  const [screen,       setScreen]       = useState("home");
  const { lang, setLang, t } = useLang();
  const dev = useDev();
  const { isPro, signOut, deleteAccount, reauthenticate, user, startCheckout, openPortal, refreshProfile, getToken } = useAuth();
  const navigate = useNavigate();
  const [coBusy, setCoBusy] = useState("");   // "monthly" | "yearly" while redirecting to Stripe
  const [coErr,  setCoErr]  = useState("");
  const [upgraded, setUpgraded] = useState(false); // "Welcome to Pro!" banner after checkout
  const [activating, setActivating] = useState(false); // polling Supabase for Pro after checkout
  const doCheckout = async (priceId, which) => {
    setCoErr(""); setCoBusy(which);
    const { error } = await startCheckout(priceId);
    if (error) { setCoBusy(""); setCoErr(error); }
  };
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
  const [dailyUsed,    setDailyUsed]    = useState(0);
  const [adWatchedDate,setAdWatchedDate]= useState(null);
  const [adUnlocked,   setAdUnlocked]   = useState(null);
  const [lockedModal,  setLockedModal]  = useState(null);
  const [showProModal, setShowProModal] = useState(false);
  const [pendingFile,  setPendingFile]  = useState(null);
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

  const updateSetting = (key,val) => {
    setSettings(prev=>{
      const next={...prev,[key]:val};
      window.storage.set("revyy_settings",JSON.stringify(next)).catch(()=>{});
      return next;
    });
  };

  useEffect(()=>{
    (async()=>{
      try {
        const s = await window.storage.get("sq_v3");
        if (s) {
          const d = JSON.parse(s.value);
          const today = getTodayStr();
          if (d.adDate === today) {
            setAdWatchedDate(today);
            if (d.adUntil > Date.now()) setAdUnlocked({ feature:d.adFeature, until:d.adUntil });
          }
          if (d.dailyDate === today) setDailyUsed(d.dailyUsed||0);
        }
      } catch {}
    })();
  },[]);

  const saveState = useCallback((adDate, adFeature, adUntil, used) => {
    window.storage.set("sq_v3", JSON.stringify({ adDate, adFeature, adUntil, dailyDate:getTodayStr(), dailyUsed:used })).catch(()=>{});
  },[]);

  // ── Feature access ───────────────────────────────────────────────
  const adActive    = useCallback((key) => (dev.devMode && dev.adUnlocked===true) ? true : !!(adUnlocked && adUnlocked.feature===key && adUnlocked.until>Date.now()), [adUnlocked, dev.devMode, dev.adUnlocked]);
  const canUseQType = useCallback((type) => type==="mcq" || isPro || adActive(`quizType:${type}`), [isPro,adActive]);
  const canExtraQ   = useCallback(() => isPro || adActive("questions"), [isPro,adActive]);
  const canCustomQ  = useCallback(() => isPro || adActive("questions"), [isPro,adActive]);
  // Max questions the current user may pick: 100 (Pro) / 50 (ad unlock) / 20 (free).
  const qCap        = useCallback(() => isPro ? PRO_MAX_Q : adActive("questions") ? AD_MAX_Q : FREE_MAX_Q, [isPro,adActive]);
  const fileLimitMB = useCallback(() => isPro?PRO_FILE_MB : adActive("files")?AD_FILE_MB : FREE_FILE_MB, [isPro,adActive]);
  // Dev: reset the daily quiz counter when the panel asks.
  useEffect(()=>{ if(dev.devMode && dev.resetDailySignal>0){ setDailyUsed(0); } },[dev.resetDailySignal, dev.devMode]);

  const effectiveNumQ = useCallback(()=>{
    if (useCustomQ && canCustomQ()) {
      const n = parseInt(customQ,10);
      return isNaN(n)?10:Math.min(Math.max(n,1),PRO_MAX_Q);
    }
    if (!canExtraQ() && numQ>FREE_MAX_Q) return FREE_MAX_Q;
    return numQ;
  },[useCustomQ,canCustomQ,canExtraQ,numQ,customQ]);

  const adWatchedToday = adWatchedDate === getTodayStr();
  const adTimeLeft     = adUnlocked&&adUnlocked.until>Date.now() ? msUntil(adUnlocked.until) : null;
  // Whether the ad system is live at all (mirrors AdBanners). When false the
  // "watch ad" path is completely disabled — no ad UI of any kind is shown.
  const adsOn          = dev.devMode && dev.ads!==null ? dev.ads : ADS_ENABLED;

  const watchAd = useCallback((featureKey) => {
    const until = Date.now() + AD_HOURS*3600000;
    const today = getTodayStr();
    setAdWatchedDate(today);
    setAdUnlocked({ feature:featureKey, until });
    setLockedModal(null);
    saveState(today, featureKey, until, dailyUsed);
    if (featureKey==="files" && pendingFile) {
      processFile(pendingFile, AD_FILE_MB);
      setPendingFile(null);
    }
  },[pendingFile, dailyUsed, saveState]);

  const openUpgrade = () => { setLockedModal(null); setShowProModal(true); };

  const addExamFile=useCallback(async(f,idx)=>{
    if(!f)return;
    const lim=fileLimitMB();
    if(f.size/1024/1024>lim){setError("File too large: max "+lim+"MB");return;}
    const isPdf=f.type==="application/pdf",isImg=f.type.startsWith("image/"),isTxt=f.type.startsWith("text/")||/\.(txt|md|csv)$/i.test(f.name);
    if(!isPdf&&!isImg&&!isTxt){setError("Supported: PDF, images, .txt/.md");return;}
    try{
      let p;
      if(isTxt){const text=await readText(f);p={type:"text",content:text,mime:null,name:f.name};}
      else{p={type:isPdf?"pdf":"image",raw:f,mime:f.type,name:f.name};}
      setExamFiles(prev=>{const a=[...prev];a[idx]=p;return a.filter(Boolean);});
      setError("");
    }catch{setError("Could not read file.");}
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
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ blobUrl: blob.url, filename: f.name, contentType: f.type }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.file_id) throw new Error(data.error || "Could not process the uploaded file.");
      fileId = data.file_id;
    } else {
      // Direct path (free, and small Pro files).
      const res = await fetch("/api/upload-file", {
        method: "POST",
        headers: { "Content-Type": f.type || "application/octet-stream", "x-filename": encodeURIComponent(f.name) },
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
    if(examFiles.length===0){setError("Upload at least one study file.");return;}
    if(examMode==="custom" && sectionTotalQs===0){setError("Please add at least one question to your sections.");return;}
    setError("");
    const diffLabel=t.diffOpts[diff];
    const totalQ = examMode==="custom" ? sectionTotalQs : Math.min(Math.max(parseInt(examTotalQ)||5,1),100);
    // Exams carry model answers/explanations → ~200 tokens/Q. Cap at 20k.
    const maxTokens = Math.min(Math.max(Math.round(totalQ*200)+2000, 6000), 20000);

    // Build the prompt; `scale` (≤1) shrinks the question counts for a retry.
    const buildPrompt=(scale)=>{
      const totN=Math.max(1,Math.round(Math.min(Math.max(parseInt(examTotalQ)||5,1),100)*scale));
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
      const prompt="You are creating a real graded exam.\n"+typeInst+"\nDifficulty: "+diffLabel+".\nReturn ONLY raw JSON (no markdown):\n{\"title\":\"Exam title\",\"questions\":[{\"section\":1,\"type\":\"mcq\",\"question\":\"...\",\"options\":[\"A\",\"B\",\"C\",\"D\"],\"correct\":0,\"answer\":\"model answer\",\"explanation\":\"...\"}]}\nFor written/fill: options:[], correct:0. Keep questions in section order.";
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
        const res=await fetch("/api/anthropic",{method:"POST",headers:{"Content-Type":"application/json"},
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
    }catch(err){setError(err.message.includes("parse")?"Unexpected format — please try again.":err.message);setScreen("exam_setup");}
  },[examFiles,examMode,examSections,examTotalQ,diff,sectionTotalQs,examTimerOn,examTimerMin,uploadFileToAnthropic]);

  const evaluateExam=useCallback(async(answers)=>{
    const hasWritten=examQs.some(q=>q.type==="written");
    if(!hasWritten){
      return examQs.map((q,i)=>q.type==="mcq"?{score:answers[i]===q.correct?1:0,feedback:answers[i]===q.correct?"Correct!":"Incorrect."}:{score:0,feedback:""});
    }
    setScreen("exam_eval");
    const writtenLines=examQs.map((q,i)=>q.type==="written"?"Q"+(i+1)+": "+q.question+"\nModel: "+(q.answer||"")+"\nStudent: \""+(answers[i]||"(no answer)")+"\"":null).filter(Boolean).join("\n\n");
    const evalPrompt="Evaluate each student written answer. Return ONLY JSON: {\"evals\":[{\"idx\":0,\"score\":1.0,\"feedback\":\"brief\"}]}\nscore: 1=correct, 0.5=partial, 0=wrong\n\n"+writtenLines;
    // ~120 tokens of feedback per written answer; cap at 10k.
    const writtenCount=examQs.filter(q=>q.type==="written").length;
    const evalMaxTokens=Math.min(Math.max(writtenCount*120+1000,2000),10000);
    try{
      const res=await fetch("/api/anthropic",{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({model:AI_MODEL,max_tokens:evalMaxTokens,
          system:"Evaluate student exam answers. Return ONLY raw JSON.",
          messages:[{role:"user",content:[{type:"text",text:evalPrompt}]}]})});
      if(!res.ok) throw new Error("Eval error "+res.status);
      const raw=stripFences(await readStream(res));
      const parsed=JSON.parse(raw);
      const writtenIdxs=examQs.map((q,i)=>q.type==="written"?i:null).filter(x=>x!==null);
      return examQs.map((q,i)=>{
        if(q.type==="mcq") return{score:answers[i]===q.correct?1:0,feedback:answers[i]===q.correct?"Correct!":"Incorrect."};
        const rank=writtenIdxs.indexOf(i);
        const ev=parsed.evals.find(e=>e.idx===i)||parsed.evals[rank];
        return ev?{score:ev.score,feedback:ev.feedback}:{score:0,feedback:"Not evaluated"};
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

  const openSettings  = ()  => { setSettingsDraft({...settings}); setShowSettings(true); };
  const cancelSettings= ()  => { setSettingsDraft(null); setShowSettings(false); };
  const applySettings = ()  => {
    if(!settingsDraft) return;
    setSettings(settingsDraft);
    setSoundOn(settingsDraft.sound);
    setDiff(settingsDraft.defaultDiff);
    setNumQ(settingsDraft.defaultQCount);
    SoundEngine.setVolume(settingsDraft.volume);
    window.storage.set("revyy_settings",JSON.stringify(settingsDraft)).catch(()=>{});
    setSettingsDraft(null);
    setShowSettings(false);
  };
  const updateDraft = (key,val) => setSettingsDraft(prev=>({...prev,[key]:val}));

  const haptic = (ms=40) => {
    if (settings.haptics && navigator.vibrate) navigator.vibrate(ms);
  };

  const processFile = useCallback(async (f, limitMB) => {
    const isPdf=f.type==="application/pdf", isImg=f.type.startsWith("image/"), isTxt=f.type.startsWith("text/")||/\.(txt|md|csv)$/i.test(f.name);
    if (!isPdf&&!isImg&&!isTxt) { setError("Supported: PDF, images (JPG/PNG/WebP), or .txt / .md files"); return; }
    try {
      if (isTxt) { const text=await readText(f); setFile({type:"text",content:text,mime:null,name:f.name,sizeMB:f.size/1024/1024}); }
      // PDFs/images are uploaded to the Anthropic Files API at generate time —
      // keep the raw File (no base64) so large files aren't inflated.
      else { setFile({type:isPdf?"pdf":"image",raw:f,mime:f.type,name:f.name,sizeMB:f.size/1024/1024}); }
      setError("");
    } catch { setError("Could not read file. Please try another."); }
  },[]);

  const loadFile = useCallback(async (f) => {
    if (!f) return;
    setError("");
    const fileMB  = f.size/1024/1024;
    const limitMB = fileLimitMB();
    if (fileMB > PRO_FILE_MB) { setError(`File is ${fmtMB(f.size)} — exceeds the maximum ${PRO_FILE_MB}MB even for Pro.`); return; }
    if (fileMB > limitMB) {
      setPendingFile(f);
      setLockedModal({ featureKey:"files", extraInfo:`${fmtMB(f.size)}` });
      return;
    }
    await processFile(f, limitMB);
  },[fileLimitMB, processFile]);

  const generate = useCallback(async () => {
    if (!isPro && dailyUsed>=FREE_DAILY) { setError(`Daily limit: ${FREE_DAILY} quizzes/day on free plan. Upgrade to Pro for unlimited.`); return; }
    setError("");
    const finalType = canUseQType(qType)?qType:"mcq";
    const finalNumQ = effectiveNumQ();
    if (tab==="file"||tab==="photo") {
      if (!file) { setError("Please upload a file first."); return; }
    } else if (!textVal.trim()) { setError("Please paste study text first."); return; }

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
      let res;
      try {
        res = await callClaude({blocks, numQ:finalNumQ, diff:t.diffOpts[diff], type:finalType});
      } catch (e1) {
        // A truncated response yields invalid/unterminated JSON. Retry once
        // with fewer questions so the output fits the token budget.
        const truncated = /JSON|Unexpected end|Unterminated|parse/i.test(e1.message||"");
        if (truncated && finalNumQ > 25) {
          const fewer = Math.max(20, Math.min(50, Math.floor(finalNumQ/2)));
          res = await callClaude({blocks, numQ:fewer, diff:t.diffOpts[diff], type:finalType});
        } else throw e1;
      }
      if (!res.questions?.length) throw new Error("No questions returned");
      setQuiz({...res, type:finalType});
      setQIdx(0); setAnswers([]); setSelected(null);
      const newUsed = dailyUsed+1;
      if (!isPro) { setDailyUsed(newUsed); saveState(adWatchedDate, adUnlocked?.feature, adUnlocked?.until, newUsed); }
      setScreen("quiz");
    } catch(err) {
      setError(err.message.includes("parse")?"AI returned unexpected format. Please try again.":err.message);
      setScreen("upload");
    }
  },[isPro,dailyUsed,qType,tab,file,textVal,diff,canUseQType,effectiveNumQ,adWatchedDate,adUnlocked,saveState,uploadFileToAnthropic]);

  const pick    = i => { if(selected===null) setSelected(i); };
  const nextQ   = isCorrect => {
    const upd=[...answers,{isCorrect}]; setAnswers(upd); setSelected(null);
    if (qIdx+1>=quiz.questions.length) setScreen("results");
    else setQIdx(i=>i+1);
  };
  const nextMCQ = () => { if(selected===null)return; nextQ(selected===quiz.questions[qIdx].correct); };
  const retry   = () => { setQIdx(0);setAnswers([]);setSelected(null);setScreen("quiz"); };
  const newMat  = () => { setScreen("upload");setQuiz(null);setFile(null);setTextVal("");setError(""); };

  const score = answers.filter(a=>a.isCorrect).length;
  const pct   = quiz ? Math.round((score/quiz.questions.length)*100) : 0;
  const badge = pct>=90?{emoji:"🏆",text:t.excellent}:pct>=75?{emoji:"🎯",text:t.great}:pct>=60?{emoji:"📚",text:t.good}:{emoji:"💪",text:t.keep};

  // ── HOME ─────────────────────────────────────────────────────────
  if (screen==="home") return (
    <div style={Sb.root}><style>{CSS}</style>
      <ActivatingOverlay show={activating}/>
      <AdBanners isPro={isPro}/>
      {upgraded && <div style={{position:"fixed",top:0,left:0,right:0,zIndex:800,background:"#16a34a",color:"#fff",textAlign:"center",padding:"11px 14px",fontSize:14,fontWeight:700,fontFamily:"inherit",boxShadow:"0 2px 12px rgba(0,0,0,0.25)"}}>🎉 Welcome to Revyy Pro! You now have full access.</div>}
      <div style={Sb.hero}>
        <div className="rv-hero-inner">
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:28}}>
          <span style={Sb.brand}><Logo/>{t.appName}
            {isPro && <span style={{marginLeft:7,padding:"2px 9px",borderRadius:999,fontSize:11,fontWeight:800,letterSpacing:0.8,color:"#422006",background:"linear-gradient(135deg,#fde68a,#f59e0b)",boxShadow:"0 2px 8px rgba(245,158,11,0.35)"}}>PRO</span>}
            <DevBadge/></span>
          <div style={{display:"flex",gap:10,alignItems:"center",marginLeft:"auto"}}>
            <select value={lang} onChange={e=>setLang(e.target.value)} title="Language"
              style={{background:"rgba(255,255,255,0.12)",color:"#fff",border:"1px solid rgba(255,255,255,0.25)",borderRadius:8,fontSize:12,padding:"3px 6px",cursor:"pointer",fontFamily:"inherit",outline:"none"}}>
              {Object.entries(LANGS).map(([code,l])=>(
                <option key={code} value={code} style={{color:"#1e293b"}}>{l.flag} {l.name}</option>
              ))}
            </select>
            <button onClick={()=>openSettings()} title="Settings" style={{background:"none",border:"none",fontSize:18,cursor:"pointer",padding:"2px 4px",color:"rgba(255,255,255,0.7)"}}>⚙️</button>
            <UserButton afterSignOutUrl="/" />
          </div>
        </div>
        <h1 style={Sb.h1}>{t.tagline}</h1>
        <p style={{fontSize:14,color:"#bfdbfe",lineHeight:1.65,margin:"0 auto 26px",maxWidth:300}}>{t.sub}</p>
        <button style={Sb.btnHero} onClick={()=>setScreen("upload")}>{t.start}</button>
        </div>
      </div>

      <div className="rv-home-body" style={{padding:"20px 16px 32px"}}>
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
          <div style={Sb.planCard}>
            <div style={{fontWeight:700,fontSize:14,marginBottom:4}}>{t.freeLabel}</div>
            <div style={{fontSize:11,color:"var(--color-text-secondary)",lineHeight:1.7}}>{t.freeDesc}</div>
            <button style={{...Sb.btnPrimary,width:"100%",marginTop:10,fontSize:13}} onClick={()=>setScreen("upload")}>{isPro ? "Make a quiz" : t.startFree}</button>
          </div>
          <div style={{...Sb.planCard,border:"2px solid #f59e0b",background:"#fffbeb",position:"relative",overflow:"hidden"}}>
            <div style={{position:"absolute",top:0,left:0,right:0,height:3,background:"linear-gradient(90deg,#f59e0b,#fbbf24)"}}/>
            <div style={{fontWeight:700,fontSize:14,marginBottom:2,color:"#92400e"}}>✦ {t.proLabel}</div>
            <div style={{fontSize:13,color:"#b45309",fontWeight:700,marginBottom:4}}>{t.proPrice}</div>
            <div style={{fontSize:11,color:"#78350f",lineHeight:1.7}}>{t.proDesc}</div>
            {isPro ? (
              <div style={{width:"100%",marginTop:10,fontSize:13,fontWeight:700,color:"#fff",textAlign:"center",padding:"10px",borderRadius:10,background:"linear-gradient(135deg,#16a34a,#15803d)",boxShadow:"0 2px 10px rgba(22,163,74,0.3)"}}>✓ You're Pro</div>
            ) : (
              <button style={{...Sb.btnPrimary,width:"100%",marginTop:10,fontSize:13,background:"#f59e0b",color:"#fff"}} onClick={()=>{setCoErr("");setShowProModal(true);}}>{t.upgrade}</button>
            )}
          </div>
        </div>
      </div>
      {showProModal && <ProModal onClose={()=>{setShowProModal(false);setCoErr("");}} t={t} onMonthly={()=>doCheckout(STRIPE_MONTHLY_PRICE,"monthly")} onYearly={()=>doCheckout(STRIPE_YEARLY_PRICE,"yearly")} busy={coBusy} error={coErr}/>}
      {showSettings && <SettingsPanel draft={settingsDraft} update={updateDraft} onApply={applySettings} onCancel={cancelSettings} onSignOut={()=>signOut()} onDeleteAccount={confirmDeleteAccount} requiresPassword={requiresPassword} onReauthenticate={reauthenticate} isPro={isPro} onManageSubscription={openPortal} t={t}/>}
      <ResumeModal info={examResume} onResume={resumeExam} onDiscard={discardResume} fmtClock={fmtClock}/>
    </div>
  );

  // ── UPLOAD ───────────────────────────────────────────────────────
  if (screen==="upload") return (
    <div style={Sb.root}><style>{CSS}</style>
      <AdBanners isPro={isPro}/>
      {upgraded && <div style={{position:"fixed",top:0,left:0,right:0,zIndex:800,background:"#16a34a",color:"#fff",textAlign:"center",padding:"11px 14px",fontSize:14,fontWeight:700,fontFamily:"inherit",boxShadow:"0 2px 12px rgba(0,0,0,0.25)"}}>🎉 Welcome to Revyy Pro! You now have full access.</div>}
      <div style={Sb.topbar} className="rv-topbar">
        <button style={Sb.backBtn} onClick={()=>setScreen("home")}>← Home</button>
        <span style={Sb.brand}>{t.appName}</span>
        <div style={{display:"flex",alignItems:"center",gap:6}}>
          {isPro && <span style={{fontSize:10,background:"#f59e0b",color:"#fff",borderRadius:8,padding:"2px 7px",fontWeight:700}}>PRO</span>}
          {adTimeLeft && !isPro && <span style={{fontSize:10,background:"#7c3aed",color:"#fff",borderRadius:8,padding:"2px 7px",fontWeight:700}}>AD·{adTimeLeft}</span>}
          <button onClick={()=>setSoundOn(s=>!s)} title={soundOn?t.soundOn:t.soundOff} style={{background:"none",border:"none",fontSize:16,cursor:"pointer",padding:"2px 4px",opacity:soundOn?1:0.4}}>{soundOn?"🔊":"🔇"}</button>
          <button onClick={()=>openSettings()} title="Settings" style={{background:"none",border:"none",fontSize:16,cursor:"pointer",padding:"2px 4px",color:"var(--color-text-secondary)"}}>⚙️</button>
        </div>
      </div>
      <div className="rv-upload-body" style={{padding:"18px 16px 32px"}}>
        <div className="rv-ul-left">
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
            {file?(<><div style={{fontSize:32}}>{file.type==="pdf"?"📄":file.type==="image"?"🖼️":"📝"}</div><div style={{fontWeight:600,fontSize:14,color:"var(--color-text-primary)"}}>{file.name}</div><div style={{fontSize:11,color:"var(--color-text-tertiary)"}}>{fmtMB(file.sizeMB*1024*1024)} · {t.tapChange}</div></>):(<><div style={{fontSize:32}}>📂</div><div style={{fontSize:14,fontWeight:600,color:"var(--color-text-primary)"}}>{t.dropTitle}</div><div style={{fontSize:12,color:"var(--color-text-secondary)"}}>{t.dropSub}</div><div style={{fontSize:11,color:"var(--color-text-tertiary)",marginTop:2}}>{isPro?"Unlimited":("Max "+fileLimitMB()+"MB (free)")}</div></>)}
          </div>
        )}
        {tab==="photo" && (
          <div style={{...Sb.dropzone,...(file&&file.type==="image"?{borderStyle:"solid",borderColor:"#4f46e5"}:{})}} onClick={()=>photoRef.current.click()}>
            <input ref={photoRef} type="file" accept="image/*" capture="environment" style={{display:"none"}} onChange={e=>loadFile(e.target.files[0])}/>
            {file&&file.type==="image"?(<><div style={{fontSize:32}}>🖼️</div><div style={{fontWeight:600,fontSize:14,color:"var(--color-text-primary)"}}>{file.name}</div><div style={{fontSize:11,color:"var(--color-text-tertiary)"}}>{t.tapChange}</div></>):(<><div style={{fontSize:48}}>📷</div><div style={{fontSize:14,fontWeight:600,color:"var(--color-text-primary)"}}>{t.photoTitle}</div><div style={{fontSize:12,color:"var(--color-text-secondary)"}}>{t.photoHint}</div></>)}
          </div>
        )}
        {tab==="text" && <textarea value={textVal} onChange={e=>setTextVal(e.target.value)} placeholder={t.pasteHint} style={Sb.textarea}/>}
        {error && <div style={{background:"#fef2f2",border:"0.5px solid #fecaca",borderRadius:10,padding:"10px 14px",fontSize:13,color:"#b91c1c",marginBottom:14,lineHeight:1.5}}>⚠️ {error}</div>}
        </div>
        <div className="rv-ul-right">
        <div style={Sb.settingsBox}>
          <div style={Sb.settingRow}>
            <span style={Sb.settingLabel}>{t.quizType}</span>
            <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
              {QUIZ_TYPES.map(type=>{
                const unlocked=canUseQType(type), isAd=!isPro&&adActive(`quizType:${type}`);
                return (
                  <div key={type} style={{position:"relative"}}>
                    <Chip small label={t.quizTypes[type]} active={qType===type} locked={!unlocked}
                      onClick={()=>{ if(unlocked) setQType(type); else setLockedModal({featureKey:`quizType:${type}`}); }}/>
                    {isAd&&<span style={{position:"absolute",top:-5,right:-3,background:"#7c3aed",color:"#fff",fontSize:7,borderRadius:8,padding:"1px 4px",fontWeight:700,lineHeight:1.4,pointerEvents:"none"}}>AD</span>}
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
            <div style={{width:"100%",paddingRight:2}}>
              <input type="range"
                min={5} max={qCap()} step={5}
                value={Math.min(numQ,qCap())}
                onChange={e=>{setUseCustomQ(false);setNumQ(parseInt(e.target.value));}}
                style={{width:"100%",accentColor:"#4f46e5",cursor:"pointer"}}
              />
              <div style={{display:"flex",justifyContent:"space-between",fontSize:10,color:"var(--color-text-tertiary)",marginTop:2}}>
                <span>5</span>
                <span style={{color:canExtraQ()?"var(--color-text-tertiary)":"#f59e0b"}}>{qCap()}{!canExtraQ()&&" (free max)"}</span>
              </div>
            </div>
            {!canExtraQ()&&(
              <button onClick={()=>setLockedModal({featureKey:"questions"})} style={{fontSize:11,color:"#f59e0b",background:"none",border:"none",cursor:"pointer",fontFamily:"inherit",padding:0,textAlign:"left"}}>
                🔒 Unlock up to {PRO_MAX_Q} questions (Pro/Ad)
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
        {!isPro&&<div style={{background:"#fffbeb",border:"1px solid #f59e0b44",borderRadius:10,padding:"10px 14px",fontSize:12,color:"#92400e",marginBottom:14,display:"flex",justifyContent:"space-between",alignItems:"center",gap:8}}><span>🆓 {t.dailyLeft(Math.max(0,FREE_DAILY-dailyUsed))} · Max {FREE_MAX_Q}Q · {FREE_FILE_MB}MB</span><span style={{color:"#f59e0b",fontWeight:700,cursor:"pointer",flexShrink:0,fontSize:11,textDecoration:"underline"}} onClick={()=>setShowProModal(true)}>Go Pro →</span></div>}
        {!isPro&&adTimeLeft&&<div style={{background:"#f5f3ff",border:"0.5px solid #c4b5fd",borderRadius:10,padding:"10px 14px",fontSize:12,color:"#5b21b6",marginBottom:14}}>📺 Ad active: <strong>{t.lockedTitles[adUnlocked.feature]}</strong> — {adTimeLeft} left</div>}
        {isPro&&<button style={{width:"100%",marginBottom:14,background:"linear-gradient(135deg,#1e1b4b,#4f46e5)",color:"#fff",border:"none",borderRadius:12,padding:"14px 20px",fontSize:15,fontWeight:600,cursor:"pointer",fontFamily:"'Playfair Display',Georgia,serif",display:"flex",alignItems:"center",justifyContent:"space-between"}} onClick={()=>setScreen("exam_setup")}><span>{t.examModeLabel}</span><span style={{fontSize:10,background:"rgba(255,255,255,0.2)",borderRadius:8,padding:"3px 8px",fontWeight:700}}>PRO ONLY</span></button>}
        {!isPro&&<div style={{background:"#f5f3ff",border:"1.5px solid #f59e0b55",borderRadius:12,padding:"14px 16px",marginBottom:14,display:"flex",alignItems:"center",gap:12,cursor:"pointer"}} onClick={()=>setShowProModal(true)}><div style={{flex:1}}><div style={{fontWeight:700,fontSize:14,color:"var(--color-text-primary)"}}>{t.examModeLabel}</div><div style={{fontSize:11,color:"var(--color-text-secondary)",marginTop:2}}>{t.examProOnly}</div></div><span style={{fontSize:10,background:"#f59e0b",color:"#fff",borderRadius:8,padding:"3px 8px",fontWeight:700,flexShrink:0}}>PRO</span></div>}
        <button style={{...Sb.btnPrimary,width:"100%"}} onClick={generate}>{t.generate}</button>
        </div>
      </div>
      <LockedModal info={lockedModal} adWatchedToday={adWatchedToday} adUnlocked={adUnlocked} adsOn={adsOn} t={t}
        onClose={()=>{setLockedModal(null);setPendingFile(null);}} onUpgrade={openUpgrade} onWatchAd={watchAd}/>
      {showProModal&&<ProModal onClose={()=>{setShowProModal(false);setCoErr("");}} t={t} onMonthly={()=>doCheckout(STRIPE_MONTHLY_PRICE,"monthly")} onYearly={()=>doCheckout(STRIPE_YEARLY_PRICE,"yearly")} busy={coBusy} error={coErr}/>}
      {showSettings&&<SettingsPanel draft={settingsDraft} update={updateDraft} onApply={applySettings} onCancel={cancelSettings} onSignOut={()=>signOut()} onDeleteAccount={confirmDeleteAccount} requiresPassword={requiresPassword} onReauthenticate={reauthenticate} isPro={isPro} onManageSubscription={openPortal} t={t}/>}
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
    </div>
  );

  // ── QUIZ ─────────────────────────────────────────────────────────
  if (screen==="quiz" && quiz) {
    const q=quiz.questions[qIdx], isLast=qIdx+1===quiz.questions.length;
    if (quiz.type==="match") return (
      <div style={Sb.root}><style>{CSS}</style>
      <AdBanners isPro={isPro}/>
      {upgraded && <div style={{position:"fixed",top:0,left:0,right:0,zIndex:800,background:"#16a34a",color:"#fff",textAlign:"center",padding:"11px 14px",fontSize:14,fontWeight:700,fontFamily:"inherit",boxShadow:"0 2px 12px rgba(0,0,0,0.25)"}}>🎉 Welcome to Revyy Pro! You now have full access.</div>}
        <div style={Sb.topbar} className="rv-topbar"><button style={Sb.backBtn} onClick={()=>setShowExitConfirm(true)}>{t.exit}</button><span style={{fontSize:12,fontWeight:600,color:"var(--color-text-secondary)"}}>{quiz.title}</span><span/></div>
        <div className="rv-center-narrow" style={{padding:"20px 16px 32px"}}><MatchQuiz questions={quiz.questions} t={t} onDone={(s,total)=>{setAnswers(Array(total).fill(0).map((_,i)=>({isCorrect:i<s})));setScreen("results");}}/></div>
        <ExitModal show={showExitConfirm} onStay={()=>setShowExitConfirm(false)} onLeave={()=>{setShowExitConfirm(false);newMat();}}/>
      </div>
    );
    return (
      <div style={Sb.root}><style>{CSS}</style>
      <AdBanners isPro={isPro}/>
      {upgraded && <div style={{position:"fixed",top:0,left:0,right:0,zIndex:800,background:"#16a34a",color:"#fff",textAlign:"center",padding:"11px 14px",fontSize:14,fontWeight:700,fontFamily:"inherit",boxShadow:"0 2px 12px rgba(0,0,0,0.25)"}}>🎉 Welcome to Revyy Pro! You now have full access.</div>}
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
          {quiz.type==="fill" &&<FillBlank  key={qIdx} q={q} isLast={isLast} t={t} onNext={ok=>{const u=[...answers,{isCorrect:ok}];setAnswers(u);setSelected(null);if(qIdx+1>=quiz.questions.length)setScreen("results");else setQIdx(i=>i+1);}}/>}
          {quiz.type==="mcq"  &&(
            <>
              <h3 style={{fontFamily:"'Playfair Display',Georgia,serif",fontSize:19,fontWeight:700,color:"var(--color-text-primary)",lineHeight:1.4,margin:0}}>{q.question}</h3>
              <div style={{display:"flex",flexDirection:"column",gap:9,marginTop:20}}>
                {q.options.map((opt,i)=>{
                  const isChosen=selected===i,isCorrect=q.correct===i;
                  let extra={};
                  if(selected!==null){if(isCorrect)extra={border:"1.5px solid #22c55e",background:"#f0fdf4",color:"#15803d"};else if(isChosen)extra={border:"1.5px solid #ef4444",background:"#fef2f2",color:"#b91c1c"};else extra={opacity:0.45};}
                  else if(isChosen)extra={border:"1.5px solid #4f46e5",background:"#ede9fe"};
                  return <button key={i} onClick={()=>pick(i)} disabled={selected!==null} className={selected===null?"quiz-opt":""} style={{display:"flex",alignItems:"center",gap:12,background:"var(--color-background-primary)",border:"1.5px solid var(--color-border-tertiary)",borderRadius:12,padding:"13px 14px",cursor:selected!==null?"default":"pointer",fontSize:14,color:"var(--color-text-primary)",fontFamily:"inherit",transition:"all 0.18s",...extra}}>
                    <span style={{width:28,height:28,borderRadius:"50%",background:"var(--color-background-secondary)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,fontWeight:700,flexShrink:0}}>{LETTERS[i]}</span>
                    <span style={{flex:1,textAlign:"left",lineHeight:1.4}}>{opt}</span>
                    {selected!==null&&isCorrect&&"✅"}{selected!==null&&isChosen&&!isCorrect&&"❌"}
                  </button>;
                })}
              </div>
              {selected!==null&&settings.feedback==="immediate"&&<div style={{borderRadius:10,padding:"12px 14px",marginTop:14,...(selected===q.correct?{background:"#f0fdf4",border:"0.5px solid #86efac",color:"#15803d"}:{background:"#fef2f2",border:"0.5px solid #fca5a5",color:"#b91c1c"})}} className="slide-up"><strong style={{fontSize:14}}>{selected===q.correct?t.correct:t.incorrect}</strong><p style={{margin:"5px 0 0",fontSize:13,lineHeight:1.5}}>{q.explanation}</p></div>}
              <button style={{...Sb.btnPrimary,width:"100%",marginTop:20,opacity:selected===null?0.35:1,cursor:selected===null?"not-allowed":"pointer"}} onClick={nextMCQ} disabled={selected===null}>{isLast?t.finish:t.next}</button>
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
      <AdBanners isPro={isPro}/>
      {upgraded && <div style={{position:"fixed",top:0,left:0,right:0,zIndex:800,background:"#16a34a",color:"#fff",textAlign:"center",padding:"11px 14px",fontSize:14,fontWeight:700,fontFamily:"inherit",boxShadow:"0 2px 12px rgba(0,0,0,0.25)"}}>🎉 Welcome to Revyy Pro! You now have full access.</div>}
      <div style={{background:"linear-gradient(145deg,#1e1b4b,#4f46e5)",padding:"36px 20px 28px",textAlign:"center"}}>
        <div style={{fontSize:50,marginBottom:8}}>{badge.emoji}</div>
        <h2 style={{margin:"0 0 4px",fontSize:22,fontWeight:700,color:"#fff"}}>{badge.text}</h2>
        <div style={{fontSize:46,fontWeight:800,color:"#fff",letterSpacing:-1,fontFamily:"'Playfair Display',Georgia,serif"}}>{pct}%</div>
        <div style={{fontSize:14,color:"rgba(255,255,255,0.7)",marginTop:4}}>{score} {t.outOf} {quiz.questions.length}</div>
        <div style={{fontSize:22,letterSpacing:4,marginTop:14}}>{answers.map((a,i)=><span key={i}>{a.isCorrect?"🟩":"🟥"}</span>)}</div>
      </div>
      <div className="rv-center" style={{padding:"20px 16px"}}>
        <div style={{display:"flex",gap:10,marginBottom:16}}>
          {[{v:score,l:t.correct2},{v:quiz.questions.length-score,l:t.wrong},{v:t.diffOpts[diff]||"-",l:t.level}].map(({v,l},i)=>(
            <div key={i} style={{flex:1,background:"var(--color-background-primary)",borderRadius:10,padding:"12px 6px",textAlign:"center",border:"0.5px solid var(--color-border-tertiary)"}}>
              <div style={{fontSize:17,fontWeight:700,color:"var(--color-text-primary)"}}>{v}</div>
              <div style={{fontSize:11,color:"var(--color-text-secondary)",marginTop:2}}>{l}</div>
            </div>
          ))}
        </div>
        <div style={{display:"flex",gap:10,marginBottom:14}}>
          <button style={{...Sb.btnPrimary,flex:1,margin:0}} onClick={retry}>{t.retry}</button>
          <button style={{...Sb.btnOutline,flex:1}} onClick={newMat}>{t.newMat}</button>
        </div>
        {!isPro&&adsOn&&<div style={{background:"var(--color-background-secondary)",border:"0.5px dashed var(--color-border-secondary)",borderRadius:10,padding:"8px 14px",textAlign:"center",fontSize:12,color:"var(--color-text-tertiary)",marginBottom:14}}>📣 Banner ad — connect Google AdSense here</div>}
        <p style={Sb.secLabel}>{t.review}</p>
        {quiz.type==="match"?<p style={{fontSize:13,color:"var(--color-text-secondary)",textAlign:"center",padding:"16px 0"}}>Matching results shown above</p>:
          quiz.questions.map((q,i)=>{
            const a=answers[i];
            return <div key={i} style={{background:"var(--color-background-primary)",borderRadius:10,padding:"14px 14px 14px 11px",marginBottom:10,border:"0.5px solid var(--color-border-tertiary)",borderLeft:`3px solid ${a?.isCorrect?"#22c55e":"#ef4444"}`}} className="fade-in">
              <div style={{display:"flex",gap:8,alignItems:"flex-start",marginBottom:8}}><span style={{fontSize:15,flexShrink:0}}>{a?.isCorrect?"✅":"❌"}</span><span style={{fontSize:14,fontWeight:600,color:"var(--color-text-primary)",lineHeight:1.4}}>{q.question}</span></div>
              {quiz.type==="mcq"&&!a?.isCorrect&&a&&<div style={{fontSize:12,color:"#dc2626",marginBottom:4,paddingLeft:23}}>{t.yourAns} {q.options?.[a.selected]}</div>}
              <div style={{fontSize:12,color:"#16a34a",marginBottom:6,paddingLeft:23,fontWeight:500}}>{t.correctAns} {quiz.type==="mcq"?q.options?.[q.correct]:(q.answer||"")}</div>
              {q.explanation&&<div style={{fontSize:12,color:"var(--color-text-secondary)",lineHeight:1.55,paddingTop:8,borderTop:"0.5px solid var(--color-border-tertiary)",paddingLeft:23}}>{q.explanation}</div>}
            </div>;
          })
        }
      </div>
    </div>
  );

  // ── EXAM SETUP ────────────────────────────────────────────────────
  if(screen==="exam_setup") return (
    <div style={Sb.root}><style>{CSS}</style>
      <AdBanners isPro={isPro}/>
      {upgraded && <div style={{position:"fixed",top:0,left:0,right:0,zIndex:800,background:"#16a34a",color:"#fff",textAlign:"center",padding:"11px 14px",fontSize:14,fontWeight:700,fontFamily:"inherit",boxShadow:"0 2px 12px rgba(0,0,0,0.25)"}}>🎉 Welcome to Revyy Pro! You now have full access.</div>}
      <div style={Sb.topbar} className="rv-topbar">
        <button style={Sb.backBtn} onClick={()=>setScreen("upload")}>← Back</button>
        <span style={{...Sb.brand,color:"#4f46e5"}}>{t.examModeLabel}</span>
        <span style={{fontSize:10,background:"#f59e0b",color:"#fff",borderRadius:8,padding:"2px 8px",fontWeight:700}}>PRO</span>
      </div>
      <div className="rv-exam-body" style={{padding:"20px 16px 40px"}}>
        <p style={{fontSize:13,color:"var(--color-text-secondary)",marginBottom:20,lineHeight:1.6}}>{t.examModeSub}</p>
        <p style={Sb.secLabel}>EXAM TYPE</p>
        <div style={{display:"flex",flexDirection:"column",gap:10,marginBottom:22}}>
          {[{id:"mcq",icon:"📋",title:t.fullMCQ,desc:t.fullMCQDesc},{id:"written",icon:"✍️",title:t.fullWritten,desc:t.fullWrittenDesc},{id:"custom",icon:"🎛️",title:t.customMix,desc:t.customMixDesc}].map(m=>(
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
            <div style={{background:"var(--color-background-primary)",borderRadius:12,padding:"14px 16px",border:"0.5px solid var(--color-border-tertiary)"}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                <span style={{fontSize:13,color:"var(--color-text-secondary)"}}>questions</span>
                <span style={{fontWeight:700,fontSize:18,color:"#4f46e5"}}>{Math.min(Math.max(parseInt(examTotalQ)||1,1),100)}</span>
              </div>
              <input type="range" min={1} max={100} step={1} value={Math.min(Math.max(parseInt(examTotalQ)||1,1),100)} onChange={e=>setExamTotalQ(e.target.value)} style={{width:"100%",accentColor:"#4f46e5",cursor:"pointer"}}/>
              <div style={{display:"flex",justifyContent:"space-between",fontSize:10,color:"var(--color-text-tertiary)",marginTop:2}}><span>1</span><span>100</span></div>
            </div>
          </div>
        )}
        {examMode==="custom"&&(
          <div style={{marginBottom:20}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
              <p style={{...Sb.secLabel,margin:0}}>EXAM SECTIONS</p>
              {examSections.length<5&&<button onClick={addSection} style={{background:"#ede9fe",border:"1px solid #a5b4fc",color:"#4f46e5",borderRadius:8,padding:"5px 12px",fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>+ Add Section</button>}
            </div>
            <div style={{display:"flex",flexDirection:"column",gap:10}}>
              {examSections.map((sec,si)=>{
                const secMarks=(parseInt(sec.count)||0)*(parseFloat(sec.marksPerQ)||1);
                return (
                  <div key={sec.id} style={{background:"var(--color-background-primary)",borderRadius:12,border:"0.5px solid var(--color-border-tertiary)",overflow:"hidden"}}>
                    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"10px 14px",borderBottom:"0.5px solid var(--color-border-tertiary)",background:si%2===0?"#f5f3ff":"#fef3c7"}}>
                      <span style={{fontWeight:700,fontSize:13,color:si%2===0?"#4f46e5":"#92400e"}}>Section {si+1}</span>
                      <div style={{display:"flex",alignItems:"center",gap:8}}>
                        <span style={{fontSize:11,fontWeight:600,color:"var(--color-text-secondary)"}}>{secMarks} marks</span>
                        {examSections.length>1&&<button onClick={()=>removeSection(sec.id)} style={{background:"none",border:"none",cursor:"pointer",color:"var(--color-text-tertiary)",fontSize:16,lineHeight:1,padding:"0 2px"}}>✕</button>}
                      </div>
                    </div>
                    <div style={{display:"flex",flexDirection:"column",gap:12,padding:"12px 14px"}}>
                      <div style={{display:"grid",gridTemplateColumns:"1fr 96px",gap:8,alignItems:"end"}}>
                        <div>
                          <div style={{fontSize:10,fontWeight:600,color:"var(--color-text-tertiary)",marginBottom:4}}>QUESTION TYPE</div>
                          <select value={sec.type} onChange={e=>updateSection(sec.id,"type",e.target.value)} style={{width:"100%",borderRadius:8,border:"0.5px solid var(--color-border-secondary)",background:"var(--color-background-tertiary)",color:"var(--color-text-primary)",fontSize:13,padding:"7px 8px",fontFamily:"inherit",outline:"none"}}>
                            <option value="mcq">Multiple Choice</option>
                            <option value="written">Written (Open)</option>
                            <option value="fill">Fill in Blank</option>
                          </select>
                        </div>
                        <div>
                          <div style={{fontSize:10,fontWeight:600,color:"var(--color-text-tertiary)",marginBottom:4}}>MARKS/Q</div>
                          <input type="number" min={0.5} max={20} step={0.5} value={sec.marksPerQ} onChange={e=>updateSection(sec.id,"marksPerQ",e.target.value)} style={{width:"100%",borderRadius:8,border:"0.5px solid var(--color-border-secondary)",background:"var(--color-background-tertiary)",color:"var(--color-text-primary)",fontSize:15,fontWeight:700,padding:"7px 6px",fontFamily:"inherit",outline:"none",textAlign:"center",boxSizing:"border-box"}}/>
                        </div>
                      </div>
                      <div>
                        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
                          <span style={{fontSize:10,fontWeight:600,color:"var(--color-text-tertiary)"}}>QUESTIONS</span>
                          <span style={{fontWeight:700,fontSize:14,color:"#4f46e5"}}>{Math.min(Math.max(parseInt(sec.count)||1,1),100)}</span>
                        </div>
                        <input type="range" min={1} max={100} step={1} value={Math.min(Math.max(parseInt(sec.count)||1,1),100)} onChange={e=>updateSection(sec.id,"count",e.target.value)} style={{width:"100%",accentColor:"#4f46e5",cursor:"pointer"}}/>
                        <div style={{display:"flex",justifyContent:"space-between",fontSize:10,color:"var(--color-text-tertiary)",marginTop:2}}><span>1</span><span>100</span></div>
                      </div>
                    </div>
                    <div style={{padding:"6px 14px 10px",fontSize:11,color:"var(--color-text-secondary)"}}>
                      {parseInt(sec.count)||0} {sec.type==="mcq"?"multiple choice":sec.type==="fill"?"fill-in-blank":"written"} questions × {parseFloat(sec.marksPerQ)||1} marks = <strong>{secMarks} marks</strong>
                    </div>
                  </div>
                );
              })}
            </div>
            <div style={{marginTop:12,background:"linear-gradient(135deg,#1e1b4b,#4f46e5)",borderRadius:10,padding:"12px 16px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <span style={{fontSize:13,color:"rgba(255,255,255,0.8)"}}>Total exam</span>
              <span style={{fontSize:15,fontWeight:700,color:"#fff"}}>{sectionTotalQs} questions · {sectionTotalMarks} marks</span>
            </div>
          </div>
        )}
        {examMode && (
          <div style={{marginBottom:22}}>
            <p style={Sb.secLabel}>TIMER</p>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",background:"var(--color-background-primary)",borderRadius:12,padding:"12px 16px",border:"0.5px solid var(--color-border-tertiary)"}}>
              <div>
                <div style={{fontSize:14,fontWeight:600,color:"var(--color-text-primary)"}}>⏱ Enable Timer</div>
                <div style={{fontSize:11,color:"var(--color-text-tertiary)",marginTop:2}}>Add a countdown to the whole exam</div>
              </div>
              <Toggle on={examTimerOn} onChange={setExamTimerOn}/>
            </div>
            {examTimerOn && (
              <div style={{marginTop:10,background:"var(--color-background-primary)",borderRadius:12,padding:"12px 16px",border:"0.5px solid var(--color-border-tertiary)"}}>
                <div style={{display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
                  <span style={{fontSize:13,color:"var(--color-text-secondary)"}}>Total exam time (minutes):</span>
                  <input type="number" min={5} max={180} value={examTimerMin} onChange={e=>setExamTimerMin(e.target.value)} style={{width:80,borderRadius:8,border:"0.5px solid var(--color-border-secondary)",background:"var(--color-background-tertiary)",color:"var(--color-text-primary)",fontSize:16,fontWeight:700,padding:"7px 10px",fontFamily:"inherit",outline:"none",textAlign:"center"}}/>
                </div>
                <p style={{fontSize:11,color:"var(--color-text-tertiary)",lineHeight:1.5,margin:"10px 0 0"}}>Timer applies to the entire exam. Unanswered questions when time expires are marked as 0.</p>
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
        <button disabled={!examMode||examFiles.filter(Boolean).length===0} style={{...Sb.btnPrimary,width:"100%",opacity:(!examMode||examFiles.filter(Boolean).length===0)?0.35:1,background:"linear-gradient(135deg,#312e81,#4f46e5)"}} onClick={generateExam}>{t.startExam}</button>
      </div>
      {showSettings&&<SettingsPanel draft={settingsDraft} update={updateDraft} onApply={applySettings} onCancel={cancelSettings} onSignOut={()=>signOut()} onDeleteAccount={confirmDeleteAccount} requiresPassword={requiresPassword} onReauthenticate={reauthenticate} isPro={isPro} onManageSubscription={openPortal} t={t}/>}
    </div>
  );

  // ── EXAM RUN ──────────────────────────────────────────────────────
  if(screen==="exam_run"&&examQs.length>0){
    const q=examQs[examIdx],isLast=examIdx+1===examQs.length,answered=Object.keys(examAns).length;
    return (
      <div style={Sb.root}><style>{CSS}</style>
      <AdBanners isPro={isPro}/>
      {upgraded && <div style={{position:"fixed",top:0,left:0,right:0,zIndex:800,background:"#16a34a",color:"#fff",textAlign:"center",padding:"11px 14px",fontSize:14,fontWeight:700,fontFamily:"inherit",boxShadow:"0 2px 12px rgba(0,0,0,0.25)"}}>🎉 Welcome to Revyy Pro! You now have full access.</div>}
        <div style={Sb.topbar} className="rv-topbar">
          <button style={Sb.backBtn} onClick={()=>setShowExitConfirm(true)}>Exit</button>
          <div style={{display:"flex",alignItems:"center",gap:12}}>
            <span style={{fontSize:12,fontWeight:600,color:"var(--color-text-secondary)"}}>{t.examProgress} {examIdx+1}/{examQs.length}</span>
            {examTimerOn && examTimeLeft!=null && (
              <span className={examTimeLeft<60?"rv-timer-flash":""} style={{display:"inline-flex",alignItems:"center",gap:4,fontSize:14,fontWeight:800,fontVariantNumeric:"tabular-nums",color: examTimeLeft<60?"#ef4444" : (examTimeLeft/examTotalSec)>0.5?"var(--color-text-primary)" : (examTimeLeft/examTotalSec)>0.25?"#f59e0b":"#ef4444"}}>🕐 {fmtClock(examTimeLeft)}</span>
            )}
          </div>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            {examTimerOn && !examTimeUp && <button onClick={()=>setExamPaused(true)} title="Pause" style={{background:"none",border:"1px solid var(--color-border-secondary)",borderRadius:8,padding:"3px 9px",fontSize:13,cursor:"pointer",color:"var(--color-text-secondary)",fontFamily:"inherit"}}>⏸</button>}
            <span style={{fontSize:11,color:answered===examQs.length?"#16a34a":"var(--color-text-tertiary)",fontWeight:600}}>{answered}/{examQs.length}</span>
          </div>
        </div>
        <div style={{height:4,background:"var(--color-border-tertiary)"}}><div style={{height:"100%",background:"#94a3b8",width:((examIdx/examQs.length)*100)+"%",transition:"width 0.3s"}}/></div>
        {examReview && (
          <div style={{background:"#f0fdf4",borderBottom:"1px solid #86efac",padding:"8px 16px",display:"flex",alignItems:"center",justifyContent:"space-between",gap:10}}>
            <span style={{fontSize:12,color:"#15803d",fontWeight:600}}>Review mode — change any answer, then submit</span>
            <button onClick={()=>submitExam()} style={{background:"#16a34a",color:"#fff",border:"none",borderRadius:8,padding:"7px 14px",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:"inherit",whiteSpace:"nowrap"}}>✓ Final Submit</button>
          </div>
        )}
        <div className="rv-center-narrow" style={{padding:"20px 16px 32px"}}>
          {q.section&&(examIdx===0||examQs[examIdx-1]?.section!==q.section)&&(
            <div style={{background:"linear-gradient(135deg,#1e1b4b,#4f46e5)",borderRadius:10,padding:"10px 16px",marginBottom:14,display:"flex",justifyContent:"space-between",alignItems:"center"}} className="fade-in">
              <span style={{fontWeight:700,fontSize:14,color:"#fff"}}>Section {q.section}</span>
              {examMode==="custom"&&examSections[q.section-1]&&(
                <span style={{fontSize:11,color:"rgba(255,255,255,0.75)"}}>{examSections[q.section-1].count} Qs · {(parseInt(examSections[q.section-1].count)||0)*(parseFloat(examSections[q.section-1].marksPerQ)||1)} marks</span>
              )}
            </div>
          )}
          <div style={{display:"flex",gap:8,marginBottom:16,flexWrap:"wrap"}}>
            <span style={{background:q.type==="mcq"?"#ede9fe":"#fef3c7",color:q.type==="mcq"?"#4f46e5":"#92400e",borderRadius:20,padding:"4px 12px",fontSize:11,fontWeight:700}}>{q.type==="mcq"?"Multiple Choice":q.type==="fill"?"Fill in Blank":"Written"}</span>
            {examAns[examIdx]!==undefined&&<span style={{background:"#f0fdf4",color:"#16a34a",borderRadius:20,padding:"4px 10px",fontSize:11,fontWeight:600}}>Answered</span>}
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
              {examIdx>0&&<button onClick={prevExam} style={{...Sb.btnOutline,padding:"13px 20px",fontSize:13}}>← Prev</button>}
              <button onClick={nextExam} style={{...Sb.btnPrimary,flex:1,margin:0,background:isLast?"#16a34a":"#4f46e5",fontSize:14}}>{isLast?t.submitExam:t.next}</button>
            </div>
          )}
          {isLast&&q.type!=="fill"&&<p style={{fontSize:11,color:"var(--color-text-tertiary)",textAlign:"center",marginTop:8}}>Review your answers above before submitting.</p>}
        </div>
        <ExitModal show={showExitConfirm}
          title="Are you sure you want to exit?"
          message="Your exam progress will be lost and cannot be recovered."
          stayLabel="Continue Exam" leaveLabel="Exit" stayGreen
          onStay={()=>setShowExitConfirm(false)}
          onLeave={()=>{setShowExitConfirm(false);try{sessionStorage.removeItem("revyy_exam")}catch{ /* ignore */ };setScreen("exam_setup");}}/>

        {/* Submit-before-time-up review prompt */}
        {showSubmitPrompt && (
          <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.55)",zIndex:560,display:"flex",alignItems:"center",justifyContent:"center",padding:"20px"}}>
            <div className="slide-up" style={{background:"var(--color-background-primary)",borderRadius:16,padding:"26px 22px",maxWidth:330,width:"100%",textAlign:"center",boxShadow:"0 8px 32px rgba(0,0,0,0.25)"}}>
              <div style={{fontSize:34,marginBottom:8}}>📋</div>
              <h3 style={{margin:"0 0 8px",fontSize:18,fontWeight:700,color:"var(--color-text-primary)",fontFamily:"'Playfair Display',Georgia,serif"}}>Submit your exam?</h3>
              <p style={{margin:"0 0 18px",fontSize:13,color:"var(--color-text-secondary)",lineHeight:1.5}}>You still have <strong style={{color:"#4f46e5"}}>{fmtClock(examTimeLeft||0)}</strong> remaining. Review your answers before submitting?</p>
              <div style={{display:"flex",flexDirection:"column",gap:10}}>
                <button onClick={()=>{setShowSubmitPrompt(false);setExamReview(true);setExamIdx(0);}} style={{...Sb.btnPrimary,width:"100%",margin:0,background:"#4f46e5",fontSize:14}}>Review Answers</button>
                <button onClick={()=>{setShowSubmitPrompt(false);submitExam();}} style={{width:"100%",background:"#16a34a",color:"#fff",border:"none",borderRadius:12,padding:"13px",fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>Submit Now</button>
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
      <p style={{fontSize:13,color:"var(--color-text-secondary)",marginBottom:24}}>AI is reading and grading each written answer</p>
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
      {upgraded && <div style={{position:"fixed",top:0,left:0,right:0,zIndex:800,background:"#16a34a",color:"#fff",textAlign:"center",padding:"11px 14px",fontSize:14,fontWeight:700,fontFamily:"inherit",boxShadow:"0 2px 12px rgba(0,0,0,0.25)"}}>🎉 Welcome to Revyy Pro! You now have full access.</div>}
        {showConfetti&&<Confetti/>}
        <div style={{background:theme.bg,padding:"40px 20px 32px",textAlign:"center"}}>
          <div style={{fontSize:56,marginBottom:8}}>{theme.emoji}</div>
          <h2 style={{margin:"0 0 8px",fontSize:24,fontWeight:700,color:"#fff",fontFamily:"'Playfair Display',Georgia,serif"}}>{theme.title}</h2>
          <div style={{fontSize:52,fontWeight:900,color:"#fff",letterSpacing:-2,fontFamily:"'Playfair Display',Georgia,serif"}}>{pct}%</div>
          <div style={{fontSize:13,color:"rgba(255,255,255,0.7)",marginTop:4}}>
            {(Math.round(total*10)/10)+" / "+totalPossible+(examMode==="custom"?" marks":" pts")} · {t.passMark}
          </div>
          {excellent&&<div style={{marginTop:12,fontSize:28,letterSpacing:4}}>🎉🎓🎉</div>}
          <p style={{margin:"14px 0 0",fontSize:14,color:"rgba(255,255,255,0.88)",lineHeight:1.6,maxWidth:300,marginLeft:"auto",marginRight:"auto"}}>{theme.msg}</p>
        </div>
        <div className="rv-center" style={{padding:"20px 16px"}}>
          <div style={{display:"flex",gap:10,marginBottom:18}}>
            {[{v:(Math.round(total*10)/10)+"/"+totalPossible,l:t.examScore},{v:pct+"%",l:"Score"},{v:passed?"PASS":"FAIL",l:"Result"}].map(({v,l},i)=>(
              <div key={i} style={{flex:1,background:"var(--color-background-primary)",borderRadius:10,padding:"12px 6px",textAlign:"center",border:"0.5px solid var(--color-border-tertiary)"}}>
                <div style={{fontSize:15,fontWeight:700,color:i===2?(passed?"#16a34a":"#dc2626"):"var(--color-text-primary)"}}>{v}</div>
                <div style={{fontSize:10,color:"var(--color-text-secondary)",marginTop:2}}>{l}</div>
              </div>
            ))}
          </div>
          {(examTimeUsedSec!=null || examTimerOn) && (
            <div style={{display:"flex",gap:10,marginBottom:18}}>
              {[
                {v: examTimeExpired ? "Time Expired" : (examTimeUsedSec!=null ? Math.floor(examTimeUsedSec/60)+" min "+(examTimeUsedSec%60)+" sec" : "—"), l:"Time Used", red:examTimeExpired},
                {v: examAnsweredCount+" / "+examQs.length, l:"Questions Answered"},
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
              <div style={{padding:"10px 14px",borderBottom:"0.5px solid var(--color-border-tertiary)",fontSize:11,fontWeight:700,color:"var(--color-text-secondary)",letterSpacing:1}}>SECTION BREAKDOWN</div>
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
                      <div style={{fontSize:12,fontWeight:600,color:"var(--color-text-primary)"}}>Section {si+1}: {sec.type==="mcq"?"Multiple Choice":sec.type==="fill"?"Fill in Blank":"Written"}</div>
                      <div style={{fontSize:11,color:"var(--color-text-secondary)"}}>{secQs.length} Qs × {sec.marksPerQ} marks</div>
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
                  <span style={{fontSize:9,fontWeight:700,background:q.type==="mcq"?"#ede9fe":"#fef3c7",color:q.type==="mcq"?"#4f46e5":"#92400e",borderRadius:8,padding:"2px 6px",flexShrink:0,marginTop:2}}>{q.type==="mcq"?"MCQ":q.type==="fill"?"FILL":"WRITTEN"}</span>
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
                    <div style={{fontSize:12,color:"var(--color-text-secondary)",marginBottom:3,fontStyle:"italic"}}>Your answer: "{examAns[i]||"(no answer)"}"</div>
                    <div style={{fontSize:12,color:"#16a34a",fontWeight:500}}>Model: {q.answer}</div>
                  </div>
                )}
                {ev?.feedback&&<div style={{background:bg,border:"0.5px solid "+bdr,borderRadius:8,padding:"7px 10px",fontSize:12,color:col,marginTop:6,lineHeight:1.5}}>{ev.feedback}</div>}
                {q.explanation&&<div style={{fontSize:12,color:"var(--color-text-secondary)",lineHeight:1.5,paddingTop:6,borderTop:"0.5px solid var(--color-border-tertiary)",marginTop:6}}>{q.explanation}</div>}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return <SettingsPanel draft={settingsDraft} update={updateDraft} onApply={applySettings} onCancel={cancelSettings} onSignOut={()=>signOut()} onDeleteAccount={confirmDeleteAccount} requiresPassword={requiresPassword} onReauthenticate={reauthenticate} isPro={isPro} onManageSubscription={openPortal} t={t}/>;
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
  .exam-type-card:hover{transform:translateY(-2px);box-shadow:0 4px 16px rgba(79,70,229,0.18)!important;border-color:#4f46e5!important;background:#f5f3ff!important}
  button:hover:not(:disabled){opacity:0.9;transform:translateY(-1px)}
  button:active:not(:disabled){transform:scale(0.97)}
  .quiz-opt:hover:not(:disabled){transform:translateX(4px)!important;border-color:#4f46e5!important;background:#f5f3ff!important;box-shadow:2px 0 0 0 #4f46e5}
  .quiz-opt:active:not(:disabled){transform:translateX(2px)!important}
  textarea:focus,input:focus{border-color:#4f46e5!important;box-shadow:0 0 0 2px #4f46e520}
  select{appearance:auto}
  .no-anim *{animation:none!important;transition:none!important}
  @keyframes slideFromRight{from{transform:translateX(100%)}to{transform:translateX(0)}}
  @keyframes rvTimerFlash{0%,100%{opacity:1}50%{opacity:0.25}}
  .rv-timer-flash{animation:rvTimerFlash 1s steps(1) infinite}
  .settings-panel{animation:slideFromRight 0.22s ease}
  ::-webkit-scrollbar{width:4px}::-webkit-scrollbar-thumb{background:var(--color-border-secondary);border-radius:2px}

  /* ── Desktop layout ────────────────────────────────────────────── */
  @media(min-width:768px){
    /* Root: wider centered card */
    .rv-root-inner{max-width:900px;margin:0 auto;width:100%;}

    /* Hero: wider, side-by-side text and CTA */
    .rv-hero-inner{max-width:860px;margin:0 auto;display:grid;grid-template-columns:1fr auto;gap:40px;align-items:center;}
    .rv-hero-inner h1{font-size:40px!important;}

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
