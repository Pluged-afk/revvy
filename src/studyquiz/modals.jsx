// Modal + overlay components extracted from StudyQuiz.jsx: upgrade / packs /
// unlock prompts, the shareable score-card (with its canvas renderer), the rank
// ladder, share link, username picker and bug-report form. Leaf UI over shared
// modules; the canvas helpers + UNLOCK_META stay module-private.
import { useState, useEffect, useRef } from "react";
import Icon from "../components/Icon.jsx";
import { Sb } from "./styles.js";
import { RANKS } from "../lib/badges.js";
import { QUESTION_PACKS } from "./constants.js";

// Public-name picker. Shown once after login (skippable) and required before the
// Arena. Validated live: 3-20 letters, numbers or underscore.
export function UsernameModal({ value, onChange, onSave, onSkip, err, busy, t }) {
  const valid = /^[A-Za-z0-9_]{3,20}$/.test(value.trim());
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.6)",zIndex:650,display:"flex",alignItems:"flex-end"}}>
      <div className="slide-up" style={{background:"var(--color-background-primary)",borderRadius:"20px 20px 0 0",padding:"26px 20px 34px",width:"100%",maxWidth:520,margin:"0 auto",boxSizing:"border-box"}}>
        <div style={{textAlign:"center",marginBottom:16}}>
          <div style={{marginBottom:8,display:"flex",justifyContent:"center",color:"var(--color-accent)"}}><Icon name="tag" size={28} stroke={1.7}/></div>
          <h3 style={{margin:"0 0 6px",fontSize:19,fontWeight:700,fontFamily:"'Fraunces',Georgia,serif",color:"var(--color-text-primary)"}}>{t.unameTitle}</h3>
          <p style={{fontSize:13,color:"var(--color-text-secondary)",lineHeight:1.5}}>{t.unameSub}</p>
        </div>
        <input value={value} maxLength={20} inputMode="text" autoFocus placeholder={t.unamePlaceholder}
          onChange={e=>onChange(e.target.value.replace(/[^A-Za-z0-9_]/g,""))}
          onKeyDown={e=>{ if(e.key==="Enter" && valid && !busy) onSave(); }}
          style={{width:"100%",borderRadius:11,border:"1.5px solid var(--color-border-secondary)",background:"var(--color-background-tertiary)",color:"var(--color-text-primary)",fontSize:16,fontWeight:600,padding:"12px 14px",fontFamily:"inherit",outline:"none",boxSizing:"border-box",textAlign:"center",letterSpacing:0.3}}/>
        {err && <div style={{fontSize:12.5,color:"#dc2626",marginTop:9,textAlign:"center"}}>{err}</div>}
        <button disabled={!valid||busy} onClick={onSave} style={{...Sb.btnPrimary,width:"100%",marginTop:14,opacity:(!valid||busy)?0.5:1}}>{busy?t.unameSaving:t.unameSave}</button>
        {onSkip && <button onClick={onSkip} style={{width:"100%",background:"none",border:"none",color:"var(--color-text-tertiary)",fontSize:12.5,cursor:"pointer",fontFamily:"inherit",padding:"12px 4px 0"}}>{t.unameLater}</button>}
      </div>
    </div>
  );
}

export function ProModal({ onClose, onMonthly, onYearly, busy, error, t }) {
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.6)",zIndex:500,display:"flex",alignItems:"flex-end"}} onClick={()=>!busy&&onClose()}>
      <div className="slide-up" onClick={e=>e.stopPropagation()} style={{background:"var(--color-background-primary)",borderRadius:"20px 20px 0 0",padding:"28px 20px 36px",width:"100%",maxHeight:"88vh",overflowY:"auto",boxSizing:"border-box"}}>
        <div style={{textAlign:"center",marginBottom:14}}>
          <div style={{marginBottom:8,display:"flex",justifyContent:"center",color:"#f59e0b"}}><Icon name="spark" size={38} stroke={1.6}/></div>
          <h3 style={{margin:"0 0 4px",fontSize:21,fontWeight:700,fontFamily:"'Fraunces',Georgia,serif",color:"var(--color-text-primary)"}}>{t.upgradeToPro}</h3>
        </div>
        <div style={{background:"linear-gradient(135deg,var(--color-sel-tint),var(--color-sel-tint))",borderRadius:12,padding:"12px 14px",marginBottom:14,fontSize:12.5,color:"var(--color-accent)",lineHeight:1.6,textAlign:"center"}}>{t.proDesc}</div>
        {error && <div style={{background:"var(--color-background-danger)",border:"1px solid #fecaca",color:"var(--color-text-danger)",borderRadius:10,padding:"9px 12px",fontSize:12.5,marginBottom:14}}>{error}</div>}
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

