// Interactive quiz-type components extracted from StudyQuiz.jsx: the per-type
// answer UIs (flashcard, fill-in-blank, short-answer, matching) plus the
// auto-advance bar and the source-quote popover. Depend only on shared modules.
import { useState, useEffect } from "react";
import Icon from "../components/Icon.jsx";
import { Sb } from "./styles.js";
import { Haptics } from "./audio.js";
import { gradeWritten } from "./ai.js";

// Sliding countdown bar shown while auto-advance waits before the next
// question. Fills 0→100% over `sec` seconds via CSS animation. The `runId`
// key restarts the animation cleanly on each new question.
export function AutoAdvanceBar({ sec, runId, t }) {
  return (
    <div style={{marginTop:16}}>
      <div style={{fontSize:11,color:"var(--color-text-tertiary)",marginBottom:5,textAlign:"center"}}>{t?.autoAdvancing||"Next question in a moment…"}</div>
      <div style={{height:4,background:"var(--color-border-tertiary)",borderRadius:2,overflow:"hidden"}}>
        <div key={runId} style={{height:"100%",background:"#4338ca",borderRadius:2,animation:`rvAutoBar ${sec}s linear forwards`}}/>
      </div>
    </div>
  );
}

export function Flashcard({ q, onNext, t }) {
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
          <button onClick={()=>{Haptics.buzz();setFlipped(false);setTimeout(()=>onNext(false),200);}} style={{flex:1,background:"var(--color-background-danger)",border:"1px solid var(--color-border-danger)",color:"var(--color-text-danger)",borderRadius:12,padding:"12px",fontSize:14,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>{t.fcDidntKnow}</button>
          <button onClick={()=>{Haptics.buzz();setFlipped(false);setTimeout(()=>onNext(true),200);}} style={{flex:1,background:"var(--color-background-success)",border:"1px solid var(--color-border-success)",color:"var(--color-text-success)",borderRadius:12,padding:"12px",fontSize:14,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>{t.gotIt}</button>
        </div>
      )}
    </div>
  );
}

export function FillBlank({ q, onNext, isLast, t, feedback="immediate", autoAdvance=false, autoSec=5 }) {
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
        <div style={{borderRadius:10,padding:"12px 14px",background:isRight?"var(--color-background-success)":"var(--color-background-danger)",border:`0.5px solid ${isRight?"var(--color-border-success)":"var(--color-border-danger)"}`,color:isRight?"var(--color-text-success)":"var(--color-text-danger)",marginBottom:14}} className="slide-up">
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

// Short-answer question: type a response, the AI grades it against the model
// answer, then the verdict + model answer + feedback are revealed. onNext mirrors
// the other quiz types; partial credit (0.5) counts as correct for the score.
export function WrittenAnswer({ q, onNext, isLast, t, subject }) {
  const [val, setVal] = useState("");
  const [grading, setGrading] = useState(false);
  const [res, setRes] = useState(null); // { score, feedback } once graded
  const submit = async () => {
    if (grading || res || !val.trim()) return;
    Haptics.buzz();
    setGrading(true);
    try { setRes(await gradeWritten({ question: q.question, modelAnswer: q.answer, userAnswer: val, subject })); }
    catch { setRes({ score: 0, feedback: t.gradeFailed || "Couldn't grade that, here's the model answer." }); }
    setGrading(false);
  };
  const done = () => onNext(res ? res.score >= 0.5 : false, { chosen: val, score: res?.score ?? 0, feedback: res?.feedback || "" });
  const right = !!res && res.score >= 0.5, partial = !!res && res.score === 0.5;
  return (
    <div>
      <div style={{fontFamily:"'Fraunces',Georgia,serif",fontSize:18,fontWeight:700,color:"var(--color-text-primary)",lineHeight:1.5,marginBottom:16}}>{q.question}<SourceMark source={q.source} label={t.srcSeeQuestion} t={t}/></div>
      {!res && <textarea value={val} onChange={e=>setVal(e.target.value)} placeholder={t.typeAnswer} disabled={grading} style={{...Sb.textarea,height:130,marginBottom:10}}/>}
      {!res && <button disabled={!val.trim()||grading} onClick={submit} style={{...Sb.btnPrimary,width:"100%",opacity:(val.trim()&&!grading)?1:0.35}}>{grading?(t.grading||"Grading…"):t.check}</button>}
      {res && (
        <div style={{borderRadius:10,padding:"12px 14px",background:right?"var(--color-background-success)":"var(--color-background-danger)",border:`0.5px solid ${right?"var(--color-border-success)":"var(--color-border-danger)"}`,color:right?"var(--color-text-success)":"var(--color-text-danger)",marginBottom:14}} className="slide-up">
          <strong>{partial?(t.partial||"Partially correct"):right?t.correct:t.incorrect}</strong>
          {q.answer && <div style={{fontSize:13,marginTop:6}}>{t.fbAnswerLabel} <strong>{q.answer}</strong></div>}
          {res.feedback && <p style={{margin:"8px 0 0",fontSize:13,lineHeight:1.5}}>{res.feedback}</p>}
        </div>
      )}
      {res && <button onClick={done} style={{...Sb.btnPrimary,width:"100%"}}>{isLast?t.finish:t.next}</button>}
    </div>
  );
}

// Distinct colors so each matched pair is visually linked by both a numbered
// badge and its border color (term on the left ↔ its definition on the right).
const PAIR_COLORS = ["#6366f1","#ec4899","#f59e0b","#10b981","#06b6d4","#8b5cf6","#ef4444","#f43f5e","#0ea5e9","#84cc16"];

const pairColor = n => PAIR_COLORS[((n||1)-1)%PAIR_COLORS.length];

export function PairBadge({ n, color }) {
  return <span style={{display:"inline-flex",alignItems:"center",justifyContent:"center",minWidth:18,height:18,padding:"0 5px",borderRadius:9,background:color,color:"#fff",fontSize:10,fontWeight:700,flexShrink:0,marginTop:1}}>{n}</span>;
}

export function MatchQuiz({ questions, onDone, t }) {
  const terms = questions.map(q=>q.question);
  // shuffle once at mount (useRef's arg re-runs every render; useState lazy-inits once)
  const [defs] = useState(() => questions.map(q=>q.answer||"").sort(()=>Math.random()-0.5));
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

// Feature A: a small marker placed at the end of a question (and, in the review,
// next to the answer). Hover tells you what it is; click reveals the exact words
// in the learner's OWN material that the question/answer came from. When nothing
// was found in their notes, it says so, so they know to double-check. Revyy's
// edge: because quizzes come from YOUR notes, we can show the receipt.
export function SourceMark({ source, label, quoteLabel, t }) {
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
