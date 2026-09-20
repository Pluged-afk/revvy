// Settings-panel components extracted from StudyQuiz.jsx: the account / prefs
// screen and its rows, the usage meter, and keybinding editor. Behaviour comes
// in via props; app state via the shared context + lib hooks.
import { useState, useEffect } from "react";
import Icon from "../components/Icon.jsx";
import { Toggle, StreakFlame, AvatarInitial } from "./components.jsx";
import { PRESET_AVATARS } from "../lib/avatars.js";
import { ProModal, PacksModal, ContactModal } from "./modals.jsx";
import { socialApi } from "./api.js";
import { enablePush, disablePush, pushState, pushSupported } from "../lib/push.js";
import { DEFAULT_KEYBINDS, STRIPE_MONTHLY_PRICE, STRIPE_YEARLY_PRICE, QUESTION_PACKS, FREE_DAILY } from "./constants.js";
import { fmtDate } from "./helpers.js";
import { LANGS } from "../i18n.js";
import { useAuth } from "../context/AuthContext.jsx";
import { useClerk } from "@clerk/clerk-react";
import { useSRS } from "../lib/srs.js";
import { useStudyStats } from "../lib/stats.js";

export function Seg({ options, value, onChange }) {
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

// Pretty-print a stored key for the UI (Space, Enter, arrows, upper-cased letters).
const keyLabel = (v) => v === " " ? "Space" : v === "ArrowRight" ? "→" : v === "ArrowLeft" ? "←" : v === "ArrowUp" ? "↑" : v === "ArrowDown" ? "↓" : (v || "").length === 1 ? v.toUpperCase() : (v || "?");

// Rebindable keyboard-controls editor. Tap an action, press any key to bind it.
function KeyBindings({ bindings, onChange, t }) {
  const [listening, setListening] = useState(null);
  useEffect(() => {
    if (!listening) return;
    const onKey = (e) => {
      e.preventDefault(); e.stopPropagation();
      if (e.key !== "Escape") onChange({ ...DEFAULT_KEYBINDS, ...bindings, [listening]: e.key });
      setListening(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [listening, bindings, onChange]);
  const b = { ...DEFAULT_KEYBINDS, ...(bindings || {}) };
  const rows = [
    ["o1", (t.kbOpt || "Answer {n}").replace("{n}", 1)],
    ["o2", (t.kbOpt || "Answer {n}").replace("{n}", 2)],
    ["o3", (t.kbOpt || "Answer {n}").replace("{n}", 3)],
    ["o4", (t.kbOpt || "Answer {n}").replace("{n}", 4)],
    ["next", t.kbNext || "Next / submit"],
  ];
  const cap = (active) => ({ minWidth: 58, padding: "6px 10px", borderRadius: 8, border: "1px solid " + (active ? "var(--color-accent)" : "var(--color-border-secondary)"), background: active ? "var(--color-sel-tint)" : "var(--color-background-secondary)", color: active ? "var(--color-accent)" : "var(--color-text-primary)", fontSize: 12.5, fontWeight: 700, fontFamily: "inherit", cursor: "pointer", fontVariant: "small-caps" });
  return (
    <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
      {rows.map(([k, label]) => (
        <div key={k} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <span style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>{label}</span>
          <button onClick={() => setListening(k)} style={cap(listening === k)}>{listening === k ? (t.kbPress || "press a key…") : keyLabel(b[k])}</button>
        </div>
      ))}
      <button onClick={() => onChange({ ...DEFAULT_KEYBINDS })} style={{ alignSelf: "flex-start", background: "none", border: "none", color: "var(--color-accent)", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", padding: "2px 0" }}>{t.kbReset || "Reset to defaults"}</button>
    </div>
  );
}

export function SettingsPanel({ draft, update, onApply, onCancel, onSignOut, onDeleteAccount, requiresPassword, onReauthenticate, isPro, onManageSubscription, signedIn = true, onOpenBadges = () => {}, onOpenStreak = null, onOpenAccuracy = null, onOpenReview = null, t }) {
  const s = t.set || {};
  const { user, username, saveUsername, avatar, setAvatarPreset, subPlan, periodEnd, cancelAtPeriodEnd, openPortal, startCheckout, refreshProfile, usage, refreshUsage, watchAd, buyPack } = useAuth();
  // Settings split into Account (avatar / name / plan / danger) and Preferences.
  const [acctTab, setAcctTab] = useState("account");
  // Public display name editor (the account name shown everywhere).
  const [nameInput, setNameInput] = useState(username || "");
  const [nameBusy, setNameBusy] = useState(false);
  const [nameErr, setNameErr] = useState("");
  const [nameSaved, setNameSaved] = useState(false);
  useEffect(() => { setNameInput(username || ""); }, [username]);
  const saveName = async () => {
    const v = nameInput.trim();
    if (nameBusy || v === (username || "")) return;
    setNameBusy(true); setNameErr(""); setNameSaved(false);
    const r = await saveUsername?.(v);
    setNameBusy(false);
    if (r && r.ok) { setNameSaved(true); setTimeout(() => setNameSaved(false), 2200); }
    else setNameErr((r && r.error) || (t.unameErr || "Could not save that name."));
  };
  const joinedLabel = (() => {
    try { if (!user?.createdAt) return null; return new Date(user.createdAt).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }); } catch { return null; }
  })();
  // Language is edited on the draft (like every other setting) and applied on Save.
  const acctSrs = useSRS();                 // review-deck stats for the header
  const acctStats = useStudyStats();        // streak + accuracy
  const clerk = useClerk();                 // "manage login & security"
  // Closed-app study reminders (Web Push). State mirrors the live browser
  // subscription; the toggle subscribes/unsubscribes and registers with the
  // server. The whole row is hidden when the browser or this deploy can't push.
  const pushOk = pushSupported();
  const [pushOn, setPushOn] = useState(false);
  const [pushBlocked, setPushBlocked] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushTested, setPushTested] = useState(false);
  useEffect(() => {
    if (!pushOk) return;
    let alive = true;
    pushState().then((st) => { if (alive) { setPushOn(st.subscribed); setPushBlocked(st.blocked); } });
    return () => { alive = false; };
  }, [pushOk]);
  const togglePush = async (v) => {
    if (pushBusy) return;
    setPushBusy(true);
    const r = v ? await enablePush(socialApi) : await disablePush(socialApi);
    if (v) { setPushOn(!!r.ok); if (r.reason === "blocked") setPushBlocked(true); }
    else { setPushOn(false); setPushTested(false); }
    setPushBusy(false);
  };
  const rivalOn = acctSrs.notif?.rival !== false;
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
    volume:70,notifSound:true,haptics:false,feedback:'immediate',autoAdvance:false,autoAdvanceSec:5,defaultDiff:1,defaultQCount:10,keyboardOn:true,shareArena:false,keyBindings:DEFAULT_KEYBINDS};
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
              <span style={{borderRadius:"50%",flexShrink:0,display:"inline-flex",...(isPro?{boxShadow:"0 0 0 2px #fbbf24, 0 0 0 4px rgba(251,191,36,0.35)"}:{})}}>
                <AvatarInitial name={username||user.email} avatar={avatar} size={40}/>
              </span>
              <div style={{minWidth:0}}>
                <div style={{fontSize:13.5,fontWeight:700,color:"var(--color-text-primary)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:170}}>{username||user.email||"Your account"}</div>
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
                { v: <span style={{display:"inline-flex",alignItems:"center",justifyContent:"center"}}><StreakFlame count={acctStats.streak} size={17} showZero/></span>, l: t.dayStreak, onClick: onOpenStreak },
                { v: acctStats.accuracy != null ? `${acctStats.accuracy}%` : "0%", l: t.accuracyLbl, onClick: onOpenAccuracy },
                { v: acctSrs.totalCount, l: t.inReviewLbl, onClick: onOpenReview },
              ].map(({ v, l, onClick }, i) => (
                <div key={i} onClick={onClick || undefined} role={onClick ? "button" : undefined} tabIndex={onClick ? 0 : undefined}
                  onKeyDown={onClick ? (e)=>{ if(e.key==="Enter"||e.key===" "){ e.preventDefault(); onClick(); } } : undefined}
                  style={{flex:1,background:"var(--color-background-secondary)",borderRadius:12,padding:"12px 4px",textAlign:"center",border:onClick?"0.5px solid var(--color-accent)":"0.5px solid var(--color-border-tertiary)",cursor:onClick?"pointer":"default"}}>
                  <div style={{fontSize:15.5,fontWeight:800,color:"var(--color-text-primary)"}}>{v}</div>
                  <div style={{fontSize:10,color:"var(--color-text-secondary)",marginTop:3}}>{l}</div>
                </div>
              ))}
            </div>
            {acctSrs.dueCount > 0 && <div style={{fontSize:11.5,color:"var(--color-accent)",fontWeight:600,marginTop:9,display:"flex",alignItems:"center",justifyContent:"center",gap:4}}><Icon name="repeat" size={13}/>{acctSrs.dueCount} card{acctSrs.dueCount>1?"s":""} due for review today</div>}
          </div>

          {/* Account | Preferences tabs (signed-in only; signed-out sees one list). */}
          {signedIn && user && (
            <div style={{padding:"8px 18px 2px",display:"flex",gap:8}}>
              {[["account",t.setTabAccount||"Account"],["prefs",t.setTabPrefs||"Preferences"]].map(([k,label])=>(
                <button key={k} type="button" onClick={()=>setAcctTab(k)}
                  style={{flex:1,padding:"9px 8px",borderRadius:10,border:"1px solid "+(acctTab===k?"var(--color-accent)":"var(--color-border-secondary)"),background:acctTab===k?"var(--color-sel-tint)":"transparent",color:acctTab===k?"var(--color-accent)":"var(--color-text-secondary)",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>{label}</button>
              ))}
            </div>
          )}

          {signedIn && user && acctTab==="account" && (<>
            <SectionLabel label={s.secAccount||"ACCOUNT"}/>
            <div style={{padding:"4px 18px 8px"}}>
              {/* Avatar picker: choose one of the built-in avatars (no uploads). */}
              <div style={{fontSize:13,fontWeight:600,color:"var(--color-text-primary)",marginBottom:8}}>{t.pfpTitle||"Avatar"}</div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(6, 1fr)",gap:8,marginBottom:16}}>
                {/* Letter avatar (the default) */}
                <button type="button" onClick={()=>setAvatarPreset?.(null)} title={t.pfpLetter||"Letter"} aria-label={t.pfpLetter||"Letter"}
                  style={{display:"inline-flex",alignItems:"center",justifyContent:"center",padding:3,borderRadius:"50%",border:"2px solid "+(!avatar?"var(--color-accent)":"transparent"),background:"none",cursor:"pointer"}}>
                  <AvatarInitial name={username||user.email} size={38}/>
                </button>
                {PRESET_AVATARS.map(a=>(
                  <button key={a.id} type="button" onClick={()=>setAvatarPreset?.(a.id)} title={a.id} aria-label={a.id}
                    style={{display:"inline-flex",alignItems:"center",justifyContent:"center",padding:3,borderRadius:"50%",border:"2px solid "+(avatar===a.id?"var(--color-accent)":"transparent"),background:"none",cursor:"pointer"}}>
                    <AvatarInitial name="" avatar={a.id} size={38}/>
                  </button>
                ))}
              </div>
              {/* Display name (the public account name shown everywhere) */}
              <div style={{fontSize:13,fontWeight:600,color:"var(--color-text-primary)",marginBottom:6}}>{t.displayNameLabel||"Display name"}</div>
              <div style={{display:"flex",gap:8}}>
                <input value={nameInput} maxLength={20} onChange={e=>{setNameInput(e.target.value);setNameErr("");setNameSaved(false);}} placeholder={(user.email||"").split("@")[0]||"username"}
                  style={{flex:1,minWidth:0,borderRadius:10,border:"1px solid "+(nameErr?"#ef4444":"var(--color-border-secondary)"),background:"var(--color-background-primary)",color:"var(--color-text-primary)",fontSize:14,padding:"10px 12px",fontFamily:"inherit",outline:"none",boxSizing:"border-box"}}/>
                <button onClick={saveName} disabled={nameBusy||!nameInput.trim()||nameInput.trim()===(username||"")}
                  style={{flexShrink:0,background:"#4338ca",color:"#fff",border:"none",borderRadius:10,padding:"0 16px",fontSize:13,fontWeight:700,cursor:(nameBusy||!nameInput.trim()||nameInput.trim()===(username||""))?"default":"pointer",fontFamily:"inherit",opacity:(nameBusy||!nameInput.trim()||nameInput.trim()===(username||""))?0.45:1}}>
                  {nameBusy?"…":nameSaved?"✓":(t.saveWord||"Save")}
                </button>
              </div>
              <div style={{fontSize:11,color:nameErr?"#ef4444":"var(--color-text-tertiary)",marginTop:5,lineHeight:1.4}}>{nameErr||(t.displayNameHint||"3-20 letters, numbers or underscore. Shown on your profile, the leaderboard and shared quizzes.")}</div>
              {/* Email + member since */}
              <div style={{marginTop:12,borderRadius:12,border:"0.5px solid var(--color-border-tertiary)",overflow:"hidden"}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:10,padding:"10px 13px",borderBottom:"0.5px solid var(--color-border-tertiary)"}}>
                  <span style={{fontSize:12,color:"var(--color-text-secondary)"}}>{t.emailLabel||"Email"}</span>
                  <span style={{fontSize:12.5,color:"var(--color-text-primary)",fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:180}}>{user.email||"—"}</span>
                </div>
                {joinedLabel && (
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:10,padding:"10px 13px"}}>
                    <span style={{fontSize:12,color:"var(--color-text-secondary)"}}>{t.memberSinceLabel||"Member since"}</span>
                    <span style={{fontSize:12.5,color:"var(--color-text-primary)",fontWeight:600}}>{joinedLabel}</span>
                  </div>
                )}
              </div>
              {/* Badges & rank shortcut */}
              <button onClick={()=>onOpenBadges()} style={{marginTop:12,width:"100%",display:"flex",justifyContent:"space-between",alignItems:"center",gap:10,padding:"11px 13px",borderRadius:12,border:"0.5px solid var(--color-border-tertiary)",background:"var(--color-background-primary)",cursor:"pointer",fontFamily:"inherit"}}>
                <span style={{fontSize:12.5,color:"var(--color-text-primary)",fontWeight:600,display:"inline-flex",alignItems:"center",gap:7}}><span aria-hidden="true">🏅</span>{t.badgesTitle||"Badges & rank"}</span>
                <span style={{fontSize:16,color:"var(--color-text-tertiary)"}}>›</span>
              </button>
            </div>
            <UsageSection isPro={isPro} usage={usage} s={s} adBusy={adBusy} onWatchAd={onWatchAd} onBuyPack={onBuyPack} packBusy={packBusy} startCheckout={startCheckout} onOpenPacks={()=>setShowPacks(true)}/>
            <SectionLabel label={s.secSubscription}/>
            <div style={{margin:"4px 18px 6px",padding:"14px 16px",borderRadius:12,
              border:isPro?"1px solid var(--color-border-success)":"0.5px solid var(--color-border-tertiary)",
              background:isPro?"var(--color-background-success)":"var(--color-background-secondary)"}}>
              {isPro ? (
                <>
                  <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:8,marginBottom:8}}>
                    <span style={{fontSize:15,fontWeight:700,color:"var(--color-text-primary)",display:"inline-flex",alignItems:"center",gap:6}}><Icon name="spark" size={15} style={{color:"var(--color-accent)"}}/>Revyy Pro</span>
                    <span style={{fontSize:10,fontWeight:700,background:"#dcfce7",color:"var(--color-text-success)",border:"0.5px solid var(--color-border-success)",borderRadius:8,padding:"3px 9px"}}>{s.proActive}</span>
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
                  {portalErr && <div style={{marginTop:8,background:"var(--color-background-danger)",border:"1px solid #fecaca",color:"var(--color-text-danger)",borderRadius:10,padding:"8px 11px",fontSize:12,lineHeight:1.4}}>{portalErr}</div>}
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
            <SectionLabel label={s.secSecurity||"LOGIN & SECURITY"}/>
            <div style={{padding:"4px 18px 6px",display:"flex",flexDirection:"column",gap:9}}>
              <button onClick={()=>{ try { clerk.openUserProfile(); } catch { /* Clerk not ready */ } }}
                style={{width:"100%",background:"var(--color-background-secondary)",border:"1px solid var(--color-border-secondary)",borderRadius:12,padding:"11px",fontSize:13,fontWeight:600,color:"var(--color-text-primary)",cursor:"pointer",fontFamily:"inherit"}}>
                <span style={{display:"inline-flex",alignItems:"center",gap:8,justifyContent:"center"}}><Icon name="lock" size={15}/>Manage login &amp; security</span>
              </button>
              <button onClick={onSignOut}
                style={{width:"100%",background:"var(--color-background-secondary)",border:"1px solid var(--color-border-secondary)",borderRadius:12,padding:"11px",fontSize:13,fontWeight:600,color:"var(--color-text-primary)",cursor:"pointer",fontFamily:"inherit"}}>
                ↩ {s.signOut}
              </button>
            </div>
          </>)}

          {(acctTab==="prefs" || !signedIn) && (<>
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
          <SettingRow label={s.notifSounds||"Notification sounds"} desc={!draft.sound?(s.volumeNeedSound||"Turn on sound effects first."):(s.notifSoundsDesc||"Play a chime for friend requests, messages and challenges.")} last>
            <Toggle on={draft.notifSound!==false} onChange={v=>update("notifSound",v)}/>
          </SettingRow>

          <SectionLabel label={s.secNotifications||"Notifications"}/>
          {pushOk && <SettingRow label={s.studyReminders||"Study reminders"} desc={pushBlocked?(s.studyRemindersBlocked||"Notifications are blocked in your browser. Allow them for revyy.app to turn this on."):(s.studyRemindersDesc||"A gentle daily nudge when reviews are due, even with the app closed.")}>
            <Toggle on={pushOn} onChange={togglePush} disabled={pushBusy||pushBlocked}/>
          </SettingRow>}
          {pushOk && pushOn && <div style={{margin:"-2px 0 12px",paddingLeft:2}}>
            <button onClick={async()=>{ if(pushTested)return; setPushTested(true); await socialApi("pushTest"); }} style={{background:"none",border:"none",padding:0,color:"var(--color-accent)",fontSize:12.5,fontWeight:600,cursor:pushTested?"default":"pointer",fontFamily:"inherit",opacity:pushTested?0.6:1}}>{pushTested?(s.reminderSent||"Test sent, check your notifications."):(s.sendTestReminder||"Send a test reminder")}</button>
          </div>}
          <SettingRow label={s.friendOvertakes||"Friend overtakes"} desc={s.friendOvertakesDesc||"A pop-up when a friend passes your XP, so you can climb back."} last>
            <Toggle on={rivalOn} onChange={v=>acctSrs.setNotifPref("rival",v)}/>
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
          <SettingRow label={s.keyboard||"Keyboard controls"} desc={s.keyboardDesc||"Answer with your keyboard on a computer. Tap a key below to rebind it."}>
            <Toggle on={draft.keyboardOn!==false} onChange={v=>update("keyboardOn",v)}/>
          </SettingRow>
          {draft.keyboardOn!==false && (
            <div style={{padding:"0 2px 6px"}}>
              <KeyBindings bindings={draft.keyBindings} onChange={b=>update("keyBindings",b)} t={t}/>
            </div>
          )}
          <SettingRow label={s.shareArena||"Share my questions to the Arena"} desc={s.shareArenaDesc||"Off by default. Opt in to contribute the good questions from your quizzes to the public Endless Arena for everyone to play. Only clear, self-contained questions are shared, never anything specific to your own notes or material."}>
            <Toggle on={draft.shareArena===true} onChange={v=>update("shareArena",v)}/>
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

          <SectionLabel label={s.secHelp}/>
          <button onClick={()=>setShowContact(true)}
            style={{margin:"4px 18px 8px",width:"calc(100% - 36px)",display:"flex",alignItems:"center",justifyContent:"space-between",
              background:"var(--color-background-secondary)",border:"0.5px solid var(--color-border-tertiary)",borderRadius:12,padding:"13px 16px",
              fontSize:13.5,fontWeight:600,color:"var(--color-text-primary)",cursor:"pointer",fontFamily:"inherit"}}>
            <span style={{display:"inline-flex",alignItems:"center",gap:8}}><Icon name="chat" size={16}/>{s.reportBug}</span><span style={{color:"var(--color-text-tertiary)",fontSize:18}}>›</span>
          </button>
          </>)}

          {signedIn ? (acctTab==="account" && (<>
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
          </>)) : (
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
            {delErr && <div style={{background:"var(--color-background-danger)",border:"1px solid #fecaca",color:"var(--color-text-danger)",borderRadius:10,padding:"9px 12px",fontSize:12.5,lineHeight:1.4,marginBottom:14,textAlign:"left"}}>{delErr}</div>}
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