export function PacksModal({ onClose, buyPack, t }) {
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

// One modal per feature; watching a (placeholder) ad starts a 1-hour window.
const UNLOCK_META = {
  flashcard:   { icon:"layers", title:"Flashcards",        gives:"the Flashcards quiz type",        daily:false },
  fillinblank: { icon:"pencil", title:"Fill in the blank", gives:"the Fill-in-the-blank quiz type", daily:true  },
  matchterms:  { icon:"link",   title:"Match terms",        gives:"the Match-terms quiz type",        daily:true  },
  questions:   { icon:"list",   title:"50 questions",       gives:"up to 50 questions per quiz",      daily:true  },
  filesize:    { icon:"folder", title:"10 MB uploads",      gives:"file uploads up to 10 MB",         daily:true  },
};

export function UnlockModal({ feature, unlocks, onClose, onUpgrade, t }) {
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

// Draws a branded result image (1080x1350, story-friendly) entirely on a canvas
// so it ships with the app: no external library, no CSP concern. The card is a
// screenshot-worthy payoff and a free growth surface (people post it).
function rr(ctx, x, y, w, h, r) {
  if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); }
  else { ctx.beginPath(); ctx.rect(x, y, w, h); }
}

function fitText(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(s + "…").width > maxW) s = s.slice(0, -1);
  return s.trimEnd() + "…";
}

async function buildScoreCard(canvas, d, t) {
  const W = 1080, H = 1350, cx = W / 2;
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");
  try { if (document.fonts?.ready) await document.fonts.ready; } catch { /* ignore */ }
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, "#4f46e5"); g.addColorStop(1, "#7c3aed");
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  const rg = ctx.createRadialGradient(cx, H * 0.14, 60, cx, H * 0.14, W * 0.82);
  rg.addColorStop(0, "rgba(255,255,255,0.20)"); rg.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = rg; ctx.fillRect(0, 0, W, H);
  // Inset frame for a "card" feel
  ctx.strokeStyle = "rgba(255,255,255,0.22)"; ctx.lineWidth = 3;
  rr(ctx, 44, 44, W - 88, H - 88, 44); ctx.stroke();
  // Header: wordmark + URL, with a hairline divider under it
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left"; ctx.fillStyle = "#fff";
  ctx.font = "700 66px Fraunces, Georgia, serif"; ctx.fillText("Revyy", 100, 176);
  ctx.textAlign = "right"; ctx.font = "500 34px system-ui, sans-serif";
  ctx.fillStyle = "rgba(255,255,255,0.72)"; ctx.fillText("revyy.app", W - 100, 168);
  ctx.strokeStyle = "rgba(255,255,255,0.18)"; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(100, 218); ctx.lineTo(W - 100, 218); ctx.stroke();
  // Label
  ctx.textAlign = "center";
  ctx.font = "700 34px system-ui, sans-serif"; ctx.fillStyle = "rgba(255,255,255,0.72)";
  ctx.fillText((t.scoreCardLabel || "Quiz result").toUpperCase(), cx, 372);
  // Hero score
  ctx.fillStyle = "#fff"; ctx.font = "700 268px Fraunces, Georgia, serif";
  ctx.fillText(`${d.score}/${d.total}`, cx, 648);
  // Percent (prominent) + subject on its own line
  ctx.font = "700 86px system-ui, sans-serif"; ctx.fillStyle = "#fde68a";
  ctx.fillText(`${d.pct}%`, cx, 758);
  if (d.subject) { ctx.font = "500 46px system-ui, sans-serif"; ctx.fillStyle = "rgba(255,255,255,0.9)"; ctx.fillText(fitText(ctx, d.subject, W - 220), cx, 826); }
  // Rank pill
  const rankText = `${d.rankEmoji || "🎓"}  ${d.rankName || ""}`.trim();
  ctx.font = "600 46px system-ui, sans-serif";
  const rw = ctx.measureText(rankText).width, pw = rw + 96, ph = 100, py = d.subject ? 890 : 858;
  ctx.fillStyle = "rgba(255,255,255,0.16)"; rr(ctx, cx - pw / 2, py, pw, ph, 50); ctx.fill();
  ctx.fillStyle = "#fff"; ctx.textBaseline = "middle";
  ctx.fillText(rankText, cx, py + ph / 2 + 3); ctx.textBaseline = "alphabetic";
  // Divider before the stat row
  ctx.strokeStyle = "rgba(255,255,255,0.16)"; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(cx - 230, 1058); ctx.lineTo(cx + 230, 1058); ctx.stroke();
  // Stat row
  const stat = [];
  if (d.streak > 0) stat.push(`🔥 ${d.streak} ${t.dayStreakLabel || "day streak"}`);
  stat.push(`⚡ ${Number(d.xp || 0).toLocaleString()} XP`);
  ctx.font = "600 46px system-ui, sans-serif"; ctx.fillStyle = "rgba(255,255,255,0.95)"; ctx.textAlign = "center";
  ctx.fillText(stat.join("        "), cx, 1132);
  // CTA (solid white pill = looks like a button)
  const cta = t.scoreCardCta || "Beat my score at revyy.app";
  ctx.font = "700 42px system-ui, sans-serif";
  const cw = ctx.measureText(cta).width + 92, ch = 108, cyy = 1198;
  ctx.fillStyle = "#fff"; rr(ctx, cx - cw / 2, cyy, cw, ch, 28); ctx.fill();
  ctx.fillStyle = "#4f46e5"; ctx.textBaseline = "middle";
  ctx.fillText(cta, cx, cyy + ch / 2 + 2); ctx.textBaseline = "alphabetic";
}

