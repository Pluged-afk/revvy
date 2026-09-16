// Full-screen overlays + celebration components extracted from StudyQuiz.jsx:
// exit / pause / time-up / resume exam prompts, confetti, the rank-promotion
// moment, ad placeholders, the Pro-activating spinner and the mock passage
// panel. Leaf UI; pull their own translations via useLang.
import { useState } from "react";
import Icon from "../components/Icon.jsx";
import { useLang } from "../context/LanguageContext.jsx";
import { useDev } from "../context/DevContext.jsx";
import { RANKS } from "../lib/badges.js";
import { ADS_ENABLED } from "./constants.js";

export function ExitModal({ show, onStay, onLeave, message, title, stayLabel, leaveLabel, stayGreen }) {
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
export function PauseOverlay({ onResume }) {
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
export function TimeUpModal() {
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
export function ResumeModal({ info, onResume, onDiscard, fmtClock }) {
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

export function Confetti() {
  // computed once at mount, not every render (fire-once decoration)
  const [pieces] = useState(() => Array.from({length:60},(_,i)=>({
    id:i, x:Math.random()*100, delay:Math.random()*2.5, dur:1.8+Math.random()*2,
    color:["#4338ca","#f59e0b","#22c55e","#ec4899","#3b82f6","#f97316","#8b5cf6","#06b6d4"][i%8],
    size:6+Math.random()*8, shape:i%3,
  })));
  return (
    <div style={{position:"fixed",inset:0,pointerEvents:"none",overflow:"hidden",zIndex:999}}>
      <style>{"@keyframes cfFall{0%{transform:translateY(-20px) rotate(0deg);opacity:1}100%{transform:translateY(110vh) rotate(720deg);opacity:0}}"}</style>
      {pieces.map(p=>(
        <div key={p.id} style={{position:"absolute",left:p.x+"%",top:0,width:p.size,height:p.size,background:p.color,borderRadius:p.shape===0?"50%":"2px",animation:"cfFall "+p.dur+"s "+p.delay+"s ease-in forwards"}}/>
      ))}
    </div>
  );
}

// A one-time, full-screen moment shown when an Arena run pushes the player's
// best score into a higher rank tier. Purely presentational: the parent mounts
// it ONLY on a genuine promotion (so it never replays on reopen) and dismisses
// it. The insignia pops in over rotating rays + a pulsing glow in the rank's
// colour, with a from -> to strip so the climb is legible.
export function RankPromotion({ fromIdx, toIdx, best, t, onClose, onSeeRanks }) {
  const to = RANKS[toIdx] || RANKS[RANKS.length - 1];
  const from = RANKS[Math.max(0, fromIdx)] || RANKS[0];
  const c = to.color;
  const nm = (t["rank_" + to.key]) || to.name;
  const fromNm = (t["rank_" + from.key]) || from.name;
  return (
    <div className="rv-promo-wrap" onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 960, display: "flex", alignItems: "center", justifyContent: "center", padding: 18, background: "rgba(20,16,10,0.62)" }}>
      <div className="rv-promo-card" onClick={(e) => e.stopPropagation()} style={{ position: "relative", overflow: "hidden", width: "100%", maxWidth: 342, textAlign: "center", background: "var(--color-background-primary)", border: `2px solid ${c}`, borderRadius: 24, padding: "34px 26px 24px", boxShadow: `0 30px 80px ${c}66, 0 0 0 6px ${c}14` }}>
        <div style={{ position: "relative", width: 150, height: 150, margin: "0 auto 4px" }}>
          <div className="rv-promo-rays" aria-hidden="true" style={{ background: `conic-gradient(from 0deg, ${c}00, ${c}55, ${c}00, ${c}55, ${c}00, ${c}55, ${c}00, ${c}55, ${c}00)` }} />
          <div className="rv-promo-glow" aria-hidden="true" style={{ background: `radial-gradient(circle, ${c}55, ${c}00 70%)` }} />
          <div className="rv-promo-disc" style={{ background: `${c}1f`, border: `2px solid ${c}` }}>
            <div className="rv-promo-badge"><Icon name={to.icon} size={62} stroke={1.7} style={{ color: c }} /></div>
          </div>
        </div>
        <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: 2, textTransform: "uppercase", color: c }}>{t.rankPromoted || "Promoted"}</div>
        <div style={{ fontSize: 30, fontWeight: 800, fontFamily: "'Fraunces',Georgia,serif", color: c, margin: "3px 0 2px" }}>{nm}</div>
        <div style={{ fontSize: 13, color: "var(--color-text-secondary)", marginBottom: 14 }}>{t.rankPromoReached || "You've climbed to a new rank. Keep going."}</div>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 10, background: "var(--color-background-secondary)", borderRadius: 999, padding: "6px 14px", marginBottom: 14 }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, opacity: 0.6 }}><Icon name={from.icon} size={16} stroke={1.7} style={{ color: from.color }} /><span style={{ fontSize: 12, fontWeight: 700, color: "var(--color-text-secondary)" }}>{fromNm}</span></span>
          <Icon name="arrow" size={14} style={{ color: "var(--color-text-tertiary)" }} />
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><Icon name={to.icon} size={16} stroke={1.7} style={{ color: c }} /><span style={{ fontSize: 12, fontWeight: 800, color: c }}>{nm}</span></span>
        </div>
        {best != null && <div style={{ fontSize: 12.5, color: "var(--color-text-tertiary)", marginBottom: 16 }}>{(t.rankPromoBest || "New best: {n} pts").replace("{n}", (best || 0).toLocaleString())}</div>}
        <button onClick={onClose} style={{ width: "100%", background: c, color: "#fff", border: "none", borderRadius: 12, padding: "12px", fontSize: 14.5, fontWeight: 700, fontFamily: "inherit", cursor: "pointer" }}>{t.rankPromoContinue || "Continue"}</button>
        {onSeeRanks && <button onClick={onSeeRanks} style={{ width: "100%", background: "none", border: "none", color: "var(--color-text-tertiary)", fontSize: 12.5, cursor: "pointer", fontFamily: "inherit", padding: "12px 4px 0" }}>{t.rankPromoSeeRanks || "See all ranks"}</button>}
        <div className="rv-promo-shimmer" aria-hidden="true" />
      </div>
    </div>
  );
}

// Side 160x600 banners (desktop margins) + a 320x50 bottom anchor (mobile).
// `bottom` can be turned off on screens that already have an in-content banner
// so mobile never shows two banners stacked at once.
export function AdBanners({ isPro, bottom = true }) {
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
export function ActivatingOverlay({ show }) {
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
export function MockPassagePanel({ passage, svg, activeU, label }) {
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