// Share the rendered card as a PNG: native share sheet where supported (mobile),
// otherwise a download. Returns the method used (or null on failure/cancel).
async function shareScoreCard(canvas, { text, filename = "revyy-result.png" }) {
  const blob = await new Promise((res) => canvas.toBlob(res, "image/png"));
  if (!blob) return null;
  const file = new File([blob], filename, { type: "image/png" });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], text });
      return "share";
    }
  } catch { return null; /* user cancelled the share sheet */ }
  try {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
    return "download";
  } catch { return null; }
}

export function ScoreCardModal({ data, t, onClose }) {
  const canvasRef = useRef(null);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    (async () => {
      const c = canvasRef.current; if (!c) return;
      await buildScoreCard(c, data, t);
      if (!alive) return;
      try { setUrl(c.toDataURL("image/png")); } catch { /* tainted/unsupported */ }
    })();
    return () => { alive = false; };
  }, [data, t]);
  const doShare = async () => {
    const c = canvasRef.current; if (!c || busy) return;
    setBusy(true);
    await shareScoreCard(c, { text: t.scoreCardCta || "Beat my score at revyy.app" });
    setBusy(false);
  };
  const btn = { flex: 1, borderRadius: 12, padding: "12px", fontSize: 13.5, fontWeight: 700, cursor: busy ? "default" : "pointer", fontFamily: "inherit", border: "none" };
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 700, background: "rgba(0,0,0,0.62)", display: "flex", alignItems: "center", justifyContent: "center", padding: 18 }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "var(--color-background-primary)", borderRadius: 22, padding: 20, maxWidth: 430, width: "100%", display: "flex", flexDirection: "column", alignItems: "center", gap: 16 }}>
        <canvas ref={canvasRef} style={{ display: "none" }} />
        {url
          ? <img src={url} alt="" style={{ width: "100%", maxWidth: 384, borderRadius: 18, boxShadow: "0 16px 44px rgba(0,0,0,0.32)" }} />
          : <div style={{ width: 384, maxWidth: "100%", aspectRatio: "1080 / 1350", borderRadius: 18, background: "var(--color-background-secondary)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, color: "var(--color-text-tertiary)" }}>…</div>}
        <button onClick={doShare} disabled={busy || !url} style={{ ...btn, width: "100%", background: "#4338ca", color: "#fff", opacity: (busy || !url) ? 0.5 : 1, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
          <Icon name="spark" size={16} />{t.shareResultBtn || "Share result"}
        </button>
        <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--color-text-secondary)", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>{t.scoreCardClose || "Close"}</button>
      </div>
    </div>
  );
}

// The full rank ladder: every tier with its own colour + icon, the current one
// highlighted, tiers not yet reached dimmed and locked. Opened by tapping the
// rank on the Badges screen.
export function RanksModal({ currentIndex, xp, t, onClose }) {
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 700, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "flex-end", justifyContent: "center" }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "var(--color-background-primary)", borderRadius: "18px 18px 0 0", padding: "18px 16px 22px", width: "100%", maxWidth: 520, maxHeight: "82vh", overflowY: "auto" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 4 }}>
          <div style={{ fontSize: 17, fontWeight: 800, fontFamily: "'Fraunces',Georgia,serif", color: "var(--color-text-primary)" }}>{t.rankAllTitle || "Ranks"}</div>
          <button onClick={onClose} aria-label={t.scoreCardClose || "Close"} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--color-text-tertiary)", display: "flex", padding: 4 }}><Icon name="x" size={18} /></button>
        </div>
        <div style={{ fontSize: 12.5, color: "var(--color-text-secondary)", marginBottom: 14 }}>{t.rankAllSub || "Climb by scoring higher in the Endless Arena."}</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {RANKS.map((r, i) => {
            const reached = currentIndex >= i, current = currentIndex === i;
            const nm = (t["rank_" + r.key]) || r.name;
            return (
              <div key={r.key} style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 12px", borderRadius: 14, opacity: reached ? 1 : 0.55, background: current ? r.color + "16" : "var(--color-background-secondary)", border: "1px solid " + (current ? r.color : "var(--color-border-secondary)") }}>
                <div style={{ width: 40, height: 40, borderRadius: 12, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", background: r.color + "22", color: r.color }}><Icon name={r.icon} size={21} stroke={1.9} style={{ color: r.color }} /></div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14.5, fontWeight: 800, color: r.color }}>{nm}</div>
                  <div style={{ fontSize: 11.5, color: "var(--color-text-tertiary)", fontFamily: "monospace" }}>{r.min.toLocaleString()} pts{i === RANKS.length - 1 ? "+" : ""}</div>
                </div>
                {current ? <span style={{ flexShrink: 0, fontSize: 10.5, fontWeight: 800, letterSpacing: 0.4, textTransform: "uppercase", color: "#fff", background: r.color, borderRadius: 999, padding: "3px 10px" }}>{t.rankCurrent || "You"}</span>
                  : reached ? <Icon name="check" size={17} stroke={2.4} style={{ color: "#16a34a", flexShrink: 0 }} />
                  : <Icon name="lock" size={15} style={{ color: "var(--color-text-tertiary)", flexShrink: 0 }} />}
              </div>
            );
          })}
        </div>
        <div style={{ fontSize: 11.5, color: "var(--color-text-secondary)", textAlign: "center", marginTop: 14 }}>{(t.rankYourXp || "You have {n} XP").replace("{n}", (xp || 0).toLocaleString())}</div>
      </div>
    </div>
  );
}

export function ShareModal({ link, err, copied, onCopy, onClose, challengeScore, t }) {
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.6)",zIndex:500,display:"flex",alignItems:"flex-end"}} onClick={onClose}>
      <div className="slide-up" onClick={(e)=>e.stopPropagation()} style={{background:"var(--color-background-primary)",borderRadius:"20px 20px 0 0",padding:"26px 20px 36px",width:"100%",maxWidth:520,margin:"0 auto",boxSizing:"border-box"}}>
        <div style={{textAlign:"center",marginBottom:16}}>
          <div style={{marginBottom:8,display:"flex",justifyContent:"center"}}><Icon name="trophy" size={32} style={{color:"var(--color-clay,#b5502f)"}}/></div>
          <h3 style={{margin:"0 0 6px",fontSize:19,fontWeight:700,fontFamily:"'Fraunces',Georgia,serif",color:"var(--color-text-primary)"}}>{challengeScore?t.challengeTitle:t.shareTitle}</h3>
          <p style={{margin:0,fontSize:12.5,color:"var(--color-text-secondary)",lineHeight:1.5}}>{challengeScore?t.challengeDesc.replace("{s}",challengeScore):t.shareDesc}</p>
        </div>
        {err && <div style={{background:"var(--color-background-danger)",border:"0.5px solid #fecaca",color:"var(--color-text-danger)",borderRadius:10,padding:"9px 12px",fontSize:12.5,marginBottom:12}}>{err}</div>}
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

// Posts to the same /api/contact endpoint as the marketing contact form, so a
// user can reach us without leaving the app. Pre-fills the signed-in email and
// attaches lightweight diagnostics (path, language, user agent) to the message.
export function ContactModal({ defaultEmail, onClose, t }) {
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
        body: JSON.stringify({ name: email.trim(), email: email.trim(), message: msg.trim() + ctx, kind: "bug" }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(d.code === "rate_limited" ? t.reportTooMany : (d.error || t.reportError)); setState("error"); return; }
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
            {err && <div style={{background:"var(--color-background-danger)",border:"0.5px solid #fecaca",color:"var(--color-text-danger)",borderRadius:10,padding:"9px 12px",fontSize:12.5,marginBottom:12}}>{err}</div>}
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
