import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { LANGS } from "./i18n.js";
import { useAuth } from "./context/AuthContext.jsx";
import { useLang } from "./context/LanguageContext.jsx";
import { useDev, DevBadge } from "./context/DevContext.jsx";
import { useNavigate } from "react-router-dom";
import { upload as blobUpload } from "@vercel/blob/client";
import { useAdUnlocks } from "./lib/adUnlocks.js";
import { useSRS, toCard } from "./lib/srs.js";
import { useStudyStats } from "./lib/stats.js";
import { usePlans } from "./context/StudyContext.jsx";
import { buildPlan, parseChapters, planProgress, nextDayIndex, isPlanComplete, dayState } from "./lib/planner.js";
import { computeReadiness, weakTopics, topicMastery } from "./lib/insights.js";
import { recommendDifficulty, buildLearnerBrief, resultNudge, recommendDailyGoal } from "./lib/studentModel.js";
import { detectOvertakes } from "./lib/overtake.js";
import { DEMO_QUIZ } from "./data/demoQuiz.js";
import { makeBankItem, bankPick, buildAvoidNote } from "./lib/questionBank.js";
import { makeLibraryDoc, buildLibraryMaterial, librarySize, libraryTopics } from "./lib/studyLibrary.js";
import { previewInterval } from "./lib/fsrs.js";
import { LETTERS, DEFAULT_KEYBINDS, LEAGUE_TIERS, AI_MODEL, DIFFICULTY, ADS_ENABLED, STARTER_EXAMS, STARTER_SUBJECTS, STRIPE_MONTHLY_PRICE, STRIPE_YEARLY_PRICE } from "./studyquiz/constants.js";
import { Sb, CSS } from "./studyquiz/styles.js";
import { stripEmoji, computeUnread, activityText, timeAgo, parseQuizlet, sectionPerQMarks, sectionMarksTotal, roundMarks, fmtMB, stripFences, shuffleMCQOptions } from "./studyquiz/helpers.js";
import { AvatarInitial, Medallion, NotifBubble, GroupAvatar, StreakFlame, RankPill, Flair, Logo, PBar, Chip, Segmented, Toggle } from "./studyquiz/components.jsx";
import { Haptics, SoundEngine } from "./studyquiz/audio.js";
import { authHeader, registerToken, callClaude, readStream, deDash, explainAnswer, followupAnswer, regenerateQuestion, verifyFlaggedQuestion, gateContent, gateMessage } from "./studyquiz/ai.js";
import { AutoAdvanceBar, Flashcard, FillBlank, WrittenAnswer, MatchQuiz, SourceMark } from "./studyquiz/quiz.jsx";
import { MOCK_LS_Q, MOCK_LS_P, clearMockResume, readMockProgress, readMockResume, buildMockSection, mockFlagGlobal, arenaDrawGlobal, arenaSubmitGlobal, arenaBoardGlobal, arenaSeasonGlobal, toArenaQ, socialApi, fetchMyChallenges } from "./studyquiz/api.js";
import { UsernameModal, ProModal, PacksModal, UnlockModal, ScoreCardModal, RanksModal, ShareModal, ContactModal } from "./studyquiz/modals.jsx";
import { ExitModal, PauseOverlay, TimeUpModal, ResumeModal, Confetti, RankPromotion, AdBanners, ActivatingOverlay, MockPassagePanel } from "./studyquiz/overlays.jsx";
import { Seg, SettingsPanel } from "./studyquiz/settings.jsx";
import { MOCK_EXAMS, getMock, mockTotalMinutes, mockTotalQuestions, scoreMock } from "./lib/mockExams.js";
import { BADGES, BADGE_BY_ID, evaluateBadges, rankOf, rankFor, studyRankXP, streakTier, STREAK_TIERS, RANKS, diffXPFor, classifyDomain } from "./lib/badges.js";
import { enableNotifications, notify, notifyOncePerDay, ensureSW } from "./lib/notify.js";
import ArenaGame from "./components/ArenaGame.jsx";
import Icon from "./components/Icon.jsx";

// Clean line icons for the home "what you can upload" grid, matched to the
// fixed feature order (PDF, Images, Text, Quiz types, Explanations, Languages)
// so we don't depend on the emoji stored in the translation data.
const FEAT_ICONS = ["notes", "camera", "pencil", "layers", "chat", "globe"];

// Icon per upload tab id (labels come from the translation data with emoji).
const TAB_ICONS = { file: "folder", text: "pencil", photo: "camera", media: "play" };
// Localized name for a power-up ("hint" | "freeze" | "skip"), reusing the arena
// labels so the reward economy speaks one language everywhere.
const pupName = (t, key) => key === "freeze" ? (t.arenaFreeze || "Freeze") : key === "skip" ? (t.arenaSkip || "Skip") : (t.arenaHint || "Hint");
// Arena board entry points (intro + game-over). On now: the board leads with the
// competitive season tier + season leaderboard, which aren't gated (they work
// from day one), so there's always something to show. The all-time board behind
// the toggle is still gated at 100 players server-side.
const SHOW_ARENA_LEADERBOARD = true;

// Audio / video containers we accept for lecture transcription (Pro). Broad on
// purpose; the transcriber pulls the audio out of whatever container it gets.
const MEDIA_MAX_MB = 100;


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
// "diagram" runs on the learner's OWN uploaded image: the vision model marks a
// part on their real diagram and they identify it (no AI-drawn figures).
const QUIZ_TYPES   = ["mcq","cards","fill","match","written","diagram"];
const QT_ICON      = { mcq:"list", cards:"layers", fill:"pencil", match:"link", written:"chat", diagram:"target" };
// Phase 2: how many of a 10-question weak-spot drill may be reused from the
// learner's vetted bank (rest are freshly generated). Caps API cost saving at
// half so drills still feel fresh.
const DRILL_REUSE_MAX = 5;
const LIBRARY_REUSE_MAX = 4; // vetted bank questions reused in a 10-Q "quiz everything" review


// ── Translations ───────────────────────────────────────────────────────
// Strings live in ./i18n.js. `t` is resolved per-render from the `lang`
// state inside StudyQuiz via getTranslations(lang).

// ── Sound engine (Web Audio API) ─────────────────────────────────────
// One-shot celebration guards: each achievement's sound + confetti fires at most
// once per page load, so moving between screens (or a remount) never replays it.
// They reset on a fresh load; cross-session dedup is the persisted badges.seen
// list.
let _celebratedRankIdx = -1;
let _celebratedStreak = -1;
let _celebratedStreakTier = -1;

// LETTERS, DEFAULT_KEYBINDS, LEAGUE_TIERS, THEME_LIGHT and THEME_DARK now live
// in ./studyquiz/constants.js (imported at the top of this file).

function readText(f)   { return new Promise((res,rej)=>{ const r=new FileReader(); r.onload=e=>res(e.target.result); r.onerror=()=>rej(new Error("Read failed")); r.readAsText(f); }); }
function readDataURL(f) { return new Promise((res,rej)=>{ const r=new FileReader(); r.onload=e=>res(e.target.result); r.onerror=()=>rej(new Error("Read failed")); r.readAsDataURL(f); }); }

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
    <button onClick={load} style={{marginTop:9,marginLeft:23,background:"var(--color-sel-tint)",border:"1px solid var(--color-accent)",color:"var(--color-accent)",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit",padding:"6px 12px",borderRadius:20,display:"inline-flex",alignItems:"center",gap:6}}><Icon name="chat" size={13}/>{t.explainWhy}</button>
  );
  return (
    <div style={{marginTop:8,marginLeft:23,background:"var(--color-background-secondary)",border:"0.5px solid var(--color-border-tertiary)",borderRadius:10,padding:"10px 12px"}} className="fade-in">
      {loading && <div style={{fontSize:12.5,color:"var(--color-text-secondary)",display:"inline-flex",alignItems:"center",gap:5}}><Icon name="chat" size={13}/>{t.explainLoading}</div>}
      {err && <div style={{fontSize:12.5,color:"var(--color-text-danger)"}}>{err}</div>}
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

export default function StudyQuiz() {
  const [screen,       setScreen]       = useState("home");
  const { t, lang, setLang } = useLang(); // language control now lives inside the account panel
  const dev = useDev();
  const { isPro, signOut, deleteAccount, reauthenticate, user, startCheckout, openPortal, refreshProfile, getToken, usage, refreshUsage, consumeQuestions, watchAd: watchAdQuestions, buyPack, consumeMock, username, saveUsername, saveLanguage, loading: authLoading } = useAuth();
  // Expose Clerk's getToken to the module-level AI-proxy / upload helpers so
  // every request to /api/anthropic and /api/upload-file carries a bearer token.
  useEffect(() => { registerToken(getToken); return () => { registerToken(null); }; }, [getToken]);
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
  const [quizElim,     setQuizElim]     = useState([]); // MCQ option indices hidden by a spent hint power-up
  // The material blocks the current quiz was built from, kept so "Report a
  // problem" (FlagFix) can regenerate a replacement grounded in the same notes.
  const genBlocksRef = useRef(null);
  const groupQuizRef = useRef(null); // {groupId, title} when the current quiz came from a group's shared material
  const joinHandledRef = useRef(false); // guard so a ?join= invite link is only acted on once
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
  const [scoreCardOpen, setScoreCardOpen] = useState(false); // shareable result image
  const [showRanks, setShowRanks] = useState(false); // the full rank-ladder modal
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
      const qs = await buildMockSection(exam, spec, mockTilt);
      if (!qs.length) throw new Error("section");
      setMock(m => ({ ...m, sections: m.sections.map((s, i) => i === ni ? { ...s, questions: qs } : s) }));
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
    // Universal streak + rewards for a finished mock. Question count (all graded
    // sections) feeds the streak saver; the raw correct fraction (excluding the
    // few point-banded sections like SJT) gates the earned power-up.
    const graded = [...sc.rows, ...sc.extras];
    const rawTotal = graded.reduce((a, r) => a + (Number(r.count) || 0), 0);
    const rawCorrect = graded.filter((r) => !r.band).reduce((a, r) => a + (Number(r.raw) || 0), 0);
    setEarnedReward(srs.completeActivity({ mode: "mock", correct: rawCorrect, total: rawTotal }));
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
      // Store the WHOLE mock (incl scoreMode, goodScore, totals) so a resumed exam
      // scores identically to one taken in one sitting.
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
    const id = setTimeout(()=>{ notify("Revyy · Study Coach", `${t.notifStudyTime||"Time to study"}: ${day.label}`, { tag:"revyy-plan" }); }, delay);
    return ()=>clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [homePlan]);
  // Register the worker up front when reminders are already on, and fire a
  // once-a-day nudge on open: streak about to break, else reviews due. These
  // are local (they fire while the browser has Revyy open); closed-app daily
  // push needs Web Push (VAPID + a backend), which the worker is ready for.
  useEffect(() => {
    if (typeof Notification==="undefined" || Notification.permission!=="granted") return;
    ensureSW();
    const yst = (()=>{ const d=new Date(); d.setDate(d.getDate()-1); return d.toLocaleDateString("en-CA"); })();
    const streakAtRisk = stats.streak>0 && stats.lastActive===yst;
    if (streakAtRisk) {
      notifyOncePerDay("streak", t.notifStreakTitle||"Keep your streak alive", (t.notifStreakBody||"Your {n}-day streak breaks tonight. A quick review keeps it going.").replace("{n}",stats.streak), { tag:"revyy-streak" });
    } else if (srs.dueCount>0) {
      notifyOncePerDay("due", t.notifDueTitle||"Reviews are ready", (t.notifDueBody||"You have {n} question{s} due for review.").replace("{n}",srs.dueCount).replace("{s}",srs.dueCount>1?"s":""), { tag:"revyy-due" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stats.streak, stats.lastActive, srs.dueCount]);

  const [reviewQueue, setReviewQueue] = useState([]); // card ids for this session
  const [reviewPos,   setReviewPos]   = useState(0);
  const [reviewShown, setReviewShown] = useState(false); // answer revealed?
  const [srsAdded,    setSrsAdded]    = useState(0); // "+N added to review" note
  const [earnedReward, setEarnedReward] = useState(null); // power-up earned on this finished quiz/exam (null = none)
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
      srsAddedRef.current = quiz; setSrsAdded(0); setEarnedReward(null);
    } else if (screen === "results" && quiz && srsAddedRef.current !== quiz) {
      srsAddedRef.current = quiz;
      // diagram questions are figure-dependent, so they don't belong in the
      // text-only review deck (a "what is the marked part?" card has no figure).
      const missed = quiz.type === "diagram" ? [] : quiz.questions.filter((_, i) => answers[i] && answers[i].isCorrect === false).map(toCard);
      setSrsAdded(missed.length ? srs.addMissed(missed) : 0);
      // Universal streak + rewards: passing earns a power-up, and the questions
      // count toward the next (silent) streak saver. Supersedes recordSession.
      setEarnedReward(srs.completeActivity({ mode: "quiz", correct: answers.filter((a) => a && a.isCorrect).length, total: answers.length }));
      // Badge signals + adaptive XP: a perfect run, a passed Hard set, and each
      // correct answer's difficulty premium (harder sets earn more XP) feed the
      // trophy case + rank.
      { const c = answers.filter((a) => a && a.isCorrect).length, n = answers.length, gd = quiz.genDiff ?? diff;
        const dom = classifyDomain(`${quiz.subject || ""} ${quiz.title || ""} ${quiz.questions.map((q) => q.topic).join(" ")}`);
        srs.syncBadges({ perfect: n >= 4 && c === n, hardPass: gd === 2 && n > 0 && c / n >= 0.6, diffXP: diffXPFor(c, gd), subjectDomain: dom, subjectAdd: n }); }
      // If this quiz came from a group's shared material, post the result to the
      // group's activity feed (best-effort), then clear the marker.
      if (groupQuizRef.current) {
        const gq = groupQuizRef.current; groupQuizRef.current = null;
        const c = answers.filter((a) => a && a.isCorrect).length;
        socialApi("groupLog", { groupId: gq.groupId, kind: "quiz", detail: `${c}/${answers.length} · ${gq.title}`, points: c });
      }
      // A head-to-head challenge: submit this run's score (play-once, server-
      // deduped), feed it into the adaptive engine, and record the win/loss so a
      // strong record nudges this learner toward harder questions over time.
      if (challengeRef.current) {
        const cr = challengeRef.current; challengeRef.current = null;
        const c = answers.filter((a) => a && a.isCorrect).length, n = answers.length;
        // Challenge sets are fixed (fresh:false) so they skip the perf log below;
        // log them here so competing still teaches the model about the learner.
        srs.recordPerf({ type: "challenge", diff: quiz.genDiff ?? diff, total: n, correct: c });
        (async () => {
          const r = await socialApi("challengeSubmit", { challengeId: cr.challengeId, team: cr.team, score: c, total: n });
          if (r && r.ok && !r.pending) srs.recordChallengeResult(!!r.won);
        })();
      }
      // A friend challenge: record this run's score against the challenge
      // (play-once, server-deduped) so both friends' scores can be compared and
      // a winner shown once both have played.
      if (dmChallengeRef.current) {
        const dc = dmChallengeRef.current; dmChallengeRef.current = null;
        const c = answers.filter((a) => a && a.isCorrect).length, n = answers.length;
        if (dc.challengeId) socialApi("dmChallengeSubmit", { challengeId: dc.challengeId, score: c, total: n });
      }
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
      // Opt-in only: share the well-formed MCQs from this quiz to the community
      // Arena pool. The server vets each one (self-contained, non-abusive) and
      // keeps the good ones; nothing personal or material-specific gets through.
      if (quiz.type === "mcq" && settings.shareArena && !quiz.sample) {
        const contrib = quiz.questions
          .filter((q) => Array.isArray(q.options) && q.options.length >= 4 && Number.isInteger(q.correct) && q.correct >= 0 && q.correct < q.options.length)
          .map((q) => ({ question: q.question, options: q.options, correct: q.correct, diff: quiz.genDiff ?? diff, subject: quiz.subject || "" }));
        if (contrib.length) socialApi("arenaContribute", { items: contrib });
      }
    } else if (screen === "exam_results" && examEvals && srsAddedRef.current !== examEvals) {
      srsAddedRef.current = examEvals;
      const missed = examQs.filter((_, i) => (examEvals[i]?.score ?? 0) < 1).map(toCard);
      setSrsAdded(missed.length ? srs.addMissed(missed) : 0);
      setEarnedReward(srs.completeActivity({ mode: "exam", correct: examEvals.filter((e) => (e?.score ?? 0) >= 1).length, total: examEvals.length }));
      { const c = examEvals.filter((e) => (e?.score ?? 0) >= 1).length, n = examEvals.length;
        const dom = classifyDomain(`${quiz?.subject || ""} ${examQs.map((q) => q.topic).join(" ")}`);
        srs.syncBadges({ perfect: n >= 4 && c === n, hardPass: diff === 2 && n > 0 && c / n >= 0.6, diffXP: diffXPFor(c, diff), subjectDomain: dom, subjectAdd: n }); }
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
    notifSound:true,
    haptics:false,
    feedback:'immediate',
    autoAdvance:false,
    autoAdvanceSec:5,
    defaultDiff:1,
    defaultQCount:10,
    nickname:'',
    keyboardOn:true,
    shareArena:false,
    keyBindings:DEFAULT_KEYBINDS,
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
      } catch { /* ignore */ }
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

  // Theme, font scale and reduced-motion are applied to the WHOLE document by
  // AppearanceApplier (src/lib/appearance.js) so they hold on the marketing site
  // too, not just here. applySettings dispatches "revyy-appearance" to re-apply
  // the moment a setting changes.

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

  // ── Feature access (free users unlock via 1-hour ad windows) ─────────
  const QTYPE_FEATURE = { cards:"flashcard", fill:"fillinblank", match:"matchterms" };
  // written (short answer) + diagram are Pro-only: they spend extra tokens (AI
  // grading / figure generation), so there's no ad-unlock. Others = Pro OR ad-unlock.
  const canUseQType = useCallback((type) => type==="mcq" || ((type==="written"||type==="diagram") ? isPro : (isPro || unlocks.isUnlocked(QTYPE_FEATURE[type]))), [isPro, unlocks]);
  const canCustomQ  = useCallback(() => isPro, [isPro]);
  // Max questions per quiz: 100 (Pro) / 50 (ad-unlocked) / 20 (free).
  const qCap        = useCallback(() => isPro ? PRO_MAX_Q : (unlocks.isUnlocked("questions") ? AD_MAX_Q : FREE_MAX_Q), [isPro, unlocks]);
  // File size: 999 (Pro) / 10 (ad-unlocked) / 5 (free) MB.
  const fileLimitMB = useCallback(() => isPro ? PRO_FILE_MB : (unlocks.isUnlocked("filesize") ? AD_FILE_MB : FREE_FILE_MB), [isPro, unlocks]);

  // The most questions the user can actually make right now = their tier cap AND
  // whatever daily allowance is left (packs included). Sliders/inputs never move
  // past this, so a user with 30 left can't set 100 and then fail at generation.
  // Unknown usage (still loading) does not cap. Universal across quiz + exam.
  const remainingToday = useCallback(() => {
    const r = usage?.remaining;
    return (typeof r === "number" && r >= 0) ? r : Infinity;
  }, [usage]);
  const qMax   = useCallback(() => Math.max(1, Math.min(qCap(), remainingToday())), [qCap, remainingToday]);
  const examCap = useCallback(() => Math.max(1, Math.min(isPro ? 100 : 20, remainingToday())), [isPro, remainingToday]);

  const effectiveNumQ = useCallback(()=>{
    // Custom box value takes precedence when on; otherwise the slider's numQ.
    let n = numQ;
    if (useCustomQ && canCustomQ()) { const c=parseInt(customQ,10); if(!isNaN(c)) n=c; }
    return Math.min(Math.max(n,1), qMax());
  },[useCustomQ,canCustomQ,numQ,customQ,qMax]);

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
    setExamSections(p=> p.length<5 ? [...p,{id:Date.now(),type:'mcq',count:'5',marksPerQ:'1',markMode:'perQ',sectionMarks:'20'}] : p);
  },[]);
  const removeSection = useCallback(id => setExamSections(p=>p.filter(s=>s.id!==id)),[]);
  const updateSection = useCallback((id,field,val) =>
    setExamSections(p=>p.map(s=>s.id===id?{...s,[field]:val}:s))
  ,[]);
  const sectionTotalMarks = examSections.reduce((s,sec)=>s+sectionMarksTotal(sec),0);
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
      setQIdx(0); setAnswers([]); setSelected(null); setQuizElim([]);
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
    // Cap the exam at what the user can actually make now: 100/exam (Pro) or their
    // free limit, AND never more than their remaining daily allowance.
    const totalQ = Math.min(examMode==="custom" ? sectionTotalQs : (isPro ? Math.max(parseInt(examTotalQ)||5,1) : 20), examCap());

    // Personalize the exam to this learner (weak-topic emphasis + calibration)
    // and fold in the content feedback loop's "avoid these" list, same as the
    // quiz flow. Empty for newcomers.
    const learnerBrief = [buildLearnerBrief(studyModel), buildAvoidNote(srs.bank)].filter(Boolean).join("\n\n");
    // What to generate: one unit per custom-exam section, else a single block of
    // the chosen type. Each unit is produced in CHUNKS below (a single model call
    // reliably returns only ~25-30 questions no matter the count asked), so a big
    // exam actually reaches its full number instead of stalling at ~25.
    const examPlan = examMode==="custom"
      ? examSections.map((s,i)=>({ section:i+1, type:(["mcq","fill","written"].includes(s.type)?s.type:"mcq"), marks:sectionPerQMarks(s), count:Math.min(Math.max(parseInt(s.count)||5,1),100) }))
      : [{ section:1, type:(examMode==="written"?"written":"mcq"), marks:1, count: totalQ }];
    const examMarksMap = {}; examPlan.forEach((s)=>{ examMarksMap[s.section]=s.marks; });

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
      // Generate one CHUNK (<=25) of a section. Its own prompt is focused on a
      // single type + count, which the model satisfies far more reliably than a
      // giant "give me 100" ask.
      const EXAM_CHUNK = 25;
      const examChunk = async (n, type, section, avoid, withSummary) => {
        const typeDesc = type==="mcq"
          ? `EXACTLY ${n} multiple-choice questions, each with EXACTLY 4 options and "correct" set to the 0-based index of the one right option`
          : type==="fill"
          ? `EXACTLY ${n} fill-in-the-blank questions; every "question" MUST contain a blank written as ___ and "answer" is the exact missing word or phrase; set options to []`
          : `EXACTLY ${n} open-ended written questions, each with a concise model answer in "answer"; set options to []`;
        const prompt = `You are creating a real graded exam from the study material above.\nGenerate ${typeDesc}, not ${n-1}, not ${n+1}, EXACTLY ${n}. The "questions" array MUST contain exactly ${n} items; do not stop early, produce all ${n}, then count them before responding.\nSet "section":${section} and "type":"${type}" on EVERY question.\nDIFFICULTY: ${dg.name}. ${dg.guide} Calibrate every question to this ${dg.name} level.\nLANGUAGE: Write the ENTIRE exam in the SAME language as the study material; do NOT translate it into English.${LANGS[lang]?.name?` If the material is too short to tell its language, use ${LANGS[lang].name}.`:""}${learnerBrief?`\n${learnerBrief}`:""}${avoid}\nReturn ONLY raw JSON (no markdown): {"title":"Exam title","questions":[{"section":${section},"type":"${type}","question":"...","options":[${type==="mcq"?'"A","B","C","D"':""}],"correct":0,"answer":"...","explanation":"...","topic":"2-4 word sub-topic"}]${withSummary?`,"summary":"a compact digest of this material for the study library"`:""}}\nSet "topic" to the specific concept each question tests. The "questions" array length MUST equal ${n}.${withSummary?`\nALSO add a top-level "summary" (max 120 words) of the key concepts, in the same language as the material.`:""}`;
        const cmax = Math.min(Math.max(n*280+2500, 4000), 24000);
        const res=await fetch("/api/anthropic",{method:"POST",headers:{"Content-Type":"application/json", ...(await authHeader())},
          body:JSON.stringify({model:AI_MODEL,max_tokens:cmax,
            system:"You are an expert exam setter. Return ONLY valid raw JSON, no markdown.",
            messages:[{role:"user",content:[...blocks,{type:"text",text:prompt}]}]})});
        if(!res.ok){const e=await res.json().catch(()=>({}));throw new Error(e.error?.message||"Error "+res.status);}
        const raw = stripFences(await readStream(res));
        let p;
        try { p = JSON.parse(raw); }
        catch { const cut = raw.lastIndexOf("}"); if (cut < 0) throw new Error("parse"); p = JSON.parse(raw.slice(0, cut + 1) + "]}"); }
        return p;
      };
      // Build every section to its full count by chunking + de-duping, so a big
      // exam (e.g. 100 questions) actually produces 100.
      const seenEx = new Set();
      const examAll = [];
      let exTitle = "", exSummary = "", exLastErr = null;
      let budget = totalQ; // hard cap on the whole exam (100/exam + remaining daily allowance)
      for (const secSpec of examPlan) {
        const secTarget = Math.min(secSpec.count, budget);
        if (secTarget <= 0) break;
        let got = 0, emptyRounds = 0, calls = 0;
        const secMax = Math.ceil(secTarget / EXAM_CHUNK) + 3;
        while (got < secTarget && calls < secMax && emptyRounds < 2) {
          calls++;
          const need = Math.min(EXAM_CHUNK, secTarget - got);
          const written = examAll.filter((q) => q.section === secSpec.section).slice(-30);
          const avoid = written.length ? `\nDo NOT repeat or lightly reword any of these questions already written:\n- ${written.map((q) => String(q.question || "").slice(0, 120)).join("\n- ")}` : "";
          let r = null;
          try { r = await examChunk(need, secSpec.type, secSpec.section, avoid, !exSummary); } catch (e) { exLastErr = e; }
          let added = 0;
          if (r?.questions?.length) {
            if (!exTitle && r.title) exTitle = r.title;
            if (!exSummary && r.summary) exSummary = r.summary;
            for (const q of r.questions) {
              const key = String(q?.question || "").trim().toLowerCase();
              if (!key || seenEx.has(key)) continue;
              seenEx.add(key);
              examAll.push({ ...q, section: secSpec.section, type: secSpec.type });
              added++; got++;
              if (got >= secTarget) break;
            }
          }
          emptyRounds = added === 0 ? emptyRounds + 1 : 0;
        }
        budget -= got;
      }
      if (!examAll.length) throw (exLastErr || new Error("No questions generated"));
      const parsed = { title: deDash(exTitle), questions: examAll, summary: deDash(exSummary) };
      const marksMap = examMarksMap;
      if(!parsed.questions?.length) throw new Error("No questions generated");
      // Phase 3: remember a summary of this exam's material for the study library
      // (never the material itself), same as the quiz flow.
      const exTopics = [...new Set(parsed.questions.map(q=>q.topic).filter(Boolean))];
      const exDoc = makeLibraryDoc({ title: parsed.title, subject: "", topics: exTopics, summary: parsed.summary, n: parsed.questions.length });
      if (exDoc) srs.addLibraryDoc(exDoc);
      const annotated = parsed.questions.map(q=>shuffleMCQOptions({
        ...q,
        question: deDash(q.question), answer: deDash(q.answer), explanation: deDash(q.explanation),
        topic: deDash(q.topic), options: Array.isArray(q.options) ? q.options.map(deDash) : q.options,
        marksPerQ: examMode==="custom" ? (marksMap[q.section]||1) : 1,
      }));
      setExamQs(annotated);setExamIdx(0);setExamAns({});setExamEvals(null);setShowConfetti(false);
      const tSec = examTimerOn ? Math.min(Math.max(parseInt(examTimerMin)||60,5),180)*60 : 0;
      setExamTotalSec(tSec); setExamTimeLeft(examTimerOn ? tSec : null);
      setExamPaused(false); setExamTimeUp(false); setExamReview(false); setShowSubmitPrompt(false); setExamTimeExpired(false);
      setScreen("exam_run");
      if(!isPro) unlocks.consumeExam();   // free daily exam is now used up
    }catch(err){setError(err.message.includes("parse")?t.errUnexpectedFormat:err.message);setScreen("exam_setup");}
  },[examFiles,examMode,examSections,examTotalQ,diff,sectionTotalQs,examTimerOn,examTimerMin,uploadFileToAnthropic,consumeQuestions,requireLogin,isPro,unlocks,studyModel,srs.bank,examCap]);

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
        return ev?{score:clamp(ev.score),feedback:deDash(ev.feedback||"")}:{score:0,feedback:t.notEvaluated};
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
    // Wipe locally-stored per-user data too, then reset appearance to default.
    try { localStorage.removeItem("revyy_settings"); localStorage.removeItem("sq_v3"); } catch { /* ignore */ }
    window.dispatchEvent(new Event("revyy-appearance"));
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
    if(draftLang && draftLang!==lang) { setLang(draftLang); if(user) saveLanguage(draftLang); }
    window.storage.set("revyy_settings",JSON.stringify(rest)).catch(()=>{});
    // Re-apply theme + font scale across the whole document (marketing + app).
    window.dispatchEvent(new Event("revyy-appearance"));
    setSettingsDraft(null);
    setShowSettings(false);
  };
  const updateDraft = (key,val) => setSettingsDraft(prev=>({...prev,[key]:val}));

  const haptic = (ms=35) => Haptics.buzz(ms);

  const processFile = useCallback(async (f) => {
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

    // Diagram quizzes mark a part on the learner's OWN image, so they need one.
    if (finalType==="diagram" && !((tab==="file"||tab==="photo") && file?.type==="image")) {
      setError(t.diagramNeedsImage || "Diagram quizzes need an image. Upload a diagram or photo, then choose Diagram.");
      return;
    }

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
          // Ask for the material summary until we actually capture one: if the
          // first chunk truncates before it, a later chunk still fills the library
          // (once captured, we stop asking, so the usual cost is one summary).
          r = await callClaude({ blocks, numQ: need, diff, type: finalType, uiLangName: LANGS[lang]?.name, learnerBrief: learnerBrief + avoidSeen, withSummary: !summary });
        } catch (e1) { lastErr = e1; }
        let added = 0;
        if (r?.questions?.length) {
          if (!title && r.title) title = r.title;
          if (!subject && r.subject) subject = r.subject;
          if (!summary && r.summary) summary = r.summary;
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
      // Diagram: keep the learner's uploaded image (data URL) to show with the
      // marker on each question.
      let diagramImg = null;
      if (finalType==="diagram" && file?.raw) { try { diagramImg = await readDataURL(file.raw); } catch { /* ignore, questions still work */ } }
      // fresh + genDiff mark this as a first-play, difficulty-calibrated round so
      // the results handler logs it into the adaptive-difficulty perf history.
      setQuiz({...res, type:finalType, fresh:true, genDiff:diff, ...(diagramImg?{diagramImg}:{})});
      setQIdx(0); setAnswers([]); setSelected(null); setQuizElim([]);
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
      setQIdx(0); setAnswers([]); setSelected(null); setQuizElim([]);
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
      // Reuse a few of the learner's OWN vetted questions from across everything
      // they have studied (real spaced review + fewer to generate), then generate
      // the rest as fresh cumulative questions. Empty bank -> all generated, as before.
      const reused = bankPick(srs.bank, libraryTopics(srs.library), LIBRARY_REUSE_MAX);
      const need = n - reused.length;
      const avoidReused = reused.length
        ? `\nDo NOT reuse or lightly reword these exact questions the learner has already practised:\n- ${reused.map((q) => String(q.question || "").slice(0, 120)).join("\n- ")}`
        : "";
      const blocks = [{ type: "text", text: material + avoidReused }];
      const learnerBrief = [buildLearnerBrief(studyModel), buildAvoidNote(srs.bank)].filter(Boolean).join("\n\n");
      let res = null, lastErr = null;
      if (need > 0) {
        for (let attempt = 0; attempt < 3; attempt++) {
          let r = null;
          try { r = await callClaude({ blocks, numQ: need, diff, type: "mcq", uiLangName: LANGS[lang]?.name, learnerBrief }); } catch (e1) { lastErr = e1; }
          if (r?.questions?.length) { if (!res || r.questions.length > res.questions.length) res = r; if (res.questions.length >= need) break; }
        }
        if (!res?.questions?.length && !reused.length) throw (lastErr || new Error("No questions returned"));
      }
      // Mix the reused (internal hash stripped) with the freshly generated ones and
      // shuffle so the banked ones are not all up front.
      const stripHash = (q) => { const c = { ...q }; delete c._bankHash; return c; };
      const merged = [...reused.map(stripHash), ...(res?.questions || [])].sort(() => Math.random() - 0.5).slice(0, n);
      if (!merged.length) throw (lastErr || new Error("No questions returned"));
      genBlocksRef.current = blocks; // keep the summaries for FlagFix regen
      if (reused.length) srs.bankUsed(reused.map((q) => q._bankHash)); // rotate what is served next time
      setQuiz({ title: res?.title || t.libraryReviewTitle, subject: "", questions: merged, type: "mcq", fresh:true, genDiff:diff });
      setQIdx(0); setAnswers([]); setSelected(null); setQuizElim([]);
      setScreen("quiz");
    } catch (err) {
      setError(err.message.includes("parse") ? t.errAiFormat : err.message);
      setScreen("upload");
    }
  }, [requireLogin, srs.library, srs.bank, srs.bankUsed, consumeQuestions, diff, lang, t, isPro, studyModel]);

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
    const upd=[...answers,{isCorrect,...(detail||{})}]; setAnswers(upd); setSelected(null); setQuizElim([]);
    if (qIdx+1>=quiz.questions.length) setScreen("results");
    else setQIdx(i=>i+1);
  };
  const nextMCQ = () => { if(selected===null)return; nextQ(selected===quiz.questions[qIdx].correct,{selected}); };
  // Spend a hint power-up in a normal quiz (the same wallet earned in the arena):
  // hide two wrong options, before answering, once per question. Keeps at least
  // two options on screen so short MCQs are not trivialised.
  const quizHint = () => {
    if (selected!==null || quizElim.length || (srs.wallet?.hint||0) <= 0) return;
    const q = quiz.questions[qIdx];
    const wrong = (q?.options||[]).map((_,i)=>i).filter(i=>i!==q.correct);
    const nElim = Math.min(2, wrong.length-1);
    if (nElim <= 0) return;
    for (let x=wrong.length-1;x>0;x--){const j=Math.floor(Math.random()*(x+1));[wrong[x],wrong[j]]=[wrong[j],wrong[x]];}
    setQuizElim(wrong.slice(0,nElim)); srs.usePowerup("hint"); haptic();
  };
  // Keyboard-driven MCQ (opt-in via Settings, keys rebindable): the bound keys
  // pick an option, the "next" key advances once an answer is chosen. Skipped
  // for typed answers (fill/match) and whenever focus is in a field.
  useEffect(() => {
    if (screen !== "quiz" || quiz?.type !== "mcq" || settings.keyboardOn === false) return;
    const norm = (k) => (k && k.length === 1 ? k.toLowerCase() : k);
    const b = { ...DEFAULT_KEYBINDS, ...(settings.keyBindings || {}) };
    const optMap = { [norm(b.o1)]: 0, [norm(b.o2)]: 1, [norm(b.o3)]: 2, [norm(b.o4)]: 3 };
    const nextKey = norm(b.next);
    const onKey = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const tag = (e.target?.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || e.target?.isContentEditable) return;
      const k = norm(e.key);
      if (k === nextKey) { if (selected !== null) { e.preventDefault(); nextMCQ(); } return; }
      if (k in optMap) {
        const i = optMap[k], opts = quiz.questions[qIdx]?.options || [];
        if (selected === null && i < opts.length && !quizElim.includes(i)) { e.preventDefault(); pick(i); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, quiz, qIdx, selected, quizElim, settings.keyboardOn, settings.keyBindings]);
  // Retry re-shuffles the SAME questions into a new order (never regenerates),
  // so a second attempt isn't a memorised run. Marked `replay` so the results
  // handler doesn't double-count it into stats / the deck / the adaptive signal.
  const retry   = () => {
    setQuiz(prev => prev ? { ...prev, questions:[...prev.questions].sort(()=>Math.random()-0.5), fresh:false, replay:true } : prev);
    setQIdx(0);setAnswers([]);setSelected(null);setQuizElim([]);setScreen("quiz");
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
    setSelected(null); setQuizElim([]);
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
  // Feature D: re-drill just the questions you missed, as a fresh mini-quiz
  // (active recall on your weak spots, right now). Reuses the whole quiz flow, no
  // new generation, no quota spent, no lockout: keep fixing until you get them
  // all. The spaced-repetition deck still handles the long game.
  const missedThisQuiz = quiz && quiz.type!=="match"
    ? quiz.questions.filter((_, i) => answers[i] && answers[i].isCorrect === false)
    : [];
  const fixMisses = () => {
    if (!missedThisQuiz.length) return;
    // fresh:false so this re-drill of already-missed questions isn't logged into
    // the adaptive-difficulty perf history (it would skew accuracy low).
    setQuiz((prev) => ({ ...prev, questions: missedThisQuiz, title: t.fixMissesTitle, fresh:false }));
    setQIdx(0); setAnswers([]); setSelected(null); setQuizElim([]);
    setScreen("quiz");
  };

  const score = answers.filter(a=>a.isCorrect).length;
  const pct   = quiz ? Math.round((score/quiz.questions.length)*100) : 0;
  const badge = pct>=90?{icon:"trophy",text:t.excellent}:pct>=75?{icon:"target",text:t.great}:pct>=60?{icon:"notes",text:t.good}:{icon:"flame",text:t.keep};
  // Printable study sheet: open a clean, self-contained page (no app chrome)
  // with every question, the correct answer marked, and explanations, then
  // trigger the print dialog (which also offers "Save as PDF"). Lets students
  // revise offline, a genuinely useful export nobody else does well.
  const printStudySheet = () => {
    if (!quiz?.questions?.length) return;
    const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    const isMCQ = quiz.type === "mcq";
    const rows = quiz.questions.map((q, i) => {
      const a = answers[i];
      let bodyHtml;
      if (isMCQ && Array.isArray(q.options)) {
        bodyHtml = "<ul class='opts'>" + q.options.map((o, oi) => {
          const correct = oi === q.correct, chosenWrong = a && a.selected === oi && !correct;
          return `<li class='${correct ? "correct" : chosenWrong ? "wrong" : ""}'>${correct ? "✓ " : chosenWrong ? "✗ " : ""}${esc(o)}</li>`;
        }).join("") + "</ul>";
      } else {
        bodyHtml = `<p class='ans'><strong>Answer:</strong> ${esc(q.answer || (q.options && q.options[q.correct]) || "")}</p>`;
      }
      const exp = q.explanation ? `<p class='exp'>${esc(q.explanation)}</p>` : "";
      return `<div class='q'><p class='qt'><span class='n'>${i + 1}.</span> ${esc(q.question)}</p>${bodyHtml}${exp}</div>`;
    }).join("");
    const title = esc(quiz.title || quiz.subject || (t.printSheet || "Study sheet"));
    const doc = `<!doctype html><html><head><meta charset='utf-8'><title>${title} — Revyy</title><style>body{font-family:Georgia,'Times New Roman',serif;color:#1a1a1a;background:#fff;max-width:720px;margin:0 auto;padding:32px 24px;line-height:1.55}h1{font-size:22px;margin:0 0 4px}.meta{color:#666;font-size:13px;margin:0 0 24px;font-family:system-ui,sans-serif}.q{margin:0 0 18px;page-break-inside:avoid}.qt{font-weight:700;margin:0 0 6px}.n{color:#4338ca}.opts{list-style:none;padding:0;margin:0 0 6px}.opts li{padding:2px 0 2px 4px;font-size:15px}.opts li.correct{color:#127a44;font-weight:700}.opts li.wrong{color:#c0281d}.ans{margin:4px 0}.exp{color:#555;font-size:14px;font-style:italic;margin:4px 0 0}.foot{margin-top:28px;border-top:1px solid #ddd;padding-top:12px;color:#888;font-size:12px;font-family:system-ui,sans-serif}@media print{body{padding:0}}</style></head><body><h1>${title}</h1><p class='meta'>Revyy study sheet · ${new Date().toLocaleDateString()} · ${t.scoreCardLabel || "Score"} ${score}/${quiz.questions.length}</p>${rows}<p class='foot'>Made with Revyy · revyy.app</p></body></html>`;
    const w = window.open("", "_blank");
    if (!w) return; // pop-up blocked; the learner can allow pop-ups and retry
    w.document.write(doc); w.document.close(); w.focus();
    setTimeout(() => { try { w.print(); } catch { /* user can print manually */ } }, 350);
  };
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
      const ownerName = (settings.nickname||"").trim() || username || (user?.email || "").split("@")[0] || "";
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
    setMock(m); // the full mock, incl scoreMode/goodScore/totals for correct scoring
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
      // Every mock runs at authentic, demanding exam difficulty, never softened.
      // The form leans between a genuine full-difficulty paper and an extra-hard
      // one so retakes stay fresh, but a mock never feels unrealistically easy.
      const tilt = ["standard", "harder", "harder"][Math.floor(Math.random() * 3)];
      setMockTilt(tilt);
      // Build only the first section now; the rest build on demand as the user
      // proceeds. Faster start, and no cost for sections never reached.
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
  // ── Endless Arena (client) ──
  const [arenaQs, setArenaQs] = useState([]);
  const [arenaResult, setArenaResult] = useState(null);
  const [arenaMode, setArenaMode] = useState("gk");     // "gk" (pooled) | "subject" (your material)
  const [arenaSubject, setArenaSubject] = useState(null); // {key,title,subject} for a subject run
  const [arenaBoardData, setArenaBoardData] = useState(null);
  const [arenaSeasonData, setArenaSeasonData] = useState(null);
  const [arenaTab, setArenaTab] = useState("season"); // "season" (competitive ladder) | "all" (all-time)
  const [arenaBusy, setArenaBusy] = useState(false);
  const [arenaErr, setArenaErr] = useState("");
  // Global "best of the best" leaderboard (top 100 by lifetime XP/rank).
  const [globalBoardData, setGlobalBoardData] = useState(null);
  const [globalBusy, setGlobalBusy] = useState(false);
  const [globalUnlocked, setGlobalUnlocked] = useState(false); // hide the home tile until the board fills
  const globalCheckedRef = useRef(false);
  const [leagueData, setLeagueData] = useState(null);
  const [leagueBusy, setLeagueBusy] = useState(false);
  const [leagueUnlocked, setLeagueUnlocked] = useState(false); // hide the League entry until cohorts can fill
  const leagueCheckedRef = useRef(false);
  // ── Friends + study groups ──
  const [social, setSocial] = useState(null);      // {friends, incoming, outgoing, groups}
  const [socialBusy, setSocialBusy] = useState(false);
  const [socialTab, setSocialTab] = useState("friends"); // friends | groups
  const [joinPreview, setJoinPreview] = useState(null); // {code,name,members,already,id} from a shared invite link
  // Social notifications: latest server counts + a pop-up toast + delta tracking.
  const [notifData, setNotifData] = useState(null);
  const [notifToast, setNotifToast] = useState(null); // {text} for a transient pop-up
  const notifPrevRef = useRef(null);
  // Friend direct messages
  const [activeDM, setActiveDM] = useState(null); // {friendId, username}
  const [dmMsgs, setDmMsgs] = useState([]);
  const [dmInput, setDmInput] = useState("");
  const [dmSharePick, setDmSharePick] = useState(false); // library picker open
  const dmChallengeRef = useRef(null); // {challengeId, friendId, title} → record score on results
  const [socialErr, setSocialErr] = useState("");
  const [friendInput, setFriendInput] = useState("");
  const [friendMsg, setFriendMsg] = useState("");
  const [groupNameInput, setGroupNameInput] = useState("");
  const [joinCodeInput, setJoinCodeInput] = useState("");
  const [activeGroup, setActiveGroup] = useState(null); // loaded group detail
  const [groupBusy, setGroupBusy] = useState(false);
  const [groupTab, setGroupTab] = useState("board");    // board | library | activity
  const [showShare, setShowShare] = useState(false);    // share-to-group picker
  const [copiedCode, setCopiedCode] = useState(false);
  const [chatMsgs, setChatMsgs] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const [claimMsg, setClaimMsg] = useState("");         // "Claimed +2 hints..." toast
  // Head-to-head challenges
  const [chalList, setChalList] = useState([]);
  const [activeChallenge, setActiveChallenge] = useState(null); // loaded challenge detail
  const [challengeBusy, setChallengeBusy] = useState(false);
  const [showNewChallenge, setShowNewChallenge] = useState(false);
  const [newChalMode, setNewChalMode] = useState("solo"); // solo | teams
  const challengeRef = useRef(null); // {challengeId, team, title} for the results submit
  // Badges / trophy case
  const [badgeToast, setBadgeToast] = useState(null); // [ids] freshly unlocked, for the toast
  const badgeSyncedRef = useRef(false);
  // Celebration effects (confetti burst + rank-up toast + streak-advance sound).
  const [burstConfetti, setBurstConfetti] = useState(false);
  const [rankToast, setRankToast] = useState(null);   // a RANKS entry when the tier goes up
  const [streakToast, setStreakToast] = useState(null); // a STREAK_TIERS entry when the flame is promoted
  const [showStreak, setShowStreak] = useState(false); // the streak-tiers info panel (tap the flame)
  const [promotion, setPromotion] = useState(null);   // {fromIdx,toIdx,best} when a run promotes you
  const prevRankRef = useRef(null);
  const prevStreakRef = useRef(null);
  const prevStreakTierRef = useRef(null);
  const badgeBaselineRef = useRef(null); // ids the learner already qualified for at load (never celebrated)
  const fireBurst = useCallback(() => { setBurstConfetti(true); setTimeout(() => setBurstConfetti(false), 3800); }, []);
  // Which collapsible home cards are expanded (default collapsed to a tidy header).
  const [openCard, setOpenCard] = useState({});
  const toggleCard = useCallback((k) => setOpenCard((o) => ({ ...o, [k]: !o[k] })), []);
  const loadSocial = useCallback(async () => {
    setSocialBusy(true);
    const r = await socialApi("social");
    setSocialBusy(false);
    if (!r.error) setSocial({ friends: r.friends || [], incoming: r.incoming || [], outgoing: r.outgoing || [], groups: r.groups || [] });
  }, []);
  const openSocial = useCallback(() => { if (requireLogin()) return; setSocialErr(""); setFriendMsg(""); setScreen("social"); loadSocial(); }, [requireLogin, loadSocial]);
  const doAddFriend = useCallback(async () => {
    const name = friendInput.trim(); if (!name || socialBusy) return;
    setSocialBusy(true); setFriendMsg(""); setSocialErr("");
    const r = await socialApi("friendAdd", { username: name });
    setSocialBusy(false);
    if (r.error) { setSocialErr(r.error); return; }
    setFriendInput(""); setFriendMsg(r.status === "accepted" ? t.friendAdded || "You're now friends!" : t.friendRequested || "Request sent.");
    loadSocial();
  }, [friendInput, socialBusy, loadSocial, t]);
  const doRespondFriend = useCallback(async (id, accept) => { await socialApi("friendRespond", { id, accept }); loadSocial(); }, [loadSocial]);
  const doRemoveFriend = useCallback(async (userId) => { await socialApi("friendRemove", { userId }); loadSocial(); }, [loadSocial]);
  const doCreateGroup = useCallback(async () => {
    const name = groupNameInput.trim(); if (!name || socialBusy) return;
    setSocialBusy(true); setSocialErr("");
    const r = await socialApi("groupCreate", { name });
    setSocialBusy(false);
    if (r.error) { setSocialErr(r.error); return; }
    setGroupNameInput(""); srs.syncBadges({ groupJoin: true }); loadSocial();
  }, [groupNameInput, socialBusy, loadSocial, srs]);
  const doJoinGroup = useCallback(async () => {
    const code = joinCodeInput.trim(); if (!code || socialBusy) return;
    setSocialBusy(true); setSocialErr("");
    const r = await socialApi("groupJoin", { code });
    setSocialBusy(false);
    if (r.error) { setSocialErr(r.error); return; }
    setJoinCodeInput(""); srs.syncBadges({ groupJoin: true }); loadSocial();
  }, [joinCodeInput, socialBusy, loadSocial, srs]);
  const openGroup = useCallback(async (groupId) => {
    setGroupBusy(true); setActiveGroup(null); setGroupTab("board"); setScreen("group");
    const r = await socialApi("groupGet", { groupId });
    setGroupBusy(false);
    if (r.error) { setSocialErr(r.error); setScreen("social"); return; }
    setActiveGroup(r);
  }, []);
  const refreshGroup = useCallback(async () => {
    if (!activeGroup) return;
    const r = await socialApi("groupGet", { groupId: activeGroup.id });
    if (!r.error) setActiveGroup(r);
  }, [activeGroup]);
  const doInviteFriend = useCallback(async (userId) => {
    if (!activeGroup) return;
    await socialApi("groupInvite", { groupId: activeGroup.id, userId });
    refreshGroup();
  }, [activeGroup, refreshGroup]);
  const doLeaveGroup = useCallback(async () => {
    if (!activeGroup) return;
    if (typeof window !== "undefined" && !window.confirm(t.groupLeaveConfirm || "Leave this group?")) return;
    await socialApi("groupLeave", { groupId: activeGroup.id });
    setActiveGroup(null); setScreen("social"); loadSocial();
  }, [activeGroup, loadSocial, t]);
  const doShareToGroup = useCallback(async (doc) => {
    if (!activeGroup || !doc) return;
    setShowShare(false);
    await socialApi("groupShare", { groupId: activeGroup.id, title: doc.title, subject: doc.subject || "", summary: doc.summary || "" });
    refreshGroup();
  }, [activeGroup, refreshGroup]);
  const copyInvite = useCallback(() => {
    if (!activeGroup) return;
    const link = `${typeof window !== "undefined" ? window.location.origin : "https://revyy.app"}/app?join=${activeGroup.code}`;
    try { navigator.clipboard?.writeText(link); setCopiedCode(true); setTimeout(() => setCopiedCode(false), 1800); } catch { /* ignore */ }
  }, [activeGroup]);
  // Generate a quiz from a shared group doc (mirrors reviewLibrary), then log it.
  const quizGroupDoc = useCallback(async (docId) => {
    if (requireLogin() || !activeGroup) return;
    const d = await socialApi("groupDoc", { docId });
    if (d.error || !d.summary) { setSocialErr(d.error || t.groupNoMaterial || "Nothing to quiz yet."); return; }
    const n = 10;
    const consumed = await consumeQuestions(n);
    if (consumed && consumed.allowed === false) { setError(isPro ? "Daily limit reached." : "Daily limit reached. Watch an ad or upgrade."); setScreen("upload"); return; }
    const gid = activeGroup.id;
    setScreen("loading");
    try {
      const blocks = [{ type: "text", text: `${d.title}${d.subject ? " ("+d.subject+")" : ""}\n\n${d.summary}` }];
      let res = null, lastErr = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try { const r = await callClaude({ blocks, numQ: n, diff, type: "mcq", uiLangName: LANGS[lang]?.name }); if (r?.questions?.length) { res = r; break; } }
        catch (e) { lastErr = e; }
      }
      if (!res?.questions?.length) throw (lastErr || new Error("No questions returned"));
      genBlocksRef.current = blocks;
      groupQuizRef.current = { groupId: gid, title: d.title };
      setQuiz({ title: `${d.title} · ${t.groupWord || "Group"}`, subject: d.subject || "", questions: res.questions.slice(0, n), type: "mcq", fresh: true, genDiff: diff, groupId: gid });
      setQIdx(0); setAnswers([]); setSelected(null); setQuizElim([]);
      setScreen("quiz");
    } catch (err) { setError(err.message?.includes("parse") ? t.errAiFormat : err.message); setScreen("group"); }
  }, [requireLogin, activeGroup, consumeQuestions, isPro, diff, lang, t]);

  // ── Friend direct messages ───────────────────────────────────────────────
  const loadDM = useCallback(async (friendId) => {
    const r = await socialApi("dmThread", { friendId });
    if (r && !r.error) setDmMsgs(r.messages || []);
  }, []);
  const openDM = useCallback((friend) => {
    if (requireLogin()) return;
    setActiveDM({ friendId: friend.userId, username: friend.username, rank: friend.rank, badge: friend.badge, xp: friend.xp });
    setDmMsgs([]); setDmInput(""); setDmSharePick(false); setScreen("dm");
    loadDM(friend.userId);
  }, [requireLogin, loadDM]);
  const sendDM = useCallback(async (payload) => {
    const fid = activeDM?.friendId; if (!fid) return;
    const r = await socialApi("dmSend", { friendId: fid, ...payload });
    if (r && r.ok) loadDM(fid); else if (r?.error) setSocialErr(r.error);
  }, [activeDM, loadDM]);
  const sendDMText = useCallback(() => {
    const txt = dmInput.trim(); if (!txt) return;
    setDmInput(""); sendDM({ kind: "text", body: txt });
  }, [dmInput, sendDM]);
  // Send a snapshot of my rank / streak / accuracy. (myRankInfo is declared
  // here, above the DM handlers, so this callback's deps don't hit its TDZ.)
  const myRankInfo = useMemo(() => rankOf({ stats: srs.stats }), [srs.stats]);
  const shareScoreToDM = useCallback(() => {
    sendDM({ kind: "score", body: "", data: { rank: myRankInfo.index, xp: myRankInfo.xp, streak: stats.streak || 0, accuracy: stats.accuracy ?? null } });
  }, [sendDM, myRankInfo, stats]);
  // Generate a quiz from a shared study set (a friend's material, or a challenge).
  // For a challenge the run's score is auto-sent back to that friend on results.
  const quizFromDM = useCallback(async (data, opts = {}) => {
    if (!data?.summary) { setSocialErr(t.groupNoMaterial || "Nothing to quiz on here."); return; }
    const n = 10;
    const consumed = await consumeQuestions(n);
    if (consumed && consumed.allowed === false) { setError(isPro ? "Daily limit reached." : "Daily limit reached. Watch an ad or upgrade."); setScreen("upload"); return; }
    setScreen("loading");
    try {
      const blocks = [{ type: "text", text: `${data.title || ""}${data.subject ? " (" + data.subject + ")" : ""}\n\n${data.summary}` }];
      let res = null, lastErr = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try { const r = await callClaude({ blocks, numQ: n, diff, type: "mcq", uiLangName: LANGS[lang]?.name }); if (r?.questions?.length) { res = r; break; } }
        catch (e) { lastErr = e; }
      }
      if (!res?.questions?.length) throw (lastErr || new Error("No questions returned"));
      genBlocksRef.current = blocks;
      dmChallengeRef.current = opts.challenge && opts.challengeId ? { challengeId: opts.challengeId, friendId: opts.friendId, title: data.title || "" } : null;
      setQuiz({ title: `${data.title || (t.friendWord || "Friend")} · ${opts.challenge ? (t.challengeWord || "Challenge") : (t.friendWord || "Friend")}`, subject: data.subject || "", questions: res.questions.slice(0, n), type: "mcq", fresh: !opts.challenge, genDiff: diff });
      setQIdx(0); setAnswers([]); setSelected(null); setQuizElim([]);
      setScreen("quiz");
    } catch (err) { setError(err.message?.includes("parse") ? t.errAiFormat : err.message); setScreen("dm"); }
  }, [consumeQuestions, isPro, diff, lang, t]);
  // Start a ready-made sample quiz for a brand-new user (no material of their
  // own yet), so they feel the core loop before uploading anything. Generated
  // at an easy level for a confident first win; fresh:false so generic sample
  // content never skews adaptive difficulty on their real material later.
  const startSampleQuiz = useCallback(async (set) => {
    if (!set?.summary) return;
    const n = 10;
    // The starter is a one-time onboarding sample (shown once per account, fixed
    // content), so it isn't counted against the daily limit: a brand-new learner's
    // very first tap should always land the loop, never hit a "limit reached" wall.
    setScreen("loading");
    try {
      const blocks = [{ type: "text", text: `${set.title} (${set.subject})\n\n${set.summary}` }];
      let res = null, lastErr = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try { const r = await callClaude({ blocks, numQ: n, diff: "easy", type: "mcq", uiLangName: LANGS[lang]?.name }); if (r?.questions?.length) { res = r; break; } }
        catch (e) { lastErr = e; }
      }
      if (!res?.questions?.length) throw (lastErr || new Error("No questions returned"));
      genBlocksRef.current = blocks;
      setQuiz({ title: set.title, subject: set.subject || "", questions: res.questions.slice(0, n), type: "mcq", fresh: false, genDiff: "easy", sample: true });
      setQIdx(0); setAnswers([]); setSelected(null); setQuizElim([]);
      setScreen("quiz");
    } catch (err) { setError(err.message?.includes("parse") ? t.errAiFormat : err.message); setScreen("home"); }
  }, [lang, t]);
  // Signed-out visitors get a real taste of the loop with a hand-written sampler:
  // no account and no AI call (so it can't be abused for free generation and
  // always loads instantly). Marked demo so the results screen invites sign-up.
  const startDemoQuiz = useCallback(() => {
    genBlocksRef.current = null;
    setQuiz({ title: DEMO_QUIZ.title, subject: DEMO_QUIZ.subject, questions: DEMO_QUIZ.questions, type: "mcq", fresh: false, genDiff: "easy", sample: true, demo: true });
    setQIdx(0); setAnswers([]); setSelected(null); setQuizElim([]);
    setScreen("quiz");
  }, []);
  // First-run starter card: decide exactly ONCE whether this load is a genuine
  // first run, and latch it in a ref so persisting "seen" below never hides the
  // card mid-view. For a KNOWN signed-in user we wait for the server blob
  // (srs.loaded) so a returning learner on a fresh device isn't mistaken for
  // brand new; otherwise (guest, or before auth resolves) we decide from the
  // local blob, which already carries their seen flag on a device they've used.
  // The re-render that flips this is driven by the blob loading, so no setState
  // is needed here.
  const starterDecidedRef = useRef(false);
  const starterShowRef = useRef(false);
  if (!starterDecidedRef.current && !(user && !srs.loaded)) {
    starterDecidedRef.current = true;
    starterShowRef.current = librarySize(srs.library) === 0 && !srs.starterSeen;
  }
  const showStarter = starterShowRef.current;
  // Persist the one-shot the first time we show it, so it never returns.
  useEffect(() => {
    if (showStarter && !srs.starterSeen) srs.markStarterSeen();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showStarter]);
  // Poll the open DM thread so replies appear live.
  useEffect(() => {
    if (screen !== "dm" || !activeDM) return;
    const id = setInterval(() => loadDM(activeDM.friendId), 4000);
    return () => clearInterval(id);
  }, [screen, activeDM, loadDM]);
  // Invite links land at /app?join=CODE: once signed in, join that group and open it.
  useEffect(() => {
    if (joinHandledRef.current || !user) return;
    let code = null;
    try { code = new URLSearchParams(window.location.search).get("join"); } catch { /* ignore */ }
    if (!code) return;
    joinHandledRef.current = true;
    try { const u = new URL(window.location.href); u.searchParams.delete("join"); window.history.replaceState({}, "", u); } catch { /* ignore */ }
    // Preview the group first so the person can see it and confirm, rather than
    // being dropped straight in.
    (async () => { const r = await socialApi("groupPreview", { code }); if (r && r.id) setJoinPreview(r); else openSocial(); })();
  }, [user, openSocial]);
  const confirmJoinGroup = useCallback(async () => {
    if (!joinPreview) return;
    const r = await socialApi("groupJoin", { code: joinPreview.code });
    setJoinPreview(null);
    if (r && r.id) { srs.syncBadges({ groupJoin: true }); openGroup(r.id); } else openSocial();
  }, [joinPreview, openGroup, openSocial, srs]);
  // Claim the group's collective reward into the personal power-up wallet.
  const doClaimReward = useCallback(async () => {
    if (!activeGroup) return;
    const r = await socialApi("groupClaim", { groupId: activeGroup.id });
    if (r.reward) {
      srs.grantPowerups(r.reward);
      const parts = [];
      if (r.reward.hint) parts.push(`${r.reward.hint} ${t.arenaHint || "hint"}`);
      if (r.reward.freeze) parts.push(`${r.reward.freeze} ${t.arenaFreeze || "freeze"}`);
      if (r.reward.skip) parts.push(`${r.reward.skip} ${t.arenaSkip || "skip"}`);
      setClaimMsg((t.groupRewardClaimed || "Claimed {p}, your whole group earned it!").replace("{p}", parts.join(", ")));
      setTimeout(() => setClaimMsg(""), 3500);
      refreshGroup();
    }
  }, [activeGroup, srs, t, refreshGroup]);
  // Group chat: load + send, polled while the chat tab is open.
  const loadChat = useCallback(async (groupId) => {
    const r = await socialApi("groupChat", { groupId });
    if (!r.error) setChatMsgs(r.messages || []);
  }, []);
  const sendChat = useCallback(async () => {
    const text = chatInput.trim(); if (!text || !activeGroup) return;
    setChatInput("");
    await socialApi("groupChatSend", { groupId: activeGroup.id, text });
    loadChat(activeGroup.id);
  }, [chatInput, activeGroup, loadChat]);
  useEffect(() => {
    if (screen !== "group" || groupTab !== "chat" || !activeGroup) return;
    loadChat(activeGroup.id);
    const id = setInterval(() => loadChat(activeGroup.id), 4000);
    return () => clearInterval(id);
  }, [screen, groupTab, activeGroup, loadChat]);
  // ── Head-to-head challenges ──
  const loadChallenges = useCallback(async (groupId) => {
    const r = await socialApi("challengeList", { groupId });
    if (!r.error) setChalList(r.challenges || []);
  }, []);
  const openChallenges = useCallback(() => { if (!activeGroup) return; setActiveChallenge(null); setScreen("challenges"); loadChallenges(activeGroup.id); }, [activeGroup, loadChallenges]);
  const openChallenge = useCallback(async (id) => {
    setChallengeBusy(true); setActiveChallenge(null);
    const r = await socialApi("challengeGet", { challengeId: id });
    setChallengeBusy(false);
    if (!r.error) setActiveChallenge(r);
  }, []);
  const createChallenge = useCallback(async (doc, mode) => {
    if (!activeGroup || !doc) return;
    setShowNewChallenge(false); setChallengeBusy(true); setSocialErr("");
    const d = await socialApi("groupDoc", { docId: doc.id });
    if (d.error || !d.summary) { setChallengeBusy(false); setSocialErr(d.error || t.groupNoMaterial || "Couldn't load that set."); return; }
    const consumed = await consumeQuestions(10);
    if (consumed && consumed.allowed === false) { setChallengeBusy(false); setSocialErr(isPro ? "Daily limit reached." : "Daily limit reached. Watch an ad or upgrade."); return; }
    try {
      const blocks = [{ type: "text", text: `${d.title}${d.subject ? " (" + d.subject + ")" : ""}\n\n${d.summary}` }];
      let res = null;
      for (let a = 0; a < 3; a++) { try { const r = await callClaude({ blocks, numQ: 10, diff, type: "mcq", uiLangName: LANGS[lang]?.name }); if (r?.questions?.length) { res = r; break; } } catch { /* retry */ } }
      if (!res?.questions?.length) throw new Error("generation failed");
      const r2 = await socialApi("challengeCreate", { groupId: activeGroup.id, title: d.title, mode, questions: res.questions });
      setChallengeBusy(false);
      if (r2.error) { setSocialErr(r2.error); return; }
      loadChallenges(activeGroup.id);
    } catch { setChallengeBusy(false); setSocialErr(t.challengeCreateErr || "Couldn't create the challenge, try again."); }
  }, [activeGroup, consumeQuestions, isPro, diff, lang, t, loadChallenges]);
  const playChallenge = useCallback((team) => {
    if (!activeChallenge?.questions?.length) return;
    challengeRef.current = { challengeId: activeChallenge.id, team: team || null, title: activeChallenge.title };
    setQuiz({ title: `${activeChallenge.title} · ${t.challengeWord || "Challenge"}`, subject: "", questions: activeChallenge.questions.map((q) => ({ ...q })), type: "mcq", fresh: false, genDiff: diff, challengeId: activeChallenge.id });
    setQIdx(0); setAnswers([]); setSelected(null); setQuizElim([]);
    setScreen("quiz");
  }, [activeChallenge, diff, t]);
  const [showUsername, setShowUsername] = useState(false);
  const [unameInput, setUnameInput] = useState("");
  const [unameErr, setUnameErr] = useState("");
  const [unameBusy, setUnameBusy] = useState(false);
  const arenaAfterName = useRef(null);
  const unamePromptedRef = useRef(false);
  // Prompt for a public name exactly ONCE, ever (a persisted flag survives
  // reloads and new sessions), only for a signed-in user who has none yet. The
  // arena's requireUsername still opens the picker on demand regardless.
  useEffect(() => {
    if (authLoading || !user || username !== null || unamePromptedRef.current) return;
    try { if (localStorage.getItem("revyy_uname_prompted") === "1") return; } catch { /* ignore */ }
    unamePromptedRef.current = true;
    try { localStorage.setItem("revyy_uname_prompted", "1"); } catch { /* ignore */ }
    setUnameInput(""); setUnameErr(""); setShowUsername(true);
  }, [authLoading, user, username]);
  // "Maybe later": give them a random name (changeable later in settings) so the
  // leaderboard has one and they are never asked again, then run any pending action.
  const skipUsername = useCallback(async () => {
    const after = arenaAfterName.current; arenaAfterName.current = null;
    try { localStorage.setItem("revyy_uname_prompted", "1"); } catch { /* ignore */ }
    if (username === null) {
      for (let i = 0; i < 3; i++) { const r = await saveUsername("Learner" + Math.floor(1000 + Math.random() * 9000)); if (r && r.ok) break; }
    }
    setShowUsername(false);
    if (after) after();
  }, [username, saveUsername]);
  // Ensure a public name exists, then run `next`; otherwise open the picker first.
  const requireUsername = useCallback((next) => {
    if (username) { next && next(); return; }
    arenaAfterName.current = next || null; setUnameInput(""); setUnameErr(""); setShowUsername(true);
  }, [username]);
  const submitUsername = useCallback(async () => {
    const name = unameInput.trim();
    setUnameErr(""); setUnameBusy(true);
    const r = await saveUsername(name);
    setUnameBusy(false);
    if (r && r.ok) { setShowUsername(false); const after = arenaAfterName.current; arenaAfterName.current = null; if (after) after(); }
    else setUnameErr((r && r.error) || t.unameErr);
  }, [unameInput, saveUsername, t]);
  const openArena = useCallback(() => {
    if (requireLogin()) return;
    setArenaErr(""); setArenaResult(null); requireUsername(() => setScreen("arena_intro"));
  }, [requireLogin, requireUsername]);
  const startArena = useCallback(() => {
    requireUsername(async () => {
      setArenaErr(""); setArenaBusy(true); setScreen("arena_gen");
      const qs = await arenaDrawGlobal();
      setArenaBusy(false);
      if (qs.length < 5) { setArenaErr(t.arenaNoQs); setScreen("arena_intro"); return; }
      setArenaMode("gk"); setArenaSubject(null);
      setArenaQs(qs); setScreen("arena_play");
    });
  }, [requireUsername, t]);
  // Subject arena: the same fast, sudden-death game, but questions are generated
  // from a chosen subject (or your own material) instead of the pooled GK bank.
  // A personal challenge on your moat; it earns streak + power-ups + a personal
  // best per subject, but stays off the GK leaderboard/rank (those aren't
  // comparable across different question sets).
  const startSubjectArena = useCallback((set) => {
    if (!set) return;
    const material = set.material || (set.summary ? `${set.title || set.subject || "Subject"} (${set.subject || ""})\n\n${set.summary}` : "");
    if (!material.trim()) return;
    requireUsername(async () => {
      const N = 20;
      const consumed = await consumeQuestions(N);
      if (consumed && consumed.allowed === false) { setArenaErr(isPro ? (t.dailyLimit || "Daily limit reached.") : (t.dailyLimitFree || "Daily limit reached. Watch an ad or upgrade.")); setScreen("arena_intro"); return; }
      setArenaErr(""); setArenaBusy(true); setScreen("arena_gen");
      try {
        const blocks = [{ type: "text", text: material.slice(0, 12000) }];
        let res = null, lastErr = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          try { const r = await callClaude({ blocks, numQ: N, diff: "normal", type: "mcq", uiLangName: LANGS[lang]?.name }); if (r?.questions?.length) { res = r; break; } }
          catch (e) { lastErr = e; }
        }
        if (!res?.questions?.length) throw (lastErr || new Error("No questions returned"));
        const qs = res.questions.map((q, i, arr) => toArenaQ(q, i, arr.length, set.subject || set.title)).filter(Boolean);
        setArenaBusy(false);
        if (qs.length < 5) { setArenaErr(t.arenaNoQs); setScreen("arena_intro"); return; }
        setArenaMode("subject"); setArenaSubject({ key: set.id || set.subject || set.title, title: set.title || set.subject, subject: set.subject || "", set });
        setArenaQs(qs); setScreen("arena_play");
      } catch (err) {
        setArenaBusy(false);
        setArenaErr(err?.message?.includes("parse") ? (t.errAiFormat || "Generation error, try again.") : (err?.message || t.arenaNoQs));
        setScreen("arena_intro");
      }
    });
  }, [requireUsername, consumeQuestions, isPro, lang, t]);
  const onArenaEnd = useCallback(async (result) => {
    if (arenaMode === "subject") {
      // Personal challenge on your own material: streak + power-ups + a personal
      // best per subject. Deliberately does NOT touch the GK leaderboard, rank
      // or leagues (scores on different question sets aren't comparable).
      const score = Math.max(0, Math.round(Number(result.score) || 0));
      const key = arenaSubject?.key || "subject";
      const prevBest = Math.max(0, Math.round(Number(srs.subjectArena?.[key]) || 0));
      const earned = srs.completeActivity({ mode: "arena", score });
      srs.recordSubjectArena(key, score);
      setArenaResult({ ...result, score, best: Math.max(prevBest, score), isBest: score > prevBest, subject: arenaSubject, pending: false, earned });
      setScreen("arena_over");
      return;
    }
    setScreen("arena_over"); setArenaResult({ ...result, best: result.score, isBest: false, pending: true });
    // Rank BEFORE this run (rank is your best Arena score), captured before the
    // blob updates, so we can tell if this run PROMOTED you.
    const prevBest = Math.max(0, Math.round(Number(srs.stats?.arenaBest) || 0));
    const r = await arenaSubmitGlobal(result);
    const finalScore = (r && r.score) ?? result.score;
    // Grant the run's reward from the AUTHORITATIVE score, and keep the streak
    // alive (endless counts toward the universal streak, not toward savers).
    const earned = srs.completeActivity({ mode: "arena", score: finalScore });
    // Badge signals: track your best arena score + longest run for the arena badges.
    srs.syncBadges({ arenaScore: finalScore, arenaRun: result.questions || 0 });
    setArenaResult({ ...result, score: finalScore, best: (r && r.best) ?? result.score, isBest: !!(r && r.isBest), pending: false, earned });
    // Promotion: did this run's authoritative best cross into a higher tier?
    // Fire the one-time celebration here (only when a game is DONE) and mark the
    // tier celebrated so the reactive rank-up effect below never double-fires.
    const newBest = Math.max(prevBest, Math.round(Number((r && r.best) ?? finalScore) || 0));
    // Rank now combines arena + study XP, so compare on the SAME combined scale
    // (study part held constant across this run) to detect a genuine promotion.
    const studyBase = studyRankXP(srs.stats);
    const fromIdx = rankFor(prevBest + studyBase).index, toIdx = rankFor(newBest + studyBase).index;
    if (toIdx > fromIdx) {
      _celebratedRankIdx = toIdx; prevRankRef.current = toIdx;
      SoundEngine.rankUp(); fireBurst();
      setPromotion({ fromIdx, toIdx, best: newBest });
    }
  }, [srs, fireBurst, arenaMode, arenaSubject]);
  const openArenaBoard = useCallback(async () => {
    setArenaBusy(true); setArenaBoardData(null); setArenaSeasonData(null); setScreen("arena_board");
    const [b, s] = await Promise.all([arenaBoardGlobal(), arenaSeasonGlobal()]);
    setArenaBusy(false); setArenaBoardData(b); setArenaSeasonData(s);
  }, []);
  const openGlobalBoard = useCallback(async () => {
    setGlobalBusy(true); setGlobalBoardData(null); setScreen("global_board");
    const b = await socialApi("globalBoard");
    setGlobalBusy(false); setGlobalBoardData(b && !b.error ? b : { players: 0, top: [], you: null });
  }, []);
  const openLeague = useCallback(async () => {
    setLeagueBusy(true); setLeagueData(null); setScreen("league");
    const b = await socialApi("leagueBoard");
    setLeagueBusy(false); setLeagueData(b && !b.error ? b : { locked: true, players: 0, need: 100 });
  }, []);

  // ── Badges wiring ────────────────────────────────────────────────────
  // Retroactively grant any badges the learner already qualifies for (existing
  // accounts whose history predates this feature), once, after the blob is live.
  useEffect(() => {
    if (badgeSyncedRef.current || srs.stats?.answered == null) return;
    badgeSyncedRef.current = true;
    srs.syncBadges();
  }, [srs]);
  // Background check (once, when signed in): only surface the Global leaderboard
  // entry after enough learners are ranked to fill it. When locked, the server
  // returns just counts (cheap); when unlocked we cache the board too.
  useEffect(() => {
    if (!user || globalCheckedRef.current) return;
    globalCheckedRef.current = true;
    (async () => {
      const b = await socialApi("globalBoard");
      if (b && !b.error && !b.locked) { setGlobalUnlocked(true); setGlobalBoardData(b); }
    })();
  }, [user]);
  // Same gate for Weekly Leagues: only surface the entry once there are enough
  // players to form real cohorts (mirrors the leaderboard's reveal).
  useEffect(() => {
    if (!user || leagueCheckedRef.current) return;
    leagueCheckedRef.current = true;
    (async () => {
      const b = await socialApi("leagueBoard");
      if (b && !b.error && !b.locked) { setLeagueUnlocked(true); setLeagueData(b); }
    })();
  }, [user]);
  // ── Social notifications ────────────────────────────────────────────────
  // Poll the lightweight summary while signed in (and on mount, so activity that
  // happened while offline surfaces at login).
  useEffect(() => {
    if (!user) return;
    let alive = true;
    const poll = async () => { const d = await socialApi("notifications"); if (alive && d && !d.error) setNotifData(d); };
    poll();
    const id = setInterval(poll, 25000);
    return () => { alive = false; clearInterval(id); };
  }, [user]);
  const unread = useMemo(() => computeUnread(notifData, srs.notif?.seen), [notifData, srs.notif]);
  // Pop up a toast + chime when NEW activity appears (first poll after login
  // covers anything waiting), respecting the two toggles. The bubble counts
  // regardless of the toggles.
  useEffect(() => {
    if (!notifData) return;
    const reqOn = srs.notif?.req !== false, msgOn = srs.notif?.msg !== false;
    const prev = notifPrevRef.current;
    notifPrevRef.current = unread;
    const dF = prev ? unread.friends - prev.friends : unread.friends;
    const dM = prev ? unread.msg - prev.msg : unread.msg;
    const dC = prev ? unread.chal - prev.chal : unread.chal;
    const parts = [];
    if (reqOn && dF > 0) parts.push((t.notifFriendReq || "{n} new friend request{s}").replace("{n}", dF).replace("{s}", dF > 1 ? "s" : ""));
    if (reqOn && dC > 0) parts.push((t.notifChallengeReq || "{n} new challenge{s}").replace("{n}", dC).replace("{s}", dC > 1 ? "s" : ""));
    if (msgOn && dM > 0) parts.push((t.notifNewMsg || "{n} new message{s}").replace("{n}", dM).replace("{s}", dM > 1 ? "s" : ""));
    if (!parts.length) return;
    const txt = parts.join(" · ");
    const id = setTimeout(() => { setNotifToast({ text: txt }); if (settings.notifSound !== false) SoundEngine.ping(); }, 0);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unread]);
  useEffect(() => {
    if (!notifToast) return;
    const id = setTimeout(() => setNotifToast(null), 4500);
    return () => clearTimeout(id);
  }, [notifToast]);
  // Mark activity seen (clears the bubble) when the learner actually looks at it:
  // the friends tab for requests, a group's chat for messages, its challenges list
  // for challenges. Deferred so it isn't a synchronous setState in the effect.
  useEffect(() => {
    if (screen !== "social" || !notifData) return;
    const id = setTimeout(() => srs.markNotifSeen({ friendReqs: notifData.friendReqs }), 0);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, notifData?.friendReqs]);
  useEffect(() => {
    if (screen !== "group" || groupTab !== "chat" || !activeGroup || !notifData) return;
    const g = (notifData.groups || []).find((x) => x.id === activeGroup.id); if (!g) return;
    const id = setTimeout(() => srs.markNotifSeen({ g: { [activeGroup.id]: { m: g.msg } } }), 0);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, groupTab, activeGroup, notifData]);
  useEffect(() => {
    if (screen !== "challenges" || !activeGroup || !notifData) return;
    const g = (notifData.groups || []).find((x) => x.id === activeGroup.id); if (!g) return;
    const id = setTimeout(() => srs.markNotifSeen({ g: { [activeGroup.id]: { c: g.chal } } }), 0);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, activeGroup, notifData]);
  useEffect(() => {
    if (screen !== "dm" || !activeDM || !notifData) return;
    const d = (notifData.dms || []).find((x) => x.id === activeDM.friendId); if (!d) return;
    const id = setTimeout(() => srs.markNotifSeen({ f: { [activeDM.friendId]: d.msg } }), 0);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, activeDM, notifData]);
  const badgeEval = useMemo(() => evaluateBadges({ stats: srs.stats, mockScores: srs.mockScores, badges: srs.badges }), [srs.stats, srs.mockScores, srs.badges]);
  const earnedBadgeCount = badgeEval.earnedIds.length;
  const myXP = myRankInfo.xp;
  // Friend-overtake nudge: when a friend's lifetime XP crosses above yours, a
  // single gentle pop-up invites you back to reclaim your spot. Deduped per
  // friend via the persisted "ahead" set (re-passing them re-arms it), collapsed
  // to one toast per poll, and seeded silently on first run so an existing user
  // never gets a false "everyone passed you". Gated by the rival pref; only
  // writes the blob when the standings actually shift.
  useEffect(() => {
    if (!notifData || !Array.isArray(notifData.friendsXp) || !srs.loaded) return;
    const { aheadIds, fresh, changed, inited } = detectOvertakes({
      friendsXp: notifData.friendsXp, myXP, seenAhead: srs.notif?.seen?.ahead, aheadInit: srs.notif?.seen?.aheadInit,
    });
    if (!changed) return; // standings unchanged -> no write, no nudge
    const id = setTimeout(() => {
      srs.markNotifSeen({ ahead: aheadIds, aheadInit: true });
      if (inited && fresh.length && srs.notif?.rival !== false) {
        const lead = fresh.slice().sort((a, b) => a.xp - b.xp)[0]; // the closest rival
        const txt = fresh.length === 1
          ? (t.notifOvertake || "{name} just passed you, {xp} XP. Reclaim your spot.").replace("{name}", stripEmoji(lead.name)).replace("{xp}", Number(lead.xp).toLocaleString())
          : (t.notifOvertakeMany || "{name} and {n} others passed you. Climb back up.").replace("{name}", stripEmoji(lead.name)).replace("{n}", fresh.length - 1);
        setNotifToast({ text: txt });
        if (settings.notifSound !== false) SoundEngine.ping();
      }
    }, 0);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notifData, myXP]);
  // Phased home: a brand-new learner (no quiz finished, no material yet) sees
  // only the core action; the social / gamification / coach surfaces reveal
  // themselves once they've felt the loop once, so the first screen never
  // overwhelms. Everything comes back the moment they've started.
  const hasStarted = (stats.answered || 0) > 0 || librarySize(srs.library) > 0;
  // Daily goal: a reachable target that (with the streak) gives a reason to come
  // back tomorrow. Personalized to the learner's own recent typical day (a gentle
  // ramp for newcomers). Counted in the study blob (srs.daily), resets daily.
  const DAILY_GOAL = recommendDailyGoal({ stats: srs.stats, perf: srs.perf });
  const dailyToday = (srs.daily && srs.daily.date === new Date().toLocaleDateString("en-CA")) ? (srs.daily.count || 0) : 0;
  const dailyMet = dailyToday >= DAILY_GOAL;
  const dailyPct = Math.min(100, Math.round((dailyToday / DAILY_GOAL) * 100));
  // Celebrate ONLY a badge that becomes earned during THIS session (a real
  // unlock). On the first evaluation we baseline everything the learner already
  // qualifies for and mark it seen, so re-opening the app never replays the
  // effect or the toast — the toast + sound + confetti fire once, at the moment
  // of unlocking. Keyed on the qualifying-set signature.
  const earnedKey = badgeEval.earnedIds.join(",");
  useEffect(() => {
    const now = badgeEval.earnedIds;
    if (badgeBaselineRef.current == null) {
      badgeBaselineRef.current = new Set(now);
      const seen = new Set(srs.badges?.seen || []);
      const unseen = now.filter((id) => !seen.has(id));
      if (unseen.length) setTimeout(() => srs.markBadgesSeen(unseen), 0); // silence future opens
      return;
    }
    // Celebrate only a badge that is new since our baseline AND not already in the
    // account's synced `seen` list. A fresh device baselines an empty blob before
    // the server sync lands, so without the `seen` check every already-earned badge
    // would replay its toast + sound on that device. `seen` is account-tied, so the
    // celebration is too.
    const seen = new Set(srs.badges?.seen || []);
    const fresh = now.filter((id) => !badgeBaselineRef.current.has(id) && !seen.has(id));
    if (!fresh.length) return;
    fresh.forEach((id) => badgeBaselineRef.current.add(id));
    const id = setTimeout(() => { setBadgeToast(fresh); srs.markBadgesSeen(fresh); SoundEngine.unlock(); fireBurst(); }, 450);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [earnedKey]);
  // Streak getting hotter: a rising flare (pitch scales with the count) the
  // moment the streak extends. Silent on first load.
  useEffect(() => {
    if (!srs.loaded) return; // wait for the account blob, so a fresh device doesn't fire on the empty->loaded jump
    const s = stats.streak || 0;
    if (prevStreakRef.current == null) { prevStreakRef.current = s; if (_celebratedStreak < 0) _celebratedStreak = s; return; }
    if (s > prevStreakRef.current && s > _celebratedStreak) { _celebratedStreak = s; SoundEngine.streak(s); }
    prevStreakRef.current = s;
  }, [stats.streak, srs.loaded]);
  // Streak-tier PROMOTION: a one-time celebration (flame + message + confetti)
  // when the run crosses into a higher tier (Kindled 14, Blaze 30, Wildfire 60,
  // Inferno 90, Firestorm 180, Phoenix 365). Mirrors the rank-up pattern: gated
  // on srs.loaded and seeded on first load so it never replays on a new
  // login/device, only when the streak genuinely crosses a milestone in-session.
  useEffect(() => {
    if (!srs.loaded) return;
    const tierObj = streakTier(stats.streak || 0);
    const tier = tierObj.index;
    if (prevStreakTierRef.current == null) { prevStreakTierRef.current = tier; if (_celebratedStreakTier < 0) _celebratedStreakTier = tier; return; }
    if (tier > prevStreakTierRef.current && tier > _celebratedStreakTier && tier >= 2) { // >=2 == 3+ days
      _celebratedStreakTier = tier;
      SoundEngine.rankUp(); fireBurst();
      setStreakToast(tierObj);
      setTimeout(() => setStreakToast(null), 6000);
    }
    prevStreakTierRef.current = tier;
  }, [stats.streak, srs.loaded, fireBurst]);
  // Auto-dismiss the badge toast.
  useEffect(() => {
    if (!badgeToast) return;
    const id = setTimeout(() => setBadgeToast(null), 4200);
    return () => clearTimeout(id);
  }, [badgeToast]);
  // Opening the trophy case counts as "seeing" your achievements: clear the pill.
  useEffect(() => {
    if (screen !== "badges") return;
    const id = setTimeout(() => setBadgeToast(null), 0);
    return () => clearTimeout(id);
  }, [screen]);
  // Rank-up celebration: fanfare + confetti + a toast when the tier climbs.
  useEffect(() => {
    if (!srs.loaded) return; // wait for the account blob, so a fresh device doesn't fire on the empty->loaded jump
    const r = myRankInfo.index;
    if (prevRankRef.current == null) { prevRankRef.current = r; if (_celebratedRankIdx < 0) _celebratedRankIdx = r; return; } // seed, don't fire on first load
    if (r > prevRankRef.current && r > _celebratedRankIdx) { _celebratedRankIdx = r; SoundEngine.rankUp(); fireBurst(); setRankToast(RANKS[r]); setTimeout(() => setRankToast(null), 5000); }
    prevRankRef.current = r;
  }, [myRankInfo.index, fireBurst, srs.loaded]);
  // Shared "badge unlocked" toast, dropped into the finish screens + home.
  const badgeToastEl = badgeToast && badgeToast.length ? (
    <div style={{position:"fixed",left:0,right:0,bottom:20,zIndex:900,display:"flex",justifyContent:"center",pointerEvents:"none",padding:"0 14px"}}>
      <div className="rv-badge-pop" style={{background:"var(--color-text-primary)",color:"var(--color-background-primary)",borderRadius:14,padding:"11px 14px",boxShadow:"0 12px 32px rgba(35,31,26,0.30)",display:"flex",alignItems:"center",gap:11,maxWidth:380,pointerEvents:"auto"}}>
        <span style={{fontSize:25,lineHeight:1}} aria-hidden="true">{BADGE_BY_ID[badgeToast[0]]?.emoji||"🏅"}</span>
        <div style={{minWidth:0,flex:1}}>
          <div style={{fontSize:12.5,fontWeight:800}}>{badgeToast.length>1?(t.badgeUnlockedN||"{n} badges unlocked!").replace("{n}",badgeToast.length):(t.badgeUnlocked||"Badge unlocked!")}</div>
          <div style={{fontSize:12,opacity:0.85,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{badgeToast.map((id)=>(t["badge_"+id]||BADGE_BY_ID[id]?.name||id)).join(", ")}</div>
        </div>
        <button onClick={()=>{setScreen("badges");setBadgeToast(null);}} style={{fontSize:11.5,fontWeight:700,border:"none",background:"var(--color-accent)",color:"#fff",borderRadius:20,padding:"5px 11px",cursor:"pointer",flexShrink:0}}>{t.badgeView||"View"}</button>
      </div>
    </div>
  ) : null;
  // Rank-up banner: a centred burst when the learner reaches a new tier.
  const rankToastEl = rankToast ? (
    <div style={{position:"fixed",inset:0,zIndex:905,display:"flex",alignItems:"center",justifyContent:"center",pointerEvents:"none",padding:16}}>
      <div className="rv-rank-burst" onClick={()=>{setRankToast(null);setScreen("badges");}} style={{pointerEvents:"auto",cursor:"pointer",textAlign:"center",background:"var(--color-background-primary)",border:`2px solid ${rankToast.color}`,borderRadius:20,padding:"22px 26px",boxShadow:`0 18px 50px ${rankToast.color}55`,maxWidth:320}}>
        <div style={{marginBottom:6,display:"flex",justifyContent:"center"}} aria-hidden="true"><Icon name={rankToast.icon} size={44} stroke={1.8} style={{color:rankToast.color}}/></div>
        <div style={{fontSize:11,fontWeight:800,letterSpacing:1,textTransform:"uppercase",color:"var(--color-text-tertiary)"}}>{t.rankUpLabel||"Rank up!"}</div>
        <div style={{fontSize:24,fontWeight:800,fontFamily:"'Fraunces',Georgia,serif",color:rankToast.color,margin:"2px 0 4px"}}>{(t["rank_"+rankToast.key])||rankToast.name}</div>
        <div style={{fontSize:12.5,color:"var(--color-text-secondary)"}}>{t.rankUpSub||"You've leveled up. Keep climbing."}</div>
      </div>
    </div>
  ) : null;
  // Streak-promotion banner: a centred burst when the flame reaches a new tier.
  const streakToastEl = streakToast ? (
    <div style={{position:"fixed",inset:0,zIndex:906,display:"flex",alignItems:"center",justifyContent:"center",pointerEvents:"none",padding:16}}>
      <div className="rv-rank-burst" onClick={()=>setStreakToast(null)} style={{pointerEvents:"auto",cursor:"pointer",textAlign:"center",background:"var(--color-background-primary)",border:`2px solid ${streakToast.color}`,borderRadius:20,padding:"22px 26px",boxShadow:`0 18px 50px ${streakToast.color}55`,maxWidth:330}}>
        <div style={{marginBottom:8,display:"flex",justifyContent:"center"}}><StreakFlame count={streakToast.days} size={46} showCount={false}/></div>
        <div style={{fontSize:11,fontWeight:800,letterSpacing:1,textTransform:"uppercase",color:"var(--color-text-tertiary)"}}>{t.streakUpLabel||"Streak milestone"}</div>
        <div style={{fontSize:24,fontWeight:800,fontFamily:"'Fraunces',Georgia,serif",color:streakToast.color,margin:"2px 0 4px"}}>{(t["streakTier_"+streakToast.key])||streakToast.name}</div>
        <div style={{fontSize:13,color:"var(--color-text-secondary)"}}>{(t.streakUpSub||"{n} days in a row. You've been consistent, keep the fire alive!").replace("{n}",streakToast.days)}</div>
      </div>
    </div>
  ) : null;
  // Streak info panel: tap the flame by your name to see the tier ladder, the
  // days each needs and the name earned, with your current tier highlighted.
  const streakInfoEl = showStreak ? (() => {
    const cur = streakTier(stats.streak || 0);
    const tiers = STREAK_TIERS.filter((tr) => tr.min >= 1);
    return (
      <div style={{position:"fixed",inset:0,zIndex:922,background:"rgba(0,0,0,0.6)",display:"flex",alignItems:"center",justifyContent:"center",padding:16}} onClick={()=>setShowStreak(false)}>
        <div onClick={(e)=>e.stopPropagation()} style={{background:"var(--color-background-primary)",borderRadius:18,padding:"20px",maxWidth:360,width:"100%",maxHeight:"85vh",overflowY:"auto",boxShadow:"0 20px 50px rgba(0,0,0,0.45)"}}>
          <div style={{display:"flex",alignItems:"center",gap:11,marginBottom:6}}>
            <StreakFlame count={stats.streak||0} size={28} showZero showCount={false}/>
            <div style={{minWidth:0}}>
              <div style={{fontSize:11,fontWeight:800,letterSpacing:.5,textTransform:"uppercase",color:"var(--color-text-tertiary)"}}>{t.streakWord||"Streak"}</div>
              <div style={{fontSize:19,fontWeight:800,fontFamily:"'Fraunces',Georgia,serif",color:cur.color}}>{(stats.streak||0)>0?(t.streakDaysN||"{n}-day streak").replace("{n}",stats.streak):(t.streakNone||"No streak yet")}</div>
            </div>
          </div>
          <div style={{fontSize:12.5,color:"var(--color-text-secondary)",marginBottom:14,lineHeight:1.5}}>{t.streakInfoSub||"Study any day to keep your flame lit. Hit these milestones to promote it."}</div>
          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            {tiers.map((tr)=>{
              const reached=(stats.streak||0)>=tr.min, isCur=tr.key===cur.key;
              return (
                <div key={tr.key} style={{display:"flex",alignItems:"center",gap:11,padding:"9px 11px",borderRadius:12,border:"1px solid "+(isCur?tr.color:"var(--color-border-secondary)"),background:isCur?tr.color+"14":"transparent",opacity:reached?1:0.6}}>
                  <span style={{width:28,display:"flex",justifyContent:"center",flexShrink:0}}>{reached?<StreakFlame count={tr.min} size={20} showCount={false}/>:<Icon name="flame" size={17} style={{color:"var(--color-text-tertiary)"}}/>}</span>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:14,fontWeight:700,color:reached?tr.color:"var(--color-text-secondary)"}}>{(t["streakTier_"+tr.key])||tr.name}</div>
                    <div style={{fontSize:11.5,color:"var(--color-text-tertiary)"}}>{(t.streakDaysReq||"{n} days").replace("{n}",tr.min)}</div>
                  </div>
                  {isCur ? <span style={{fontSize:10,fontWeight:800,textTransform:"uppercase",letterSpacing:.4,color:tr.color,flexShrink:0}}>{t.streakYouHere||"You're here"}</span>
                    : reached ? <Icon name="check" size={16} stroke={2.4} style={{color:tr.color,flexShrink:0}}/> : null}
                </div>
              );
            })}
          </div>
          <button onClick={()=>setShowStreak(false)} style={{...Sb.btnGhost,width:"100%",marginTop:14,fontSize:13}}>{t.closeWord||"Close"}</button>
        </div>
      </div>
    );
  })() : null;
  // Rank promotion: the full one-time celebration shown after a run that climbs
  // a tier (set only in onArenaEnd, so it never replays on reopen).
  const promotionEl = promotion ? (
    <RankPromotion fromIdx={promotion.fromIdx} toIdx={promotion.toIdx} best={promotion.best} t={t}
      onClose={() => setPromotion(null)}
      onSeeRanks={() => { setPromotion(null); setScreen("badges"); setShowRanks(true); }} />
  ) : null;
  // Shared group-invite confirmation (from a /app?join=CODE link).
  const joinPreviewEl = joinPreview ? (
    <div style={{position:"fixed",inset:0,zIndex:920,background:"rgba(0,0,0,0.6)",display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
      <div style={{background:"var(--color-background-primary)",borderRadius:18,padding:"22px 20px",maxWidth:340,width:"100%",textAlign:"center",boxShadow:"0 20px 50px rgba(0,0,0,0.45)"}}>
        <div style={{display:"flex",justifyContent:"center",marginBottom:12}}><GroupAvatar name={joinPreview.name} size={56}/></div>
        <div style={{fontSize:11,fontWeight:700,letterSpacing:.5,textTransform:"uppercase",color:"var(--color-text-tertiary)"}}>{t.groupInviteLabel||"Group invite"}</div>
        <div style={{fontSize:20,fontWeight:800,fontFamily:"'Fraunces',Georgia,serif",color:"var(--color-text-primary)",margin:"3px 0 4px",wordBreak:"break-word"}}>{joinPreview.name}</div>
        <div style={{fontSize:13,color:"var(--color-text-secondary)",marginBottom:18}}>{(t.membersCount||"{n} members").replace("{n}",joinPreview.members)}{joinPreview.already?` · ${t.alreadyMember||"you're already in"}`:""}</div>
        {joinPreview.already
          ? <button onClick={()=>{const id=joinPreview.id;setJoinPreview(null);openGroup(id);}} style={{...Sb.btnPrimary,width:"100%",fontSize:14}}>{t.openGroupWord||"Open group"}</button>
          : <button onClick={confirmJoinGroup} style={{...Sb.btnPrimary,width:"100%",fontSize:14}}>{t.joinGroupConfirm||"Join this group"}</button>}
        <button onClick={()=>{setJoinPreview(null);openSocial();}} style={{...Sb.btnGhost,width:"100%",marginTop:8,fontSize:13}}>{t.cancelWord||"Cancel"}</button>
      </div>
    </div>
  ) : null;
  // Transient social-notification pop-up (top of screen); tap to open Friends.
  const notifToastEl = notifToast ? (
    <div style={{position:"fixed",left:0,right:0,top:14,zIndex:910,display:"flex",justifyContent:"center",pointerEvents:"none",padding:"0 14px"}}>
      <div className="rv-badge-pop" onClick={()=>{setNotifToast(null);openSocial();}} style={{pointerEvents:"auto",cursor:"pointer",background:"var(--color-accent)",color:"#fff",borderRadius:12,padding:"10px 15px",boxShadow:"0 10px 28px rgba(67,56,202,0.4)",display:"inline-flex",alignItems:"center",gap:9,maxWidth:380,fontSize:13,fontWeight:700}}>
        <Icon name="users" size={17}/>{notifToast.text}
      </div>
    </div>
  ) : null;
  const flairRank = myRankInfo.index;
  const flairEquipped = srs.badges?.equipped || "";
  const flairPublic = srs.badges?.public !== false;
  useEffect(() => {
    if (!user) return;
    const payload = flairPublic ? { equipped: flairEquipped || null, rank: flairRank, xp: myXP } : { equipped: null, rank: -1, xp: -1 };
    const id = setTimeout(() => { socialApi("setBadge", payload); }, 700);
    return () => clearTimeout(id);
  }, [user, flairRank, flairEquipped, flairPublic, myXP]);

  const enableReminders = async () => {
    const p = await enableNotifications();
    setNotifPerm(p);
    // Immediate confirmation so the user sees notifications actually work.
    if (p === "granted") notify(t.notifOnTitle||"Reminders on", t.notifOnBody||"We'll nudge you to keep your streak and review what's due.");
  };
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
      {badgeToastEl}{rankToastEl}{streakToastEl}{notifToastEl}{burstConfetti&&<Confetti/>}
      {joinPreviewEl}{streakInfoEl}
      <AdBanners isPro={isPro}/>
      {upgraded && <div style={{position:"fixed",top:0,left:0,right:0,zIndex:800,background:"#16a34a",color:"#fff",textAlign:"center",padding:"11px 14px",fontSize:14,fontWeight:700,fontFamily:"inherit",boxShadow:"0 6px 18px rgba(35,31,26,0.16)"}}>{t.welcomePro}</div>}
      <div style={Sb.hero}>
        <div className="rv-hero-inner">
          <div className="rv-hero-top">
            <button onClick={()=>navigate("/")} title={t.mainSite} className="rv-hero-back" style={{background:"none",border:"none",cursor:"pointer",fontSize:13,color:"rgba(255,255,255,0.78)",fontFamily:"inherit",padding:0,fontWeight:500,display:"inline-flex",alignItems:"center",gap:5}}>← {t.mainSite}</button>
            <div className="rv-hero-tools">
              {authLoading ? (
                // Restoring the session: hold a placeholder so signed-in users
                // never see (or click) "Log in" before Clerk finishes loading.
                <span aria-hidden="true" style={{width:30,height:30,borderRadius:"50%",background:"rgba(255,255,255,0.18)",flexShrink:0}}/>
              ) : user ? (
                <>
                <button onClick={()=>openSettings()} title={t.accountLbl} aria-label={t.accountLbl}
                  style={{display:"inline-flex",alignItems:"center",gap:8,background:"none",border:"none",padding:0,cursor:"pointer",fontFamily:"inherit",flexShrink:0}}>
                  <span style={{position:"relative",width:30,height:30,borderRadius:"50%",overflow:"hidden",flexShrink:0,background:"rgba(255,255,255,0.22)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:13,fontWeight:700,color:"#fff",...(isPro?{boxShadow:"0 0 0 2px #fbbf24, 0 0 0 4px rgba(251,191,36,0.35)"}:{})}}>
                    {(username||user.email||"?").charAt(0).toUpperCase()}
                    {user.image && <img src={user.image} alt="" onError={(e)=>e.currentTarget.remove()} style={{position:"absolute",inset:0,width:"100%",height:"100%",objectFit:"cover"}}/>}
                  </span>
                  <span style={{fontSize:14,fontWeight:600,color:"#fff",maxWidth:104,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{username||user.email?.split("@")[0]||t.accountLbl}</span>
                </button>
                <button onClick={()=>setShowStreak(true)} title={t.streakWord||"Streak"} aria-label={t.streakWord||"Streak"}
                  style={{display:"inline-flex",alignItems:"center",background:"rgba(255,255,255,0.12)",border:"1px solid rgba(255,255,255,0.18)",borderRadius:999,padding:"3px 8px",cursor:"pointer",fontFamily:"inherit",flexShrink:0}}>
                  <StreakFlame count={stats.streak||0} size={16} showZero/>
                </button>
                <button onClick={()=>setScreen("badges")} title={t.badgesTitle||"Badges & rank"} aria-label={t.badgesTitle||"Badges & rank"}
                  style={{display:"inline-flex",alignItems:"center",gap:3,background:"rgba(255,255,255,0.12)",border:"1px solid rgba(255,255,255,0.18)",borderRadius:999,padding:"4px 9px",cursor:"pointer",fontFamily:"inherit",flexShrink:0}}>
                  <Icon name={RANKS[myRankInfo.index]?.icon} size={16} stroke={2} style={{color:"#fff"}}/>
                </button>
                </>
              ) : (
                <button onClick={()=>navigate("/login")} style={{background:"rgba(255,255,255,0.16)",color:"#fff",border:"1px solid rgba(255,255,255,0.3)",borderRadius:8,fontSize:12,fontWeight:600,padding:"7px 14px",cursor:"pointer",fontFamily:"inherit"}}>{t.logIn}</button>
              )}
            </div>
          </div>
          <div className="rv-hero-bar">
            <span style={{...Sb.brand,color:"#fff"}}><Logo/>{t.appName}
              {isPro && <span style={{marginLeft:7,padding:"2px 9px",borderRadius:999,fontSize:11,fontWeight:800,letterSpacing:0.8,color:"#422006",background:"linear-gradient(135deg,#fde68a,#f59e0b)",boxShadow:"0 2px 8px rgba(245,158,11,0.35)"}}>PRO</span>}
              <DevBadge/></span>
          </div>
          <h1 className="rv-hero-head" style={Sb.h1}>{t.tagline}</h1>
          <p className="rv-hero-sub" style={{fontSize:14,color:"var(--color-accent)",lineHeight:1.6,margin:0,maxWidth:300}}>{t.sub}</p>
          <button className="rv-hero-cta" style={Sb.btnHero} onClick={()=>setScreen("upload")}>{t.start}</button>
        </div>
      </div>

      <div className="rv-home-body" style={{padding:"20px 16px 32px"}}>
        {/* First-run starter library: until the learner has uploaded material of
            their own, give them a one-tap path to a real quiz on a ready-made
            topic, so the core loop lands before any upload. Disappears once they
            have their own material. Shown once ever (see showStarter one-shot). */}
        {/* Signed-out visitor: a real, instant taste of the loop (hand-written,
            no account, no AI call). Signed-in newcomers get the AI starter grid
            below instead. */}
        {!user && (
          <div style={{background:"linear-gradient(135deg,#4338ca,#6366f1)",borderRadius:16,padding:"18px",marginBottom:18,boxShadow:"0 6px 20px rgba(67,56,202,0.22)"}}>
            <div style={{fontWeight:800,fontSize:15.5,color:"#fff",marginBottom:3}}>{t.demoTitle||"Try a sample quiz"}</div>
            <div style={{fontSize:12.5,color:"rgba(255,255,255,0.85)",lineHeight:1.5,marginBottom:14}}>{t.demoSub||"See how Revyy works in 7 quick questions. No signup needed."}</div>
            <button onClick={startDemoQuiz} style={{background:"#fff",color:"#4338ca",border:"none",borderRadius:11,padding:"11px 20px",fontSize:14,fontWeight:800,cursor:"pointer",fontFamily:"inherit",boxShadow:"0 2px 10px rgba(0,0,0,0.14)"}}>{t.demoStart||"Start the sample →"}</button>
          </div>
        )}
        {showStarter && librarySize(srs.library)===0 && user && (
          <div style={{background:"linear-gradient(135deg,#4338ca,#6366f1)",borderRadius:16,padding:"18px 18px 16px",marginBottom:18,boxShadow:"0 6px 20px rgba(67,56,202,0.22)"}}>
            <div style={{fontWeight:800,fontSize:15.5,color:"#fff",marginBottom:3}}>{t.starterGoalTitle||"What are you studying for?"}</div>
            <div style={{fontSize:12.5,color:"rgba(255,255,255,0.85)",lineHeight:1.5,marginBottom:13}}>{t.starterSub||"One tap to a 10-question warm-up. No notes needed."}</div>
            <div style={{display:"flex",flexWrap:"wrap",gap:8,marginBottom:15}}>
              {STARTER_EXAMS.map(s=>(
                <button key={s.id} onClick={()=>startSampleQuiz(s)} style={{display:"inline-flex",alignItems:"center",gap:6,background:"rgba(255,255,255,0.16)",border:"1px solid rgba(255,255,255,0.26)",borderRadius:999,padding:"8px 13px",cursor:"pointer",fontFamily:"inherit",color:"#fff",fontSize:12.5,fontWeight:700}}>
                  <span aria-hidden="true">{s.emoji}</span>{s.title}
                </button>
              ))}
            </div>
            <div style={{fontSize:11,fontWeight:700,letterSpacing:0.4,textTransform:"uppercase",color:"rgba(255,255,255,0.65)",marginBottom:9}}>{t.starterSubjectsLabel||"Or try a subject"}</div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(140px,1fr))",gap:9}}>
              {STARTER_SUBJECTS.map(s=>(
                <button key={s.id} onClick={()=>startSampleQuiz(s)} style={{display:"flex",alignItems:"center",gap:9,background:"rgba(255,255,255,0.14)",border:"1px solid rgba(255,255,255,0.22)",borderRadius:11,padding:"11px 12px",cursor:"pointer",fontFamily:"inherit",textAlign:"left",color:"#fff"}}>
                  <span style={{fontSize:20,flexShrink:0}} aria-hidden="true">{s.emoji}</span>
                  <span style={{minWidth:0}}>
                    <span style={{display:"-webkit-box",WebkitLineClamp:2,WebkitBoxOrient:"vertical",overflow:"hidden",fontSize:13,fontWeight:700,lineHeight:1.2}}>{s.title}</span>
                    <span style={{display:"block",fontSize:10.5,color:"rgba(255,255,255,0.75)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",marginTop:1}}>{s.subject}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
        {/* Daily goal: a reachable target + the streak, the day-2 return hook.
            Shown once the learner has started (a fresh user sees the chooser). */}
        {hasStarted && (
          <div style={{display:"flex",alignItems:"center",gap:14,background:dailyMet?"linear-gradient(135deg,var(--color-text-success),#22c55e)":"var(--color-background-primary)",border:dailyMet?"none":"1px solid var(--color-border-secondary)",borderRadius:14,padding:"14px 16px",marginBottom:18,boxShadow:dailyMet?"0 4px 14px rgba(34,197,94,0.22)":"none"}}>
            <svg width="56" height="56" viewBox="0 0 56 56" style={{flexShrink:0}} aria-hidden="true">
              <circle cx="28" cy="28" r="22" fill="none" stroke={dailyMet?"rgba(255,255,255,0.3)":"var(--color-background-secondary)"} strokeWidth="6"/>
              <circle cx="28" cy="28" r="22" fill="none" stroke={dailyMet?"#fff":"var(--color-accent)"} strokeWidth="6" strokeLinecap="round" strokeDasharray="138.2" strokeDashoffset={138.2*(1-dailyPct/100)} transform="rotate(-90 28 28)"/>
              <text x="28" y="28" textAnchor="middle" dominantBaseline="central" fontSize="15" fontWeight="800" fill={dailyMet?"#fff":"var(--color-text-primary)"} fontFamily="inherit">{dailyMet?"✓":dailyToday}</text>
            </svg>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontWeight:700,fontSize:14,color:dailyMet?"#fff":"var(--color-text-primary)"}}>{dailyMet?(t.dailyGoalDone||"Daily goal done!"):(t.dailyGoalTitle||"Daily goal")}</div>
              <div style={{fontSize:11.5,marginTop:2,lineHeight:1.4,color:dailyMet?"rgba(255,255,255,0.9)":"var(--color-text-secondary)",display:"flex",alignItems:"center",gap:5,flexWrap:"wrap"}}>
                {dailyMet ? (
                  (stats.streak||0)>0
                    ? <><StreakFlame count={stats.streak} size={15} showCount={false}/><span>{(t.dailyStreakSafe||"{s}-day streak, safe for today").replace("{s}",stats.streak)}</span></>
                    : <span>{t.dailyDoneNoStreak||"Nice. Come back tomorrow to start a streak."}</span>
                ) : (
                  <><span>{(t.dailyGoalProgress||"{n} of {g} questions today").replace("{n}",dailyToday).replace("{g}",DAILY_GOAL)}</span>{(stats.streak||0)>0 && <><span aria-hidden="true">·</span><StreakFlame count={stats.streak} size={15} showCount={false}/><span>{(t.dailyStreakKeep||"{s}-day streak").replace("{s}",stats.streak)}</span></>}</>
                )}
              </div>
            </div>
          </div>
        )}
        {/* Quick-nav tiles: friends, badges, leaderboard side by side (wrap on
            mobile) so they read as a compact dashboard, not a tall stack. Shown
            to everyone (incl. new users) so features like Friends are reachable
            straight away, the app is feature-rich but stays easy to scan. */}
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(190px,1fr))",gap:12,marginBottom:18}}>
          <div onClick={openSocial} className="rv-tile" style={Sb.navTile}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:6}}>
              <Medallion color="#14b8a6"><Icon name="users" size={20}/></Medallion>
              <NotifBubble n={unread.total}/>
            </div>
            <div style={{minWidth:0}}>
              <div style={Sb.navTileTitle}>{t.socialTitle||"Friends & Groups"}</div>
              <div style={Sb.navTileSub}>{t.socialTileSub||"Study together, compare progress"}</div>
            </div>
          </div>
          <div onClick={()=>setScreen("badges")} className="rv-tile" style={Sb.navTile}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:6}}>
              <Medallion color={RANKS[myRankInfo.index]?.color||"#4338ca"}><Icon name={RANKS[myRankInfo.index]?.icon} size={19} stroke={2}/></Medallion>
            </div>
            <div style={{minWidth:0}}>
              <div style={Sb.navTileTitle}>{t.badgesTitle||"Badges & rank"}</div>
              <div style={{...Sb.navTileSub,display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}><RankPill index={myRankInfo.index} t={t} small/> {earnedBadgeCount}/{BADGES.length}</div>
            </div>
          </div>
          {globalUnlocked && (
          <div onClick={()=>{ if(requireLogin()) return; openGlobalBoard(); }} className="rv-tile" style={Sb.navTile}>
            <Medallion color="#f59e0b"><span style={{fontSize:18}}>🏆</span></Medallion>
            <div style={{minWidth:0}}>
              <div style={Sb.navTileTitle}>{t.globalBoardTitle||"Global leaderboard"}</div>
              <div style={Sb.navTileSub}>{t.globalTileSub||"Top 100 by rank, best of the best"}</div>
            </div>
          </div>
          )}
          {leagueUnlocked && (
          <div onClick={()=>{ if(requireLogin()) return; openLeague(); }} className="rv-tile" style={Sb.navTile}>
            <Medallion color="#7c3aed"><Icon name="trophy" size={18}/></Medallion>
            <div style={{minWidth:0}}>
              <div style={Sb.navTileTitle}>{t.leagueTitle||"Weekly League"}</div>
              <div style={Sb.navTileSub}>{t.leagueTileSub||"Race your cohort, promote each week"}</div>
            </div>
          </div>
          )}
        </div>
        {/* Smart Review, spaced repetition of missed questions + exam countdown */}
        <div style={{background:srs.dueCount>0?"linear-gradient(135deg,#4338ca,#6366f1)":"var(--color-background-primary)",border:srs.dueCount>0?"none":"1px solid var(--color-border-secondary)",borderRadius:14,padding:"14px 16px",marginBottom:18,boxShadow:srs.dueCount>0?"0 4px 14px rgba(67,56,202,0.2)":"none"}}>
          <div style={{display:"flex",alignItems:"center",gap:12}}>
            {srs.dueCount>0 ? <span style={{flexShrink:0,display:"flex",color:"#fff"}}><Icon name="repeat" size={23}/></span> : <Medallion color="#4338ca"><Icon name="repeat" size={20}/></Medallion>}
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
          <div style={{background:"var(--color-background-primary)",border:"1px solid var(--color-border-secondary)",borderRadius:14,padding:"14px 16px",marginBottom:18}}>
            <div onClick={()=>toggleCard("mastery")} style={{display:"flex",alignItems:"center",gap:10,marginBottom:openCard.mastery?12:0,cursor:"pointer"}}>
              <Medallion color="#3b82f6" size={36}><Icon name="chart" size={19}/></Medallion>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontWeight:700,fontSize:14,color:"var(--color-text-primary)"}}>{t.masteryTitle}</div>
                <div style={{fontSize:11.5,marginTop:1,color:"var(--color-text-secondary)"}}>{t.masterySub}</div>
              </div>
              <span style={{flexShrink:0,color:"var(--color-text-tertiary)",display:"flex",transition:"transform .2s",transform:openCard.mastery?"rotate(-90deg)":"rotate(90deg)"}}><Icon name="chevron" size={16}/></span>
            </div>
            {openCard.mastery && (<>
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
            </>)}
          </div>
        )}
        {/* Phase 3: study library, a memory of everything uploaded (summaries
            only), with a one-tap cumulative "quiz me on everything" review. */}
        {librarySize(srs.library)>0 && (
          <div style={{background:"var(--color-background-primary)",border:"1px solid var(--color-border-secondary)",borderRadius:14,padding:"14px 16px",marginBottom:18}}>
            <div onClick={()=>toggleCard("library")} style={{display:"flex",alignItems:"center",gap:10,marginBottom:openCard.library?12:0,cursor:"pointer"}}>
              <Medallion color="#10b981" size={36}><Icon name="layers" size={19}/></Medallion>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontWeight:700,fontSize:14,color:"var(--color-text-primary)"}}>{t.libraryTitle}</div>
                <div style={{fontSize:11.5,marginTop:1,color:"var(--color-text-secondary)"}}>{t.librarySets.replace("{n}",librarySize(srs.library)).replace("{s}",librarySize(srs.library)>1?"s":"")}</div>
              </div>
              <span style={{flexShrink:0,color:"var(--color-text-tertiary)",display:"flex",transition:"transform .2s",transform:openCard.library?"rotate(-90deg)":"rotate(90deg)"}}><Icon name="chevron" size={16}/></span>
            </div>
            {openCard.library && (<>
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
            </>)}
          </div>
        )}
        {/* #8: challenge activity, who took the quizzes this user shared, and
            whether they beat the sender's score, to keep the rivalry going. */}
        {challenges.length>0 && (
          <div style={{background:"var(--color-background-primary)",border:"1px solid var(--color-border-secondary)",borderRadius:14,padding:"14px 16px",marginBottom:18}}>
            <div onClick={()=>toggleCard("chalAct")} style={{display:"flex",alignItems:"center",gap:10,cursor:"pointer"}}>
              <Medallion color="#d97706" size={36}><Icon name="trophy" size={19}/></Medallion>
              <div style={{flex:1,minWidth:0,fontWeight:700,fontSize:14,color:"var(--color-text-primary)"}}>{t.challengeActivity}</div>
              <span style={{flexShrink:0,color:"var(--color-text-tertiary)",display:"flex",transition:"transform .2s",transform:openCard.chalAct?"rotate(-90deg)":"rotate(90deg)"}}><Icon name="chevron" size={16}/></span>
            </div>
            {openCard.chalAct && <div style={{marginTop:12}}>{challenges.slice(0,4).map((c)=>{
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
                        {beat!=null && <span style={{flexShrink:0,fontSize:10,fontWeight:700,padding:"1px 7px",borderRadius:999,color:beat?"var(--color-text-danger)":"var(--color-text-success)",background:beat?"var(--color-background-danger)":"var(--color-background-success)",border:`0.5px solid ${beat?"var(--color-border-danger)":"var(--color-border-success)"}`}}>{beat?t.challengeBeat:t.challengeAhead}</span>}
                      </div>
                    );
                  })}
                </div>
              );
            })}</div>}
          </div>
        )}
        {/* AI Study Coach, day-by-day exam plan */}
        {!homePlan ? (
          <div style={{background:"var(--color-background-primary)",border:"1px solid var(--color-border-secondary)",borderRadius:14,padding:"14px 16px",marginBottom:18}}>
            <div style={{display:"flex",alignItems:"center",gap:12}}>
              <Medallion color="#8b5cf6"><Icon name="compass" size={20}/></Medallion>
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
            <div style={{background:due?"linear-gradient(135deg,#4338ca,#6366f1)":"var(--color-background-primary)",border:due?"none":"1px solid var(--color-border-secondary)",borderRadius:14,padding:"14px 16px",marginBottom:18,boxShadow:due?"0 4px 14px rgba(67,56,202,0.2)":"none"}}>
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
              <div style={{width:"100%",marginTop:10,fontSize:13,fontWeight:700,color:"#fff",textAlign:"center",padding:"10px",borderRadius:10,background:"linear-gradient(135deg,#16a34a,var(--color-text-success))",boxShadow:"0 2px 10px rgba(22,163,74,0.3)"}}>{t.youArePro}</div>
            ) : (
              <button style={{...Sb.btnPrimary,width:"100%",marginTop:10,fontSize:13,background:"#f59e0b",color:"#fff"}} onClick={()=>{if(requireLogin())return;setCoErr("");setShowProModal(true);}}>{t.upgrade}</button>
            )}
          </div>
        </div>
      </div>
      {showProModal && <ProModal onClose={()=>{setShowProModal(false);setCoErr("");}} t={t} onMonthly={()=>doCheckout(STRIPE_MONTHLY_PRICE,"monthly")} onYearly={()=>doCheckout(STRIPE_YEARLY_PRICE,"yearly")} busy={coBusy} error={coErr}/>}
      {showSettings && <SettingsPanel draft={settingsDraft} update={updateDraft} onApply={applySettings} onCancel={cancelSettings} onSignOut={()=>signOut()} onDeleteAccount={confirmDeleteAccount} requiresPassword={requiresPassword} onReauthenticate={reauthenticate} isPro={isPro} onManageSubscription={openPortal} signedIn={!!user} onOpenBadges={()=>{setShowSettings(false);setScreen("badges");}} onOpenStreak={()=>{setShowSettings(false);setScreen("home");setShowStreak(true);}} onOpenAccuracy={()=>{setShowSettings(false);setScreen("home");setOpenCard(c=>({...c,mastery:true}));}} onOpenReview={()=>{setShowSettings(false);if(srs.dueCards.length)startReview();else startQuick10();}} t={t}/>}
      <ResumeModal info={examResume} onResume={resumeExam} onDiscard={discardResume} fmtClock={fmtClock}/>
    </div>
  );

  // ── UPLOAD ───────────────────────────────────────────────────────
  if (screen==="upload") return (
    <div style={Sb.root}><style>{CSS}</style>
      <AdBanners isPro={isPro}/>
      {upgraded && <div style={{position:"fixed",top:0,left:0,right:0,zIndex:800,background:"#16a34a",color:"#fff",textAlign:"center",padding:"11px 14px",fontSize:14,fontWeight:700,fontFamily:"inherit",boxShadow:"0 6px 18px rgba(35,31,26,0.16)"}}>{t.welcomePro}</div>}
      <div style={Sb.topbar} className="rv-topbar">
        <button style={Sb.backBtn} onClick={()=>setScreen("home")}>← {t.homeWord}</button>
        <span style={Sb.brand}>{t.appName}</span>
        <div style={{display:"flex",alignItems:"center",gap:6}}>
          {isPro && <span style={{fontSize:10,background:"#f59e0b",color:"#fff",borderRadius:8,padding:"2px 7px",fontWeight:700}}>PRO</span>}
          <button onClick={()=>setSoundOn(s=>!s)} title={soundOn?t.soundOn:t.soundOff} style={{background:"none",border:"none",cursor:"pointer",padding:"2px 4px",display:"flex",alignItems:"center",color:"var(--color-text-secondary)",opacity:soundOn?1:0.4}}><Icon name="volume" size={17}/></button>
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
        <div style={{marginBottom:16}}>
          <Segmented value={tab} onChange={(o)=>setTab(o.value)} options={[
            {value:"file",label:stripEmoji(t.tabs[0]),icon:TAB_ICONS.file},
            {value:"text",label:stripEmoji(t.tabs[1]),icon:TAB_ICONS.text},
            {value:"photo",label:stripEmoji(t.tabs[3]),icon:TAB_ICONS.photo},
            {value:"media",label:stripEmoji(t.mediaTab),icon:TAB_ICONS.media,locked:!isPro},
          ]}/>
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
              <div key={i} style={{display:"flex",alignItems:"center",gap:8,background:"var(--color-sel-tint)",border:"1px solid var(--color-accent)",borderRadius:9,padding:"8px 11px",marginBottom:6}}>
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
        {error && <div style={{background:"var(--color-background-danger)",border:"0.5px solid #fecaca",borderRadius:10,padding:"10px 14px",fontSize:13,color:"var(--color-text-danger)",marginBottom:14,lineHeight:1.5,display:"flex",alignItems:"flex-start",gap:7}}><Icon name="alert" size={15} style={{flexShrink:0,marginTop:1}}/><span>{error}</span></div>}
        {limitHit && <button onClick={()=>setShowPacks(true)} style={{...Sb.btnPrimary,width:"100%",marginBottom:14,background:"#4338ca",display:"inline-flex",alignItems:"center",justifyContent:"center",gap:7}}><Icon name="gem" size={16}/>{t.getMoreQuestions}</button>}
        </div>
        <div className="rv-ul-right">
        <div style={Sb.settingsBox}>
          <div style={{...Sb.settingRow,flexDirection:"column",alignItems:"stretch",gap:10}}>
            <span style={Sb.settingLabel}>{t.quizType}</span>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
              {QUIZ_TYPES.map(type=>{
                const unlocked = canUseQType(type);
                const active = qType===type;
                return (
                  <button key={type} onClick={()=>{ if(unlocked) setQType(type); else if(type==="written"||type==="diagram") setShowProModal(true); else setUnlockFeature(QTYPE_FEATURE[type]); }} style={{
                    display:"inline-flex",alignItems:"center",justifyContent:"center",gap:7,padding:"11px 8px",
                    border:active?"1.5px solid var(--color-accent)":"1px solid var(--color-border-secondary)",
                    borderRadius:11,cursor:"pointer",fontFamily:"inherit",fontSize:12.5,fontWeight:600,
                    background:active?"var(--color-sel-tint)":"var(--color-background-primary)",
                    color:active?"var(--color-accent)":"var(--color-text-secondary)",transition:"all 0.15s",
                  }}>
                    <Icon name={QT_ICON[type]} size={15} style={{flexShrink:0}}/>
                    <span>{t.quizTypes[type]}</span>
                    {!unlocked && <Icon name="lock" size={11} style={{opacity:0.6,flexShrink:0}}/>}
                  </button>
                );
              })}
            </div>
            {t.quizTypeDesc?.[qType] && <div style={{fontSize:11.5,color:"var(--color-text-tertiary)",lineHeight:1.5}}>{t.quizTypeDesc[qType]}</div>}
          </div>
          <div style={{...Sb.settingRow,flexDirection:"column",alignItems:"flex-start",gap:8}}>
            <div style={{display:"flex",justifyContent:"space-between",width:"100%",alignItems:"center"}}>
              <span style={Sb.settingLabel}>{t.questions}</span>
              <span style={{fontWeight:700,fontSize:14,color:"var(--color-accent)",minWidth:32,textAlign:"right"}}>{Math.min(numQ,qMax())}</span>
            </div>
            {/* Pro/unlocked: step the slider by 1 and reveal a type-in box. */}
            {canCustomQ()&&(
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",width:"100%"}}>
                <span style={{fontSize:12,color:"var(--color-text-secondary)"}}>{t.customAmount}</span>
                <Toggle on={useCustomQ} onChange={v=>{setUseCustomQ(v); if(v) setCustomQ(String(Math.min(numQ,qMax())));}}/>
              </div>
            )}
            <div style={{width:"100%",paddingRight:2}}>
              <div style={{display:"flex",gap:10,alignItems:"center"}}>
                <input type="range"
                  min={useCustomQ&&canCustomQ()?1:Math.min(5,qMax())} max={qMax()} step={useCustomQ&&canCustomQ()?1:5}
                  value={Math.min(numQ,qMax())}
                  onChange={e=>{const v=parseInt(e.target.value);setImportCount(null);setNumQ(v);setCustomQ(String(v));if(!canCustomQ())setUseCustomQ(false);}}
                  style={{flex:1,accentColor:"#4338ca",cursor:"pointer"}}
                />
                {useCustomQ&&canCustomQ()&&(
                  <input type="number" min={1} max={qMax()} inputMode="numeric" value={customQ}
                    onChange={e=>{const s=e.target.value.replace(/[^0-9]/g,"").slice(0,3);setImportCount(null);setCustomQ(s);const n=parseInt(s,10);if(!isNaN(n))setNumQ(Math.min(Math.max(n,1),qMax()));}}
                    onBlur={e=>{const n=Math.min(Math.max(parseInt(e.target.value,10)||1,1),qMax());setCustomQ(String(n));setNumQ(n);}}
                    style={{width:58,borderRadius:8,border:"1.5px solid var(--color-border-secondary)",background:"var(--color-background-primary)",color:"var(--color-text-primary)",fontSize:14,padding:"8px 6px",fontFamily:"inherit",outline:"none",boxSizing:"border-box",textAlign:"center"}}/>
                )}
              </div>
              <div style={{display:"flex",justifyContent:"space-between",fontSize:10,color:"var(--color-text-tertiary)",marginTop:2}}>
                <span>{useCustomQ&&canCustomQ()?1:Math.min(5,qMax())}</span>
                <span style={{color:(!isPro&&!unlocks.isUnlocked("questions"))?"#f59e0b":"var(--color-text-tertiary)"}}>
                  {qMax()}{!isPro&&!unlocks.isUnlocked("questions")?" "+t.freeMax:""}{!isPro&&unlocks.isUnlocked("questions")?` · ${unlocks.remainingLabel("questions")}`:""}
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
          <div style={{...Sb.settingRow,flexDirection:"column",alignItems:"stretch",gap:10}}>
            <span style={Sb.settingLabel}>{t.difficulty}</span>
            <Segmented value={diff} onChange={(o)=>pickDiff(o.value)}
              options={t.diffOpts.map((d,i)=>({value:i,label:d,rec:diffRec.confidence>=0.6&&diffRec.diff===i}))}/>
          </div>
          {t.diffDesc?.[diff] && <div style={{fontSize:11,color:"var(--color-text-tertiary)",lineHeight:1.45,padding:"2px 2px 0",textAlign:"right"}}>{t.diffDesc[diff]}</div>}
          {/* Adaptive difficulty (Phase 1): once there's enough history, show the
              level the student model recommends and why. When the picker isn't
              already on it (learner overrode), offer a one-tap switch. */}
          {diffRec.confidence>=0.6 && (
            <div style={{display:"flex",alignItems:"center",gap:8,marginTop:9,background:"var(--color-sel-tint)",border:"1px solid var(--color-accent)",borderRadius:10,padding:"8px 11px"}}>
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
        {/* Other ways to study: one consistent, scannable set */}
        <p style={{...Sb.secLabel,margin:"2px 0 9px"}}>{t.otherWays||"More ways to study"}</p>
        {(() => {
          const tileShell = {display:"flex",flexDirection:"column",gap:9,background:"var(--color-background-primary)",border:"1px solid var(--color-border-secondary)",borderRadius:14,padding:"13px 12px",transition:"all 0.15s"};
          const tile = {width:36,height:36,borderRadius:10,flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center",background:"var(--color-sel-tint)",color:"var(--color-accent)"};
          const ttl = {fontWeight:700,fontSize:13,color:"var(--color-text-primary)",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"};
          const sub = {fontSize:10.5,color:"var(--color-text-secondary)",marginTop:2,lineHeight:1.35,display:"-webkit-box",WebkitLineClamp:2,WebkitBoxOrient:"vertical",overflow:"hidden"};
          const pill = (bg) => ({fontSize:9.5,fontWeight:700,borderRadius:8,padding:"2px 7px",flexShrink:0,whiteSpace:"nowrap",color:"#fff",background:bg});
          const examUsed = !isPro && unlocks.examUsedToday();
          return (
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(120px,1fr))",gap:10,marginBottom:14}}>
              {/* Exam mode */}
              <div onClick={isPro?()=>setScreen("exam_setup"):(examUsed?undefined:enterExamMode)} style={{...tileShell,cursor:examUsed?"default":"pointer",opacity:examUsed?0.6:1}}>
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:6}}>
                  <span style={tile}><Icon name="cap" size={18}/></span>
                  <span style={pill(isPro?"#4338ca":examUsed?"#8a8478":unlocks.examUnlocked()?"#4338ca":"#b5502f")}>{isPro?t.badgeUnlimited:examUsed?t.examBadgeUsed:unlocks.examUnlocked()?t.examBadgeReady:t.examBadgeFree}</span>
                </div>
                <div style={{minWidth:0}}>
                  <div style={ttl}>{stripEmoji(t.examModeLabel)}</div>
                  <div style={sub}>{isPro?(t.examUnlimitedSub||"Unlimited custom exams"):(examAdBusy?t.loadingAd:examUsed?t.examAdUsed:unlocks.examUnlocked()?t.examAdUnlocked:t.examAdWatch)}</div>
                </div>
              </div>
              {/* Mock exams */}
              <div onClick={()=>{ if(requireLogin())return; setMockGenErr(""); setScreen("mock_select"); }} style={{...tileShell,cursor:"pointer"}}>
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:6}}>
                  <span style={tile}><Icon name="cap" size={18}/></span>
                  {!isPro && <span style={pill("#f59e0b")}>PRO</span>}
                </div>
                <div style={{minWidth:0}}>
                  <div style={ttl}>{t.mockCardTitle}</div>
                  <div style={sub}>{t.mockCardSub}</div>
                </div>
              </div>
              {/* Endless Arena */}
              <div onClick={openArena} style={{...tileShell,cursor:"pointer"}}>
                <span style={tile}><Icon name="bolt" size={18}/></span>
                <div style={{minWidth:0}}>
                  <div style={ttl}>{t.arenaEntry}</div>
                  <div style={sub}>{t.arenaEntrySub}</div>
                </div>
              </div>
            </div>
          );
        })()}
        <button style={{...Sb.btnPrimary,width:"100%"}} onClick={generate}>{t.generate}</button>
        </div>
      </div>
      <UnlockModal feature={unlockFeature} unlocks={unlocks} t={t}
        onClose={()=>setUnlockFeature(null)} onUpgrade={openUpgrade}/>
      {showProModal&&<ProModal onClose={()=>{setShowProModal(false);setCoErr("");}} t={t} onMonthly={()=>doCheckout(STRIPE_MONTHLY_PRICE,"monthly")} onYearly={()=>doCheckout(STRIPE_YEARLY_PRICE,"yearly")} busy={coBusy} error={coErr}/>}
      {showUsername && <UsernameModal value={unameInput} onChange={setUnameInput} onSave={submitUsername} onSkip={skipUsername} err={unameErr} busy={unameBusy} t={t}/>}
      {showQuizlet && (
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.6)",zIndex:500,display:"flex",alignItems:"flex-end"}} onClick={()=>!quizletBusy&&setShowQuizlet(false)}>
          <div className="slide-up" onClick={e=>e.stopPropagation()} style={{background:"var(--color-background-primary)",borderRadius:"20px 20px 0 0",padding:"24px 20px 32px",width:"100%",maxWidth:520,margin:"0 auto",boxSizing:"border-box",maxHeight:"88vh",overflowY:"auto"}}>
            <div style={{display:"flex",alignItems:"center",gap:9,marginBottom:6}}><Icon name="upload" size={20} style={{color:"var(--color-accent)"}}/><h3 style={{margin:0,fontSize:18,fontWeight:700,fontFamily:"'Fraunces',Georgia,serif",color:"var(--color-text-primary)"}}>{t.qzTitle}</h3></div>
            <p style={{margin:"0 0 12px",fontSize:12.5,color:"var(--color-text-secondary)",lineHeight:1.5}}>{t.qzHow}</p>
            <textarea value={quizletText} onChange={e=>{setQuizletText(e.target.value);setQuizletErr("");}} placeholder={t.qzPaste} style={{...Sb.textarea,minHeight:120}}/>
            <div style={{fontSize:12,color:"var(--color-text-tertiary)",marginTop:6}}>{t.qzFound.replace("{n}",quizletCards.length).replace("{s}",quizletCards.length===1?"":"s")}</div>
            {quizletErr && <div style={{background:"var(--color-background-danger)",border:"0.5px solid #fecaca",borderRadius:10,padding:"9px 12px",fontSize:12.5,color:"var(--color-text-danger)",marginTop:10,display:"flex",alignItems:"flex-start",gap:7}}><Icon name="alert" size={14} style={{flexShrink:0,marginTop:1}}/><span>{quizletErr}</span></div>}
            <button onClick={importQuizlet} disabled={quizletBusy||!quizletCards.length} style={{...Sb.btnPrimary,width:"100%",marginTop:14,opacity:(quizletBusy||!quizletCards.length)?0.5:1,cursor:(quizletBusy||!quizletCards.length)?"not-allowed":"pointer"}}>{quizletBusy?t.qzImporting:t.qzImportBtn.replace("{n}",quizletCards.length).replace("{s}",quizletCards.length===1?"":"s")}</button>
            <button onClick={()=>!quizletBusy&&setShowQuizlet(false)} style={{width:"100%",marginTop:8,background:"none",border:"none",color:"var(--color-text-tertiary)",fontSize:13,cursor:"pointer",fontFamily:"inherit",padding:"6px"}}>{t.cancel}</button>
          </div>
        </div>
      )}
      {showPacks&&<PacksModal onClose={()=>setShowPacks(false)} buyPack={buyPack} t={t}/>}
      {showSettings&&<SettingsPanel draft={settingsDraft} update={updateDraft} onApply={applySettings} onCancel={cancelSettings} onSignOut={()=>signOut()} onDeleteAccount={confirmDeleteAccount} requiresPassword={requiresPassword} onReauthenticate={reauthenticate} isPro={isPro} onManageSubscription={openPortal} signedIn={!!user} onOpenBadges={()=>{setShowSettings(false);setScreen("badges");}} onOpenStreak={()=>{setShowSettings(false);setScreen("home");setShowStreak(true);}} onOpenAccuracy={()=>{setShowSettings(false);setScreen("home");setOpenCard(c=>({...c,mastery:true}));}} onOpenReview={()=>{setShowSettings(false);if(srs.dueCards.length)startReview();else startQuick10();}} t={t}/>}
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
      {upgraded && <div style={{position:"fixed",top:0,left:0,right:0,zIndex:800,background:"#16a34a",color:"#fff",textAlign:"center",padding:"11px 14px",fontSize:14,fontWeight:700,fontFamily:"inherit",boxShadow:"0 6px 18px rgba(35,31,26,0.16)"}}>{t.welcomePro}</div>}
        <div style={Sb.topbar} className="rv-topbar"><button style={Sb.backBtn} onClick={()=>setShowExitConfirm(true)}>{t.exit}</button><span style={{fontSize:12,fontWeight:600,color:"var(--color-text-secondary)"}}>{quiz.title}</span><span/></div>
        <div className="rv-center-narrow" style={{padding:"20px 16px 32px"}}><MatchQuiz questions={quiz.questions} t={t} onDone={(s,total,detail)=>{setAnswers(detail||Array(total).fill(0).map((_,i)=>({isCorrect:i<s})));setScreen("results");}}/></div>
        <ExitModal show={showExitConfirm} onStay={()=>setShowExitConfirm(false)} onLeave={()=>{setShowExitConfirm(false);newMat();}}/>
        <button onClick={openSettings} title={t.set?.title||"Settings"} aria-label={t.set?.title||"Settings"} style={{position:"fixed",left:12,bottom:58,zIndex:400,width:38,height:38,borderRadius:"50%",background:"var(--color-background-secondary)",border:"0.5px solid var(--color-border-secondary)",color:"var(--color-text-secondary)",cursor:"pointer",fontFamily:"inherit",display:"inline-flex",alignItems:"center",justifyContent:"center",boxShadow:"0 4px 14px rgba(35,31,26,0.13)"}}><Icon name="gear" size={17}/></button>
        <button onClick={()=>setShowBugReport(true)} title={t.reportTitle} aria-label={t.reportTitle} style={{position:"fixed",left:12,bottom:12,zIndex:400,width:38,height:38,borderRadius:"50%",background:"var(--color-background-secondary)",border:"0.5px solid var(--color-border-secondary)",color:"var(--color-text-secondary)",cursor:"pointer",fontFamily:"inherit",display:"inline-flex",alignItems:"center",justifyContent:"center",boxShadow:"0 4px 14px rgba(35,31,26,0.13)"}}><Icon name="chat" size={17}/></button>
        {showBugReport && <ContactModal defaultEmail={user?.email||""} onClose={()=>setShowBugReport(false)} t={t}/>}
        {showSettings && <SettingsPanel draft={settingsDraft} update={updateDraft} onApply={applySettings} onCancel={cancelSettings} onSignOut={()=>signOut()} onDeleteAccount={confirmDeleteAccount} requiresPassword={requiresPassword} onReauthenticate={reauthenticate} isPro={isPro} onManageSubscription={openPortal} signedIn={!!user} onOpenBadges={()=>{setShowSettings(false);setScreen("badges");}} onOpenStreak={()=>{setShowSettings(false);setScreen("home");setShowStreak(true);}} onOpenAccuracy={()=>{setShowSettings(false);setScreen("home");setOpenCard(c=>({...c,mastery:true}));}} onOpenReview={()=>{setShowSettings(false);if(srs.dueCards.length)startReview();else startQuick10();}} t={t}/>}
      </div>
    );
    return (
      <div style={Sb.root}><style>{CSS}</style>
      <AdBanners isPro={isPro}/>
      {upgraded && <div style={{position:"fixed",top:0,left:0,right:0,zIndex:800,background:"#16a34a",color:"#fff",textAlign:"center",padding:"11px 14px",fontSize:14,fontWeight:700,fontFamily:"inherit",boxShadow:"0 6px 18px rgba(35,31,26,0.16)"}}>{t.welcomePro}</div>}
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
          {quiz.type==="written"&&<WrittenAnswer key={qIdx} q={q} isLast={isLast} t={t} subject={quiz.subject} onNext={(ok,detail)=>{const u=[...answers,{isCorrect:ok,...detail}];setAnswers(u);setSelected(null);if(qIdx+1>=quiz.questions.length)setScreen("results");else setQIdx(i=>i+1);}}/>}
          {(quiz.type==="mcq"||quiz.type==="diagram")&&(
            <>
              {quiz.type==="diagram" && quiz.diagramImg && (
                <div style={{display:"flex",justifyContent:"center",margin:"0 0 16px"}}>
                  <div style={{position:"relative",display:"inline-block",maxWidth:"100%"}}>
                    <img alt="Diagram" src={quiz.diagramImg} style={{display:"block",maxWidth:"100%",maxHeight:360,borderRadius:10,border:"0.5px solid var(--color-border-tertiary)"}}/>
                    {typeof q.x==="number"&&typeof q.y==="number"&&<span style={{position:"absolute",left:q.x+"%",top:q.y+"%",width:28,height:28,marginLeft:-14,marginTop:-14,borderRadius:"50%",border:"3px solid #ff3b30",boxShadow:"0 0 0 2px #fff, 0 0 10px rgba(0,0,0,0.5)",pointerEvents:"none"}}/>}
                  </div>
                </div>
              )}
              <h3 style={{fontFamily:"'Fraunces',Georgia,serif",fontSize:19,fontWeight:700,color:"var(--color-text-primary)",lineHeight:1.4,margin:0}}>{q.question}<SourceMark source={q.source} label={t.srcSeeQuestion} t={t}/></h3>
              <div style={{display:"flex",flexDirection:"column",gap:9,marginTop:20}}>
                {q.options.map((opt,i)=>{
                  if(quizElim.includes(i)) return <div key={i} style={{height:54,borderRadius:14,border:"1px dashed var(--color-border-tertiary)",opacity:0.35}}/>;
                  const isChosen=selected===i,isCorrect=q.correct===i;
                  let extra={};
                  if(selected!==null){
                    // Instant: reveal right/wrong. At-end: just mark the picked
                    // option (no correctness shown until the results review).
                    if(instant){if(isCorrect)extra={border:"1.5px solid #22c55e",background:"var(--color-background-success)",color:"var(--color-text-success)"};else if(isChosen)extra={border:"1.5px solid #ef4444",background:"var(--color-background-danger)",color:"var(--color-text-danger)"};else extra={opacity:0.45};}
                    else if(isChosen)extra={border:"1.5px solid #4338ca",background:"var(--color-sel-tint)"};
                    else extra={opacity:0.55};
                  }
                  return <button key={i} onClick={()=>pick(i)} disabled={selected!==null} className={selected===null?"quiz-opt":""} style={{display:"flex",alignItems:"center",gap:12,background:"var(--color-background-primary)",border:"1.5px solid var(--color-border-secondary)",borderRadius:14,padding:"14px 15px",cursor:selected!==null?"default":"pointer",fontSize:14,color:"var(--color-text-primary)",fontFamily:"inherit",transition:"all 0.18s",...extra}}>
                    <span style={{width:28,height:28,borderRadius:"50%",background:"var(--color-background-secondary)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,fontWeight:700,flexShrink:0}}>{LETTERS[i]}</span>
                    <span style={{flex:1,textAlign:"left",lineHeight:1.4}}>{opt}</span>
                    {instant&&selected!==null&&isCorrect&&<Icon name="check" size={17} stroke={2.6} style={{color:"#16a34a",flexShrink:0}}/>}{instant&&selected!==null&&isChosen&&!isCorrect&&<Icon name="x" size={17} stroke={2.6} style={{color:"#dc2626",flexShrink:0}}/>}
                  </button>;
                })}
              </div>
              {selected===null && (srs.wallet?.hint||0) > 0 && q.options.length>=3 && (
                <button onClick={quizHint} disabled={quizElim.length>0} style={{marginTop:12,width:"100%",display:"inline-flex",alignItems:"center",justifyContent:"center",gap:8,background:quizElim.length?"var(--color-background-secondary)":"var(--color-sel-tint)",border:`1px solid ${quizElim.length?"var(--color-border-tertiary)":"var(--color-accent)"}`,borderRadius:11,padding:"10px 12px",cursor:quizElim.length?"default":"pointer",opacity:quizElim.length?0.5:1,fontFamily:"inherit",fontSize:13,fontWeight:700,color:"var(--color-accent)"}}>
                  <Icon name="gem" size={15}/>{quizElim.length?(t.hintUsed||"Two options removed"):(t.useHint||"Use a hint").concat(` (${srs.wallet?.hint||0})`)}
                </button>
              )}
              {selected!==null&&instant&&<div style={{borderRadius:10,padding:"12px 14px",marginTop:14,...(selected===q.correct?{background:"var(--color-background-success)",border:"0.5px solid var(--color-border-success)",color:"var(--color-text-success)"}:{background:"var(--color-background-danger)",border:"0.5px solid var(--color-border-danger)",color:"var(--color-text-danger)"})}} className="slide-up"><strong style={{fontSize:14}}>{selected===q.correct?t.correct:t.incorrect}</strong><p style={{margin:"5px 0 0",fontSize:13,lineHeight:1.5}}>{q.explanation}</p></div>}
              {settings.autoAdvance && instant && selected!==null && <AutoAdvanceBar sec={autoAdvanceSec} runId={qIdx} t={t}/>}
              {(!settings.autoAdvance || instant) && <button style={{...Sb.btnPrimary,width:"100%",marginTop:settings.autoAdvance?12:20,opacity:selected===null?0.35:1,cursor:selected===null?"not-allowed":"pointer"}} onClick={nextMCQ} disabled={selected===null}>{settings.autoAdvance?t.skip||t.next:(isLast?t.finish:t.next)}</button>}
              <div style={{textAlign:"center",marginTop:12}}><FlagFix key={qIdx} q={q} subject={quiz.subject} blocks={genBlocksRef.current} uiLangName={LANGS[lang]?.name} diff={diff} t={t} onReplace={replaceCurrentQuestion}/></div>
            </>
          )}
        </div>
        <ExitModal show={showExitConfirm} onStay={()=>setShowExitConfirm(false)} onLeave={()=>{setShowExitConfirm(false);newMat();}}/>
        <button onClick={openSettings} title={t.set?.title||"Settings"} aria-label={t.set?.title||"Settings"} style={{position:"fixed",left:12,bottom:58,zIndex:400,width:38,height:38,borderRadius:"50%",background:"var(--color-background-secondary)",border:"0.5px solid var(--color-border-secondary)",color:"var(--color-text-secondary)",cursor:"pointer",fontFamily:"inherit",display:"inline-flex",alignItems:"center",justifyContent:"center",boxShadow:"0 4px 14px rgba(35,31,26,0.13)"}}><Icon name="gear" size={17}/></button>
        <button onClick={()=>setShowBugReport(true)} title={t.reportTitle} aria-label={t.reportTitle} style={{position:"fixed",left:12,bottom:12,zIndex:400,width:38,height:38,borderRadius:"50%",background:"var(--color-background-secondary)",border:"0.5px solid var(--color-border-secondary)",color:"var(--color-text-secondary)",cursor:"pointer",fontFamily:"inherit",display:"inline-flex",alignItems:"center",justifyContent:"center",boxShadow:"0 4px 14px rgba(35,31,26,0.13)"}}><Icon name="chat" size={17}/></button>
        {showBugReport && <ContactModal defaultEmail={user?.email||""} onClose={()=>setShowBugReport(false)} t={t}/>}
        {showSettings && <SettingsPanel draft={settingsDraft} update={updateDraft} onApply={applySettings} onCancel={cancelSettings} onSignOut={()=>signOut()} onDeleteAccount={confirmDeleteAccount} requiresPassword={requiresPassword} onReauthenticate={reauthenticate} isPro={isPro} onManageSubscription={openPortal} signedIn={!!user} onOpenBadges={()=>{setShowSettings(false);setScreen("badges");}} onOpenStreak={()=>{setShowSettings(false);setScreen("home");setShowStreak(true);}} onOpenAccuracy={()=>{setShowSettings(false);setScreen("home");setOpenCard(c=>({...c,mastery:true}));}} onOpenReview={()=>{setShowSettings(false);if(srs.dueCards.length)startReview();else startQuick10();}} t={t}/>}
      </div>
    );
  }

  // ── RESULTS ──────────────────────────────────────────────────────
  if (screen==="results" && quiz) return (
    <div style={Sb.root}><style>{CSS}</style>
      {badgeToastEl}{rankToastEl}{streakToastEl}{notifToastEl}{burstConfetti&&<Confetti/>}
      <AdBanners isPro={isPro} bottom={false}/>
      {upgraded && <div style={{position:"fixed",top:0,left:0,right:0,zIndex:800,background:"#16a34a",color:"#fff",textAlign:"center",padding:"11px 14px",fontSize:14,fontWeight:700,fontFamily:"inherit",boxShadow:"0 6px 18px rgba(35,31,26,0.16)"}}>{t.welcomePro}</div>}
      <div style={{background:"#312e81",padding:"36px 20px 28px",textAlign:"center"}}>
        <div style={{marginBottom:10,display:"flex",justifyContent:"center"}}><Icon name={badge.icon} size={46} stroke={1.7} style={{color:"#fff"}}/></div>
        <h2 style={{margin:"0 0 4px",fontSize:22,fontWeight:700,color:"#fff"}}>{badge.text}</h2>
        <div style={{fontSize:46,fontWeight:800,color:"#fff",letterSpacing:-1,fontFamily:"'Fraunces',Georgia,serif"}}>{pct}%</div>
        <div style={{fontSize:14,color:"rgba(255,255,255,0.7)",marginTop:4}}>{score} {t.outOf} {quiz.questions.length}</div>
        <div style={{display:"flex",flexWrap:"wrap",gap:5,justifyContent:"center",marginTop:16}}>{answers.map((a,i)=><span key={i} style={{width:14,height:14,borderRadius:4,background:a.isCorrect?"#4ade80":"#f87171"}}/>)}</div>
        {stats.streak>0 && <div style={{marginTop:16,display:"flex",justifyContent:"center"}}><span style={{display:"inline-flex",alignItems:"center",gap:7,background:"rgba(255,255,255,0.13)",borderRadius:999,padding:"6px 15px"}}><StreakFlame count={stats.streak} size={19}/><span style={{fontSize:12.5,color:"rgba(255,255,255,0.88)",fontWeight:600}}>{t.dayStreakLabel||"day streak"}</span></span></div>}
      </div>
      <div className="rv-center" style={{padding:"20px 16px"}}>
        {!user && (
          <div style={{background:"linear-gradient(135deg,#4338ca,#6366f1)",borderRadius:14,padding:"16px",marginBottom:16,textAlign:"center",boxShadow:"0 6px 20px rgba(67,56,202,0.22)"}}>
            <div style={{fontWeight:800,fontSize:15,color:"#fff",marginBottom:4}}>{t.demoDoneTitle||"That's the Revyy loop."}</div>
            <div style={{fontSize:12.5,color:"rgba(255,255,255,0.88)",lineHeight:1.5,marginBottom:13}}>{t.demoDoneSub||"Create a free account to make quizzes from your own notes, PDFs and slides, and to save your streak."}</div>
            <button onClick={()=>navigate("/signup")} style={{background:"#fff",color:"#4338ca",border:"none",borderRadius:11,padding:"11px 22px",fontSize:14,fontWeight:800,cursor:"pointer",fontFamily:"inherit",boxShadow:"0 2px 10px rgba(0,0,0,0.14)"}}>{t.demoDoneCta||"Create your free account →"}</button>
          </div>
        )}
        {earnedReward && (
          <div style={{display:"flex",alignItems:"center",gap:10,background:"var(--color-sel-tint)",border:"1px solid var(--color-accent)",borderRadius:12,padding:"11px 14px",marginBottom:16}}>
            <Icon name="gem" size={18} style={{color:"var(--color-accent)",flexShrink:0}}/>
            <span style={{flex:1,fontSize:12.5,fontWeight:700,color:"var(--color-text-primary)",lineHeight:1.4}}>{(t.rewardEarned||"You earned a {p} power-up!").replace("{p}",pupName(t,earnedReward))}</span>
          </div>
        )}
        {srsAdded>0 && (
          <div style={{display:"flex",alignItems:"center",gap:10,background:"var(--color-sel-tint)",border:"1px solid var(--color-accent)",borderRadius:12,padding:"11px 14px",marginBottom:16}}>
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
          <div style={{display:"flex",alignItems:"center",gap:10,background:"var(--color-sel-tint)",border:"1px solid var(--color-accent)",borderRadius:12,padding:"11px 14px",marginBottom:16}}>
            <Icon name={resNudge.dir==="up"?"spark":"flame"} size={18} style={{color:"var(--color-accent)",flexShrink:0}}/>
            <span style={{flex:1,fontSize:12.5,color:"var(--color-accent)",lineHeight:1.4}}>{(resNudge.dir==="up"?t.nudgeHarder:t.nudgeEasier).replace("{n}",t.diffOpts[resNudge.to])}</span>
            <button onClick={()=>{ pickDiff(resNudge.to); newMat(); }} style={{flexShrink:0,background:"#4338ca",color:"#fff",border:"none",borderRadius:9,padding:"7px 12px",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>{t.useThis}</button>
          </div>
        )}
        {quiz.challengeId && (
          <button onClick={()=>{ const id=quiz.challengeId; setScreen("challenges"); openChallenge(id); }} style={{...Sb.btnPrimary,width:"100%",margin:"0 0 14px",display:"inline-flex",alignItems:"center",justifyContent:"center",gap:9,background:"#a3762b"}}>
            <Icon name="trophy" size={17}/>{t.seeStandings||"See the standings"}
          </button>
        )}
        {missedThisQuiz.length>0 && (
          <button onClick={fixMisses} style={{...Sb.btnPrimary,width:"100%",margin:"0 0 14px",display:"inline-flex",alignItems:"center",justifyContent:"center",gap:9,background:"linear-gradient(135deg,var(--color-text-success),#22c55e)"}}>
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
        <div style={{display:"flex",gap:10,marginBottom:14}}>
          <button style={{...Sb.btnOutline,flex:1,margin:0,display:"inline-flex",alignItems:"center",justifyContent:"center",gap:8}} onClick={()=>setScoreCardOpen(true)}><Icon name="spark" size={16}/>{t.shareResultBtn}</button>
          <button style={{...Sb.btnOutline,flex:1,margin:0,display:"inline-flex",alignItems:"center",justifyContent:"center",gap:8}} onClick={printStudySheet}><Icon name="notes" size={16}/>{t.printSheet||"Print / PDF"}</button>
        </div>
        {scoreCardOpen && <ScoreCardModal t={t} onClose={()=>setScoreCardOpen(false)} data={{ score, total:quiz.questions.length, pct: quiz.questions.length?Math.round(score/quiz.questions.length*100):0, subject: quiz.subject||quiz.title||"", rankEmoji: RANKS[myRankInfo.index]?.emoji, rankName:(t["rank_"+RANKS[myRankInfo.index]?.key])||RANKS[myRankInfo.index]?.name, xp: myRankInfo.xp, streak: stats.streak||0 }}/>}
        {user && <button style={{...Sb.btnOutline,width:"100%",margin:"0 0 14px",display:"inline-flex",alignItems:"center",justifyContent:"center",gap:8}} onClick={createShareLink} disabled={shareBusy}>{shareBusy?t.shareCreating:<span style={{display:"inline-flex",alignItems:"center",gap:8}}><Icon name="trophy" size={16}/>{t.challengeFriend}</span>}</button>}
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
              {!a?.isCorrect&&user&&<ExplainBox t={t} ctx={{question:q.question,correct:q.answer||"",picked:a?.chosen||"",subject:quiz.subject}}/>}
            </div>;
          })
        :
          quiz.questions.map((q,i)=>{
            const a=answers[i];
            return <div key={i} style={{background:"var(--color-background-primary)",borderRadius:10,padding:"14px 14px 14px 11px",marginBottom:10,border:"0.5px solid var(--color-border-tertiary)",borderLeft:`3px solid ${a?.isCorrect?"#22c55e":"#ef4444"}`}} className="fade-in">
              <div style={{display:"flex",gap:8,alignItems:"flex-start",marginBottom:8}}><span style={{flexShrink:0,display:"inline-flex",marginTop:1}}>{a?.isCorrect?<Icon name="check" size={16} stroke={2.6} style={{color:"#16a34a"}}/>:<Icon name="x" size={16} stroke={2.6} style={{color:"#dc2626"}}/>}</span><span style={{fontSize:14,fontWeight:600,color:"var(--color-text-primary)",lineHeight:1.4}}>{q.question}<SourceMark source={q.source} label={t.srcSeeQuestion} t={t}/></span></div>
              {quiz.type==="diagram"&&quiz.diagramImg&&<div style={{margin:"2px 0 8px",paddingLeft:23}}><div style={{position:"relative",display:"inline-block",maxWidth:"100%"}}><img alt="Diagram" src={quiz.diagramImg} style={{display:"block",maxWidth:"100%",maxHeight:200,borderRadius:8,border:"0.5px solid var(--color-border-tertiary)"}}/>{typeof q.x==="number"&&typeof q.y==="number"&&<span style={{position:"absolute",left:q.x+"%",top:q.y+"%",width:22,height:22,marginLeft:-11,marginTop:-11,borderRadius:"50%",border:"3px solid #ff3b30",boxShadow:"0 0 0 2px #fff",pointerEvents:"none"}}/>}</div></div>}
              {!a?.isCorrect&&a&&(quiz.type==="mcq"||quiz.type==="diagram"||quiz.type==="fill"||quiz.type==="written")&&<div style={{fontSize:12,color:"#dc2626",marginBottom:4,paddingLeft:23}}>{t.yourAns} {(quiz.type==="mcq"||quiz.type==="diagram")?(q.options?.[a.selected]??", "):quiz.type==="written"?(a.chosen||", "):(a.picked||", ")}</div>}
              <div style={{fontSize:12,color:"#16a34a",marginBottom:6,paddingLeft:23,fontWeight:500}}>{t.correctAns} {(quiz.type==="mcq"||quiz.type==="diagram")?q.options?.[q.correct]:(q.answer||"")}<SourceMark source={q.source} label={t.srcSeeAnswer} quoteLabel={t.srcConfirmsAnswer} t={t}/></div>
              {quiz.type==="written"&&a?.feedback&&<div style={{fontSize:12,color:"var(--color-text-secondary)",lineHeight:1.5,paddingLeft:23,marginBottom:4}}>{a.feedback}</div>}
              {q.explanation&&<div style={{fontSize:12,color:"var(--color-text-secondary)",lineHeight:1.55,paddingTop:8,borderTop:"0.5px solid var(--color-border-tertiary)",paddingLeft:23}}>{q.explanation}</div>}
              {!a?.isCorrect&&user&&quiz.type!=="written"&&<ExplainBox t={t} ctx={{question:q.question,correct:(quiz.type==="mcq"||quiz.type==="diagram")?(q.options?.[q.correct]??""):(q.answer||""),picked:(quiz.type==="mcq"||quiz.type==="diagram")?(q.options?.[a?.selected]??""):(a?.picked||""),subject:quiz.subject}}/>}
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
    const goodDays = card ? previewInterval(card, 3) : 0; // FSRS: days until the next review if you get it right
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
                  <button style={{flex:1,background:"var(--color-background-danger)",border:"1.5px solid var(--color-border-danger)",color:"var(--color-text-danger)",borderRadius:12,padding:"11px",cursor:"pointer",fontFamily:"inherit",display:"flex",flexDirection:"column",alignItems:"center",gap:2}} onClick={()=>gradeCard(false)}>
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
      {upgraded && <div style={{position:"fixed",top:0,left:0,right:0,zIndex:800,background:"#16a34a",color:"#fff",textAlign:"center",padding:"11px 14px",fontSize:14,fontWeight:700,fontFamily:"inherit",boxShadow:"0 6px 18px rgba(35,31,26,0.16)"}}>{t.welcomePro}</div>}
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
              <Medallion color="#4338ca" size={40}><Icon name={m.icon} size={21} stroke={1.7}/></Medallion>
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
                  <span style={{fontWeight:700,fontSize:18,color:"var(--color-accent)"}}>{Math.min(Math.max(parseInt(examTotalQ)||1,1),examCap())}</span>
                </div>
                <input type="range" min={1} max={examCap()} step={1} value={Math.min(Math.max(parseInt(examTotalQ)||1,1),examCap())} onChange={e=>setExamTotalQ(e.target.value)} style={{width:"100%",accentColor:"#4338ca",cursor:"pointer"}}/>
                <div style={{display:"flex",justifyContent:"space-between",fontSize:10,color:"var(--color-text-tertiary)",marginTop:2}}><span>1</span><span>{examCap()}</span></div>
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
              {examSections.length<5&&<button onClick={addSection} style={{background:"var(--color-sel-tint)",border:"1px solid #818cf8",color:"var(--color-accent)",borderRadius:8,padding:"5px 12px",fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>{t.addSectionBtn}</button>}
            </div>
            <div style={{display:"flex",flexDirection:"column",gap:10}}>
              {examSections.map((sec,si)=>{
                const secMarks=roundMarks(sectionMarksTotal(sec));
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
                      <div>
                        <div style={{fontSize:10,fontWeight:600,color:"var(--color-text-tertiary)",marginBottom:4}}>{t.questionTypeLbl}</div>
                        <select value={sec.type} onChange={e=>updateSection(sec.id,"type",e.target.value)} style={{width:"100%",borderRadius:8,border:"0.5px solid var(--color-border-secondary)",background:"var(--color-background-tertiary)",color:"var(--color-text-primary)",fontSize:13,padding:"7px 8px",fontFamily:"inherit",outline:"none"}}>
                          <option value="mcq">{t.quizTypes.mcq}</option>
                          <option value="written">{t.qtWrittenOpen}</option>
                          <option value="fill">{t.quizTypes.fill}</option>
                        </select>
                      </div>
                      <div>
                        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
                          <span style={{fontSize:10,fontWeight:600,color:"var(--color-text-tertiary)"}}>{t.questionsUpperLbl}</span>
                          <span style={{fontWeight:700,fontSize:14,color:"var(--color-accent)"}}>{Math.min(Math.max(parseInt(sec.count)||1,1),examCap())}</span>
                        </div>
                        <input type="range" min={1} max={examCap()} step={1} value={Math.min(Math.max(parseInt(sec.count)||1,1),examCap())} onChange={e=>updateSection(sec.id,"count",e.target.value)} style={{width:"100%",accentColor:"#4338ca",cursor:"pointer"}}/>
                        <div style={{display:"flex",justifyContent:"space-between",fontSize:10,color:"var(--color-text-tertiary)",marginTop:2}}><span>1</span><span>{examCap()}</span></div>
                      </div>
                      <div>
                        <div style={{fontSize:10,fontWeight:600,color:"var(--color-text-tertiary)",marginBottom:4}}>{t.markingLbl}</div>
                        <Seg options={[["perQ",t.markPerQ],["total",t.markSection]]} value={sec.markMode||"perQ"} onChange={v=>updateSection(sec.id,"markMode",v)}/>
                        <div style={{display:"flex",alignItems:"center",gap:8,marginTop:8}}>
                          {(sec.markMode||"perQ")==="total" ? (<>
                            <input type="number" min={1} max={500} step={1} value={sec.sectionMarks ?? ""} onChange={e=>updateSection(sec.id,"sectionMarks",e.target.value)} style={{width:84,borderRadius:8,border:"0.5px solid var(--color-border-secondary)",background:"var(--color-background-tertiary)",color:"var(--color-text-primary)",fontSize:15,fontWeight:700,padding:"7px 6px",fontFamily:"inherit",outline:"none",textAlign:"center",boxSizing:"border-box"}}/>
                            <span style={{fontSize:11.5,color:"var(--color-text-secondary)",lineHeight:1.4}}>{t.marksWord} · <strong>{roundMarks(sectionPerQMarks(sec))}</strong> {t.marksEach}</span>
                          </>) : (<>
                            <input type="number" min={0.5} max={20} step={0.5} value={sec.marksPerQ} onChange={e=>updateSection(sec.id,"marksPerQ",e.target.value)} style={{width:84,borderRadius:8,border:"0.5px solid var(--color-border-secondary)",background:"var(--color-background-tertiary)",color:"var(--color-text-primary)",fontSize:15,fontWeight:700,padding:"7px 6px",fontFamily:"inherit",outline:"none",textAlign:"center",boxSizing:"border-box"}}/>
                            <span style={{fontSize:11.5,color:"var(--color-text-secondary)"}}>{t.marksPerQLbl}</span>
                          </>)}
                        </div>
                      </div>
                    </div>
                    <div style={{padding:"6px 14px 10px",fontSize:11,color:"var(--color-text-secondary)"}}>
                      {(()=>{const cnt=parseInt(sec.count)||0, typeLbl=sec.type==="mcq"?t.typeMcqLower:sec.type==="fill"?t.typeFillLower:t.typeWrittenLower; return (sec.markMode||"perQ")==="total"
                        ? <>{cnt} {typeLbl} {t.questionsLow} · <strong>{secMarks} {t.marksWord}</strong> ({roundMarks(sectionPerQMarks(sec))} {t.marksEach})</>
                        : <>{cnt} {typeLbl} {t.questionsLow} × {roundMarks(sectionPerQMarks(sec))} {t.marksWord} = <strong>{secMarks} {t.marksWord}</strong></>;})()}
                    </div>
                  </div>
                );
              })}
            </div>
            <div style={{marginTop:12,background:"#312e81",borderRadius:10,padding:"12px 16px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
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
            <div key={idx} style={{background:"var(--color-sel-tint)",border:"1px solid #818cf8",borderRadius:10,padding:"10px",display:"flex",alignItems:"center",gap:8,cursor:"pointer",minHeight:56}} onClick={()=>removeExamFile(idx)}>
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
        {error&&<div style={{display:"flex",alignItems:"center",gap:8,background:"var(--color-background-danger)",border:"0.5px solid #fecaca",borderRadius:10,padding:"10px 14px",fontSize:13,color:"var(--color-text-danger)",marginBottom:14}}><Icon name="alert" size={15} style={{flexShrink:0}}/><span>{error}</span></div>}
        {limitHit && <button onClick={()=>setShowPacks(true)} style={{...Sb.btnPrimary,width:"100%",marginBottom:14,background:"#4338ca"}}><span style={{display:"inline-flex",alignItems:"center",gap:8}}><Icon name="gem" size={16}/>{t.getMoreQuestions}</span></button>}
        <button disabled={!examMode||examFiles.filter(Boolean).length===0} style={{...Sb.btnPrimary,width:"100%",opacity:(!examMode||examFiles.filter(Boolean).length===0)?0.35:1,background:"linear-gradient(135deg,#312e81,#4338ca)"}} onClick={generateExam}>{t.startExam}</button>
      </div>
      {showPacks&&<PacksModal onClose={()=>setShowPacks(false)} buyPack={buyPack} t={t}/>}
      {showSettings&&<SettingsPanel draft={settingsDraft} update={updateDraft} onApply={applySettings} onCancel={cancelSettings} onSignOut={()=>signOut()} onDeleteAccount={confirmDeleteAccount} requiresPassword={requiresPassword} onReauthenticate={reauthenticate} isPro={isPro} onManageSubscription={openPortal} signedIn={!!user} onOpenBadges={()=>{setShowSettings(false);setScreen("badges");}} onOpenStreak={()=>{setShowSettings(false);setScreen("home");setShowStreak(true);}} onOpenAccuracy={()=>{setShowSettings(false);setScreen("home");setOpenCard(c=>({...c,mastery:true}));}} onOpenReview={()=>{setShowSettings(false);if(srs.dueCards.length)startReview();else startQuick10();}} t={t}/>}
    </div>
  );

  // ── EXAM RUN ──────────────────────────────────────────────────────
  if(screen==="exam_run"&&examQs.length>0){
    const q=examQs[examIdx],isLast=examIdx+1===examQs.length,answered=Object.keys(examAns).length;
    return (
      <div style={Sb.root}><style>{CSS}</style>
      <AdBanners isPro={isPro}/>
      {upgraded && <div style={{position:"fixed",top:0,left:0,right:0,zIndex:800,background:"#16a34a",color:"#fff",textAlign:"center",padding:"11px 14px",fontSize:14,fontWeight:700,fontFamily:"inherit",boxShadow:"0 6px 18px rgba(35,31,26,0.16)"}}>{t.welcomePro}</div>}
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
        <div style={{height:4,background:"var(--color-border-tertiary)"}}><div style={{height:"100%",background:"var(--color-text-tertiary)",width:((examIdx/examQs.length)*100)+"%",transition:"width 0.3s"}}/></div>
        {examReview && (
          <div style={{background:"var(--color-background-success)",borderBottom:"1px solid var(--color-border-success)",padding:"8px 16px",display:"flex",alignItems:"center",justifyContent:"space-between",gap:10}}>
            <span style={{fontSize:12,color:"var(--color-text-success)",fontWeight:600}}>{t.reviewModeNote}</span>
            <button onClick={()=>submitExam()} style={{background:"#16a34a",color:"#fff",border:"none",borderRadius:8,padding:"7px 14px",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:"inherit",whiteSpace:"nowrap"}}>{t.finalSubmit}</button>
          </div>
        )}
        <div className="rv-center-narrow" style={{padding:"20px 16px 32px"}}>
          {q.section&&(examIdx===0||examQs[examIdx-1]?.section!==q.section)&&(
            <div style={{background:"#312e81",borderRadius:10,padding:"10px 16px",marginBottom:14,display:"flex",justifyContent:"space-between",alignItems:"center"}} className="fade-in">
              <span style={{fontWeight:700,fontSize:14,color:"#fff"}}>{t.sectionNum.replace("{n}",q.section)}</span>
              {examMode==="custom"&&examSections[q.section-1]&&(
                <span style={{fontSize:11,color:"rgba(255,255,255,0.75)"}}>{t.qsAndMarks.replace("{q}",examSections[q.section-1].count).replace("{m}",roundMarks(sectionMarksTotal(examSections[q.section-1])))}</span>
              )}
            </div>
          )}
          <div style={{display:"flex",gap:8,marginBottom:16,flexWrap:"wrap"}}>
            <span style={{background:q.type==="mcq"?"var(--color-sel-tint)":"#fef3c7",color:q.type==="mcq"?"#4338ca":"#92400e",borderRadius:20,padding:"4px 12px",fontSize:11,fontWeight:700}}>{q.type==="mcq"?t.quizTypes.mcq:q.type==="fill"?t.quizTypes.fill:t.writtenWord}</span>
            {examAns[examIdx]!==undefined&&<span style={{background:"var(--color-background-success)",color:"#16a34a",borderRadius:20,padding:"4px 10px",fontSize:11,fontWeight:600}}>{t.answeredWord}</span>}
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
    const theme=excellent?{bg:"linear-gradient(145deg,#052e16,#16a34a)",icon:"trophy",title:t.excellentTitle,msg:t.excellentMsg}:passed?{bg:"linear-gradient(145deg,#451a03,#b45309)",icon:"target",title:t.passTitle,msg:t.passMsg}:{bg:"linear-gradient(145deg,#1c0f0f,var(--color-text-danger))",icon:"notes",title:t.failTitle,msg:t.failMsg};
    return (
      <div style={Sb.root}><style>{CSS}</style>
      <AdBanners isPro={isPro}/>
      {badgeToastEl}{rankToastEl}{streakToastEl}{notifToastEl}{burstConfetti&&<Confetti/>}
      {upgraded && <div style={{position:"fixed",top:0,left:0,right:0,zIndex:800,background:"#16a34a",color:"#fff",textAlign:"center",padding:"11px 14px",fontSize:14,fontWeight:700,fontFamily:"inherit",boxShadow:"0 6px 18px rgba(35,31,26,0.16)"}}>{t.welcomePro}</div>}
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
          {earnedReward && (
            <div style={{display:"flex",alignItems:"center",gap:10,background:"var(--color-sel-tint)",border:"1px solid var(--color-accent)",borderRadius:12,padding:"11px 14px",marginBottom:16}}>
              <Icon name="gem" size={18} style={{color:"var(--color-accent)",flexShrink:0}}/>
              <span style={{flex:1,fontSize:12.5,fontWeight:700,color:"var(--color-text-primary)",lineHeight:1.4}}>{(t.rewardEarned||"You earned a {p} power-up!").replace("{p}",pupName(t,earnedReward))}</span>
            </div>
          )}
          {srsAdded>0 && (
            <div style={{display:"flex",alignItems:"center",gap:10,background:"var(--color-sel-tint)",border:"1px solid var(--color-accent)",borderRadius:12,padding:"11px 14px",marginBottom:16}}>
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
                      <div style={{fontSize:11,color:"var(--color-text-secondary)"}}>{t.qsTimesMarks.replace("{n}",secQs.length).replace("{m}",roundMarks(sectionPerQMarks(sec)))}</div>
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
            const bg=sc>=0.9?"var(--color-background-success)":sc>=0.5?"#fffbeb":"var(--color-background-danger)";
            const bdr=sc>=0.9?"var(--color-border-success)":sc>=0.5?"#fde68a":"var(--color-border-danger)";
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
        {planErr && <div style={{display:"flex",alignItems:"center",gap:8,background:"var(--color-background-danger)",border:"0.5px solid #fecaca",borderRadius:10,padding:"10px 14px",fontSize:13,color:"var(--color-text-danger)",marginBottom:14}}><Icon name="alert" size={15} style={{flexShrink:0}}/><span>{planErr}</span></div>}
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
        <div style={{background:"#312e81",padding:"22px 20px 20px"}}>
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
            : <div style={{background:"var(--color-background-danger)",border:"0.5px solid #fecaca",borderRadius:12,padding:"12px 14px",marginTop:8}}>
                <div style={{fontSize:12.5,color:"var(--color-text-danger)",marginBottom:10,lineHeight:1.5}}>{t.coachDeleteConfirm}</div>
                <div style={{display:"flex",gap:8}}>
                  <button onClick={()=>{deletePlan(activePlan.id);setConfirmDelPlan(false);setActivePlanId(null);setScreen("home");}} style={{flex:1,background:"#dc2626",color:"#fff",border:"none",borderRadius:9,padding:"9px",fontSize:12.5,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>{t.coachDeleteYes}</button>
                  <button onClick={()=>setConfirmDelPlan(false)} style={{...Sb.btnGhost,flex:1,padding:"9px"}}>{t.notNow||"Cancel"}</button>
                </div>
              </div>}
        </div>
      </div>
    );
  }

  // ── FRIENDS + STUDY GROUPS ────────────────────────────────────────
  if (screen==="social") return (
    <div style={Sb.root}><style>{CSS}</style>
      <AdBanners isPro={isPro}/>
      {notifToastEl}
      <div style={Sb.topbar} className="rv-topbar">
        <button style={Sb.backBtn} onClick={()=>setScreen("home")}>← {t.homeWord}</button>
        <span style={{fontSize:12,fontWeight:600,color:"var(--color-text-secondary)"}}>{t.socialTitle||"Friends & Groups"}</span><span/>
      </div>
      <div className="rv-center-narrow" style={{padding:"20px 16px 40px"}}>
        {socialErr && <div style={{background:"var(--color-background-danger)",border:"1px solid var(--color-border-danger)",borderRadius:12,padding:"10px 14px",fontSize:13,color:"var(--color-text-danger)",marginBottom:14}}>{socialErr}</div>}
        {/* Notification pop-up toggles (the unread bubbles show either way) */}
        <div style={{display:"flex",alignItems:"center",gap:18,flexWrap:"wrap",marginBottom:14,rowGap:10}}>
          <span style={{fontSize:11.5,fontWeight:700,letterSpacing:.4,textTransform:"uppercase",color:"var(--color-text-tertiary)"}}>{t.notifAlertsLabel||"Alerts"}</span>
          {[["req",t.notifReqLabel||"Requests"],["msg",t.notifMsgLabel||"Messages"]].map(([k,lbl])=>{
            const on = srs.notif?.[k] !== false;
            return (
              <span key={k} style={{display:"inline-flex",alignItems:"center",gap:9}}>
                <span style={{fontSize:13,fontWeight:600,color:on?"var(--color-text-primary)":"var(--color-text-tertiary)"}}>{lbl}</span>
                <Toggle on={on} onChange={(v)=>srs.setNotifPref(k,v)}/>
              </span>
            );
          })}
        </div>
        {/* Friends | Groups tabs */}
        <div style={{marginBottom:16}}>
          <Segmented value={socialTab} onChange={(o)=>setSocialTab(o.value)} options={[
            {value:"friends",label:(t.socialTabFriends||"Friends")+(social?.friends?.length?` (${social.friends.length})`:"")},
            {value:"groups",label:(t.socialTabGroups||"Groups")+(social?.groups?.length?` (${social.groups.length})`:"")},
          ]}/>
        </div>
        {socialTab==="friends" && (<>
        {/* Add a friend */}
        <div style={{...Sb.settingsBox,padding:"14px 16px",marginBottom:16}}>
          <div style={{fontSize:13,fontWeight:700,color:"var(--color-text-primary)",marginBottom:8}}>{t.addFriend||"Add a friend"}</div>
          <div style={{display:"flex",gap:8}}>
            <input value={friendInput} onChange={e=>{setFriendInput(e.target.value);setFriendMsg("");}} placeholder={t.friendUsernamePh||"their username"} onKeyDown={e=>{if(e.key==="Enter")doAddFriend();}}
              style={{flex:1,minWidth:0,borderRadius:10,border:"1px solid var(--color-border-secondary)",background:"var(--color-background-primary)",color:"var(--color-text-primary)",fontSize:14,padding:"10px 12px",fontFamily:"inherit",outline:"none",boxSizing:"border-box"}}/>
            <button onClick={doAddFriend} disabled={socialBusy||!friendInput.trim()} style={{...Sb.btnPrimary,padding:"0 16px",fontSize:13,opacity:(socialBusy||!friendInput.trim())?0.45:1}}>{t.addWord||"Add"}</button>
          </div>
          {friendMsg && <div style={{fontSize:11.5,color:"var(--color-text-success)",marginTop:6}}>{friendMsg}</div>}
        </div>
        {/* Incoming requests */}
        {social?.incoming?.length>0 && (
          <div style={{marginBottom:16}}>
            <p style={Sb.secLabel}>{t.friendRequests||"Requests"}</p>
            {social.incoming.map(r=>(
              <div key={r.id} style={{display:"flex",alignItems:"center",gap:10,background:"var(--color-background-primary)",border:"1px solid var(--color-border-secondary)",borderRadius:12,padding:"10px 12px",marginBottom:8}}>
                <AvatarInitial name={r.username} size={30}/>
                <span style={{flex:1,minWidth:0,fontSize:14,fontWeight:600,color:"var(--color-text-primary)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{r.username}</span>
                <button onClick={()=>doRespondFriend(r.id,true)} style={{background:"var(--color-accent)",color:"#fff",border:"none",borderRadius:9,padding:"7px 12px",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>{t.acceptWord||"Accept"}</button>
                <button onClick={()=>doRespondFriend(r.id,false)} style={{background:"rgba(239,68,68,0.12)",color:"#ef4444",border:"1px solid rgba(239,68,68,0.35)",borderRadius:9,padding:"7px 12px",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>{t.declineWord||"Decline"}</button>
              </div>
            ))}
          </div>
        )}
        {/* Friends */}
        <p style={Sb.secLabel}>{(t.friendsWord||"Friends")}{social?.friends?.length?` (${social.friends.length})`:""}</p>
        {social?.friends?.length ? social.friends.map(f=>(
          <div key={f.userId} onClick={()=>openDM(f)} style={{display:"flex",alignItems:"center",gap:11,background:"var(--color-background-primary)",border:"1px solid var(--color-border-secondary)",borderRadius:12,padding:"10px 12px",marginBottom:8,cursor:"pointer"}}>
            <AvatarInitial name={f.username} size={34}/>
            <div style={{flex:1,minWidth:0}}>
              <div style={{display:"flex",alignItems:"center",gap:6,minWidth:0}}>
                <span style={{fontSize:14,fontWeight:600,color:"var(--color-text-primary)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{f.username}</span>
                <Flair rank={f.rank} badge={f.badge} t={t} small/>
              </div>
              <div style={{fontSize:11,color:"var(--color-text-tertiary)",marginTop:1,display:"inline-flex",alignItems:"center",gap:7}}>
                {f.xp!=null && <span style={{fontFamily:"monospace",fontWeight:700}}>{Number(f.xp).toLocaleString()} XP</span>}
                <span style={{color:"var(--color-accent)",fontWeight:600}}>{t.dmMessageWord||"Message"} ›</span>
              </div>
            </div>
            <NotifBubble n={unread.byFriend[f.userId]||0}/>
            <button onClick={(e)=>{e.stopPropagation();doRemoveFriend(f.userId);}} style={{flexShrink:0,background:"none",color:"var(--color-text-tertiary)",border:"none",fontSize:12,cursor:"pointer",fontFamily:"inherit",textDecoration:"underline",textUnderlineOffset:2}}>{t.removeWord||"Remove"}</button>
          </div>
        )) : <div style={{fontSize:12.5,color:"var(--color-text-tertiary)",marginBottom:8}}>{t.noFriends||"No friends yet. Add someone by their username above."}</div>}
        </>)}
        {socialTab==="groups" && (<>
        {/* Groups */}
        <p style={{...Sb.secLabel,marginTop:2}}>{t.yourGroups||"Your study groups"}</p>
        {social?.groups?.map(g=>(
          <div key={g.id} onClick={()=>openGroup(g.id)} style={{display:"flex",alignItems:"center",gap:12,background:"var(--color-background-primary)",border:"1px solid var(--color-border-secondary)",borderRadius:14,padding:"13px 14px",marginBottom:10,cursor:"pointer"}}>
            <GroupAvatar name={g.name} size={38}/>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontWeight:700,fontSize:13.5,color:"var(--color-text-primary)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{g.name}</div>
              <div style={{fontSize:11.5,color:"var(--color-text-secondary)",marginTop:2}}>{(t.membersCount||"{n} members").replace("{n}",g.members)}{g.isOwner?` · ${t.ownerWord||"owner"}`:""}</div>
            </div>
            <NotifBubble n={(unread.byGroup[g.id]?.m||0)+(unread.byGroup[g.id]?.c||0)} style={{marginRight:4}}/>
            <span style={{fontSize:17,color:"var(--color-text-tertiary)"}}>›</span>
          </div>
        ))}
        <div style={{display:"flex",gap:8,marginTop:6,marginBottom:8}}>
          <input value={groupNameInput} onChange={e=>setGroupNameInput(e.target.value)} placeholder={t.newGroupPh||"New group name"} onKeyDown={e=>{if(e.key==="Enter")doCreateGroup();}}
            style={{flex:1,minWidth:0,borderRadius:10,border:"1px solid var(--color-border-secondary)",background:"var(--color-background-primary)",color:"var(--color-text-primary)",fontSize:14,padding:"10px 12px",fontFamily:"inherit",outline:"none",boxSizing:"border-box"}}/>
          <button onClick={doCreateGroup} disabled={socialBusy||!groupNameInput.trim()} style={{...Sb.btnPrimary,padding:"0 16px",fontSize:13,opacity:(socialBusy||!groupNameInput.trim())?0.45:1}}>{t.createWord||"Create"}</button>
        </div>
        <div style={{display:"flex",gap:8}}>
          <input value={joinCodeInput} onChange={e=>setJoinCodeInput(e.target.value)} placeholder={t.joinCodePh||"Join with a code"} onKeyDown={e=>{if(e.key==="Enter")doJoinGroup();}}
            style={{flex:1,minWidth:0,borderRadius:10,border:"1px solid var(--color-border-secondary)",background:"var(--color-background-primary)",color:"var(--color-text-primary)",fontSize:14,padding:"10px 12px",fontFamily:"inherit",outline:"none",boxSizing:"border-box"}}/>
          <button onClick={doJoinGroup} disabled={socialBusy||!joinCodeInput.trim()} style={{...Sb.btnOutline,padding:"0 16px",fontSize:13,opacity:(socialBusy||!joinCodeInput.trim())?0.45:1}}>{t.joinWord||"Join"}</button>
        </div>
        </>)}
      </div>
      {showSettings && <SettingsPanel draft={settingsDraft} update={updateDraft} onApply={applySettings} onCancel={cancelSettings} onSignOut={()=>signOut()} onDeleteAccount={confirmDeleteAccount} requiresPassword={requiresPassword} onReauthenticate={reauthenticate} isPro={isPro} onManageSubscription={openPortal} signedIn={!!user} onOpenBadges={()=>{setShowSettings(false);setScreen("badges");}} onOpenStreak={()=>{setShowSettings(false);setScreen("home");setShowStreak(true);}} onOpenAccuracy={()=>{setShowSettings(false);setScreen("home");setOpenCard(c=>({...c,mastery:true}));}} onOpenReview={()=>{setShowSettings(false);if(srs.dueCards.length)startReview();else startQuick10();}} t={t}/>}
    </div>
  );

  if (screen==="dm" && activeDM) return (
    <div style={Sb.root}><style>{CSS}</style>
      <AdBanners isPro={isPro}/>
      {notifToastEl}
      <div style={Sb.topbar} className="rv-topbar">
        <button style={Sb.backBtn} onClick={()=>{setScreen("social");loadSocial();}}>← {t.backWord}</button>
        <span style={{fontSize:12.5,fontWeight:700,color:"var(--color-text-primary)",display:"inline-flex",alignItems:"center",gap:6,minWidth:0}}>{activeDM.username}<Flair rank={activeDM.rank} badge={activeDM.badge} t={t} small/></span>
        <span/>
      </div>
      <div className="rv-center-narrow" style={{padding:"14px 16px 20px",display:"flex",flexDirection:"column",minHeight:"calc(100vh - 130px)"}}>
        {socialErr && <div style={{background:"var(--color-background-danger)",border:"1px solid var(--color-border-danger)",borderRadius:12,padding:"10px 14px",fontSize:13,color:"var(--color-text-danger)",marginBottom:12}}>{socialErr}</div>}
        <div style={{flex:1,overflowY:"auto",display:"flex",flexDirection:"column",gap:8,marginBottom:12}}>
          {dmMsgs.length ? dmMsgs.map(m=>{
            if (m.kind==="text") return (
              <div key={m.id} style={{alignSelf:m.mine?"flex-end":"flex-start",maxWidth:"82%"}}>
                <div style={{background:m.mine?"var(--color-accent)":"var(--color-background-secondary)",color:m.mine?"#fff":"var(--color-text-primary)",borderRadius:14,padding:"8px 12px",fontSize:13.5,lineHeight:1.4,wordBreak:"break-word"}}>{m.body}</div>
              </div>
            );
            if (m.kind==="score") { const d=m.data||{}; const isResult=d.total>0; return (
              <div key={m.id} style={{alignSelf:m.mine?"flex-end":"flex-start",maxWidth:"88%",background:"var(--color-background-primary)",border:"1px solid var(--color-border-secondary)",borderRadius:14,padding:"12px 14px"}}>
                <div style={{fontSize:11,fontWeight:800,letterSpacing:.4,textTransform:"uppercase",color:"var(--color-text-tertiary)",marginBottom:6}}>{isResult?(m.mine?(t.dmYourResult||"Your challenge result"):(t.dmTheirResult||"Their challenge result")):(m.mine?(t.dmYourScore||"Your progress"):(t.dmTheirScore||"Their progress"))}</div>
                {isResult && <div style={{fontSize:12,color:"var(--color-text-secondary)",marginBottom:6}}>{d.title}</div>}
                <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
                  {isResult && <span style={{fontSize:16,fontWeight:800,fontFamily:"'Fraunces',Georgia,serif",color:"var(--color-text-primary)"}}>{d.score}/{d.total} · {d.pct}%</span>}
                  <RankPill index={d.rank} t={t} small/>
                  {d.streak>0 && <StreakFlame count={d.streak} size={14}/>}
                  {d.accuracy!=null && <span style={{fontSize:12.5,color:"var(--color-text-secondary)"}}>{d.accuracy}% {t.accuracyLbl||"accuracy"}</span>}
                  {d.xp!=null && <span style={{fontSize:12.5,fontFamily:"monospace",fontWeight:700,color:"var(--color-accent)"}}>{Number(d.xp).toLocaleString()} XP</span>}
                </div>
              </div>
            ); }
            const d=m.data||{}, isChal=m.kind==="challenge";
            return (
              <div key={m.id} style={{alignSelf:m.mine?"flex-end":"flex-start",maxWidth:"88%",background:"var(--color-background-primary)",border:"1px solid "+(isChal?"#a3762b":"var(--color-border-secondary)"),borderRadius:14,padding:"12px 14px"}}>
                <div style={{fontSize:11,fontWeight:800,letterSpacing:.4,textTransform:"uppercase",color:isChal?"#a3762b":"var(--color-accent)",marginBottom:4,display:"inline-flex",alignItems:"center",gap:5}}><Icon name={isChal?"trophy":"layers"} size={12}/>{isChal?(t.dmChallengeLabel||"Challenge"):(t.dmSharedSet||"Shared a study set")}</div>
                <div style={{fontSize:13.5,fontWeight:600,color:"var(--color-text-primary)"}}>{d.title||m.body}</div>
                {d.subject&&<div style={{fontSize:11.5,color:"var(--color-text-tertiary)",marginTop:1}}>{d.subject}</div>}
                {isChal ? (()=>{
                  const rz=m.results||{}, nm=activeDM.username;
                  // Both friends played → show the head-to-head + who won.
                  if (rz.complete && rz.mine && rz.theirs) {
                    const win=rz.winner, mineWon=win==="me";
                    const banner=win==="tie"?(t.dmTie||"It's a tie!"):mineWon?(t.dmYouWon||"You won 🏆"):(t.dmTheyWon||"{name} won").replace("{name}",nm);
                    const bg=win==="tie"?"var(--color-background-secondary)":mineWon?"rgba(34,197,94,0.15)":"rgba(148,163,184,0.15)";
                    const fg=win==="tie"?"var(--color-text-secondary)":mineWon?"#16a34a":"var(--color-text-secondary)";
                    return (
                      <div style={{marginTop:10}}>
                        <div style={{display:"flex",gap:8}}>
                          {[{lbl:t.dmYouLabel||"You",r:rz.mine,hi:mineWon},{lbl:nm,r:rz.theirs,hi:win==="them"}].map((s,i)=>(
                            <div key={i} style={{flex:1,textAlign:"center",background:s.hi?"rgba(163,118,43,0.14)":"var(--color-background-secondary)",border:"1px solid "+(s.hi?"#a3762b":"var(--color-border-secondary)"),borderRadius:10,padding:"9px 6px",minWidth:0}}>
                              <div style={{fontSize:10.5,fontWeight:800,letterSpacing:.3,textTransform:"uppercase",color:"var(--color-text-tertiary)",marginBottom:3,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{s.lbl}</div>
                              <div style={{fontSize:16,fontWeight:800,fontFamily:"'Fraunces',Georgia,serif",color:"var(--color-text-primary)"}}>{s.r.score}/{s.r.total}</div>
                              <div style={{fontSize:11.5,color:"var(--color-text-secondary)"}}>{s.r.pct}%</div>
                            </div>
                          ))}
                        </div>
                        <div style={{marginTop:8,textAlign:"center",fontSize:12.5,fontWeight:800,color:fg,background:bg,borderRadius:9,padding:"7px 10px"}}>{banner}</div>
                      </div>
                    );
                  }
                  // I've played, waiting on my friend.
                  if (rz.iPlayed && rz.mine) return (
                    <div style={{marginTop:10,fontSize:12,color:"var(--color-text-secondary)",background:"var(--color-background-secondary)",borderRadius:10,padding:"9px 11px",lineHeight:1.45}}>{(t.dmChalWaiting||"You scored {s}/{n} · {p}%. Waiting for {name} to play…").replace("{s}",rz.mine.score).replace("{n}",rz.mine.total).replace("{p}",rz.mine.pct).replace("{name}",nm)}</div>
                  );
                  // Haven't played yet (either friend can) → play once.
                  return <button onClick={()=>quizFromDM(d,{challenge:true,friendId:activeDM.friendId,challengeId:m.id})} style={{...Sb.btnPrimary,width:"100%",marginTop:10,fontSize:12.5,background:"#a3762b",display:"inline-flex",alignItems:"center",justifyContent:"center",gap:6}}><Icon name="bolt" size={14}/>{t.dmPlayChallenge||"Play the challenge"}</button>;
                })() : <button onClick={()=>quizFromDM(d)} style={{...Sb.btnOutline,width:"100%",marginTop:10,fontSize:12.5,display:"inline-flex",alignItems:"center",justifyContent:"center",gap:6}}><Icon name="bolt" size={14}/>{t.quizThis||"Quiz me on this"}</button>}
              </div>
            );
          }) : <div style={{textAlign:"center",color:"var(--color-text-tertiary)",fontSize:12.5,padding:"28px 0",lineHeight:1.6}}>{t.dmEmpty||"No messages yet. Say hi, share a study set, or challenge them."}</div>}
        </div>
        <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:10}}>
          <button onClick={()=>setDmSharePick("material")} style={{...Sb.btnOutline,fontSize:12,flex:1,minWidth:100,padding:"9px 10px",display:"inline-flex",alignItems:"center",justifyContent:"center",gap:6}}><Icon name="layers" size={14}/>{t.dmShareSet||"Share a set"}</button>
          <button onClick={()=>setDmSharePick("challenge")} style={{...Sb.btnOutline,fontSize:12,flex:1,minWidth:100,padding:"9px 10px",display:"inline-flex",alignItems:"center",justifyContent:"center",gap:6}}><Icon name="trophy" size={14}/>{t.dmChallenge||"Challenge"}</button>
          <button onClick={shareScoreToDM} style={{...Sb.btnOutline,fontSize:12,flex:1,minWidth:100,padding:"9px 10px",display:"inline-flex",alignItems:"center",justifyContent:"center",gap:6}}><Icon name="spark" size={14}/>{t.dmShareScore||"Share score"}</button>
        </div>
        <div style={{display:"flex",gap:8}}>
          <input value={dmInput} onChange={e=>setDmInput(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")sendDMText();}} placeholder={t.dmPlaceholder||"Message"} maxLength={2000} style={{flex:1,minWidth:0,borderRadius:10,border:"1px solid var(--color-border-secondary)",background:"var(--color-background-primary)",color:"var(--color-text-primary)",fontSize:14,padding:"10px 12px",fontFamily:"inherit",outline:"none",boxSizing:"border-box"}}/>
          <button onClick={sendDMText} disabled={!dmInput.trim()} style={{...Sb.btnPrimary,padding:"0 16px",fontSize:13,opacity:dmInput.trim()?1:0.45}}>{t.sendWord||"Send"}</button>
        </div>
      </div>
      {dmSharePick && (
        <div style={{position:"fixed",inset:0,zIndex:650,background:"rgba(0,0,0,0.55)",display:"flex",alignItems:"flex-end",justifyContent:"center"}} onClick={()=>setDmSharePick(false)}>
          <div onClick={e=>e.stopPropagation()} style={{background:"var(--color-background-primary)",borderRadius:"18px 18px 0 0",padding:"18px 16px 24px",width:"100%",maxWidth:520,maxHeight:"70vh",overflowY:"auto"}}>
            <div style={{fontSize:15,fontWeight:800,color:"var(--color-text-primary)",marginBottom:3}}>{dmSharePick==="challenge"?(t.dmPickChallenge||"Challenge them on which set?"):(t.dmPickShare||"Share which set?")}</div>
            <div style={{fontSize:12,color:"var(--color-text-secondary)",marginBottom:12}}>{t.dmPickHint||"Pick a study set from your library."}</div>
            {srs.library.docs.length ? srs.library.docs.map(d=>(
              <button key={d.id} onClick={()=>{ sendDM({kind:dmSharePick, body:d.title, data:{title:d.title, subject:d.subject||"", summary:d.summary||""}}); setDmSharePick(false); }} style={{width:"100%",textAlign:"left",background:"var(--color-background-secondary)",border:"1px solid var(--color-border-secondary)",borderRadius:12,padding:"11px 13px",marginBottom:8,cursor:"pointer",fontFamily:"inherit"}}>
                <div style={{fontSize:13.5,fontWeight:600,color:"var(--color-text-primary)"}}>{d.title}</div>
                {d.subject&&<div style={{fontSize:11.5,color:"var(--color-text-tertiary)"}}>{d.subject}</div>}
              </button>
            )) : <div style={{fontSize:12.5,color:"var(--color-text-tertiary)",padding:"10px 0"}}>{t.dmNoSets||"No study sets yet. Make a quiz first, then you can share it."}</div>}
          </div>
        </div>
      )}
    </div>
  );

  if (screen==="group") return (
    <div style={Sb.root}><style>{CSS}</style>
      <AdBanners isPro={isPro}/>
      {notifToastEl}
      <div style={Sb.topbar} className="rv-topbar">
        <button style={Sb.backBtn} onClick={()=>{setScreen("social");loadSocial();}}>← {t.backWord}</button>
        <span style={{fontSize:12,fontWeight:600,color:"var(--color-text-secondary)",maxWidth:180,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{activeGroup?.name||(t.groupWord||"Group")}</span><span/>
      </div>
      <div className="rv-center-narrow" style={{padding:"18px 16px 40px"}}>
        {groupBusy && <div style={{textAlign:"center",padding:"40px 0"}}><div className="spin-ring" style={{width:34,height:34,borderRadius:"50%",border:"3px solid var(--color-border-tertiary)",borderTopColor:"var(--color-accent)",margin:"0 auto"}}/></div>}
        {activeGroup && (<>
          <div style={{display:"flex",gap:8,marginBottom:12,flexWrap:"wrap"}}>
            <button onClick={copyInvite} style={{...Sb.btnOutline,flex:1,fontSize:12.5,display:"inline-flex",alignItems:"center",justifyContent:"center",gap:6}}><Icon name="link" size={14}/>{copiedCode?(t.copiedWord||"Copied!"):(t.copyInvite||"Copy invite link")}</button>
            <button onClick={doLeaveGroup} style={{...Sb.btnGhost,fontSize:12.5,color:"var(--color-text-danger)"}}>{t.leaveGroup||"Leave"}</button>
          </div>
          {/* Collective goal: everyone's practice fills it; hitting it rewards every member. */}
          <div style={{background:"var(--color-background-primary)",border:"1px solid var(--color-border-secondary)",borderRadius:14,padding:"13px 15px",marginBottom:claimMsg?8:12}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
              <span style={{fontSize:13,fontWeight:700,color:"var(--color-text-primary)",display:"inline-flex",alignItems:"center",gap:6}}><Icon name="trophy" size={15} style={{color:"#a3762b"}}/>{(t.groupLevel||"Group level {n}").replace("{n}",activeGroup.level||1)}</span>
              <span style={{fontSize:11.5,color:"var(--color-text-secondary)",fontFamily:"monospace"}}>{(activeGroup.points||0)-(activeGroup.prevGoal||0)}/{(activeGroup.goal||300)-(activeGroup.prevGoal||0)}</span>
            </div>
            <div style={{height:8,borderRadius:5,background:"var(--color-background-secondary)",overflow:"hidden"}}>
              <div style={{height:"100%",width:`${Math.min(100,Math.max(0,(((activeGroup.points||0)-(activeGroup.prevGoal||0))/Math.max(1,(activeGroup.goal||300)-(activeGroup.prevGoal||0)))*100))}%`,background:"var(--color-accent)",borderRadius:5,transition:"width .4s"}}/>
            </div>
            <div style={{fontSize:11,color:"var(--color-text-tertiary)",marginTop:7,lineHeight:1.4}}>{t.groupGoalHint||"Everyone's practice on shared material fills this bar. Reach the goal and every member earns power-ups."}</div>
            {activeGroup.reward && (
              <button onClick={doClaimReward} style={{...Sb.btnPrimary,width:"100%",marginTop:10,fontSize:13,display:"inline-flex",alignItems:"center",justifyContent:"center",gap:7,background:"#a3762b"}}>
                <Icon name="gem" size={15}/>{(t.claimGroupReward||"Claim your group reward: +{h} hint, +{f} freeze").replace("{h}",activeGroup.reward.hint||0).replace("{f}",activeGroup.reward.freeze||0)}
              </button>
            )}
          </div>
          {claimMsg && <div style={{background:"var(--color-sel-tint)",border:"1px solid var(--color-accent)",borderRadius:12,padding:"10px 14px",fontSize:12.5,fontWeight:600,color:"var(--color-text-primary)",marginBottom:12,display:"flex",alignItems:"center",gap:8}}><Icon name="gem" size={15} style={{color:"var(--color-accent)"}}/>{claimMsg}</div>}
          <button onClick={openChallenges} style={{...Sb.btnPrimary,width:"100%",marginBottom:14,fontSize:13,display:"inline-flex",alignItems:"center",justifyContent:"center",gap:7}}><Icon name="trophy" size={15}/>{t.groupChallenges||"Challenge the group"}</button>
          <div style={{marginBottom:16}}>
            <Segmented value={groupTab} onChange={(o)=>setGroupTab(o.value)} options={[
              {value:"board",label:t.tabBoard||"Board"},
              {value:"library",label:t.tabLibrary||"Library"},
              {value:"chat",label:t.tabChat||"Chat"},
              {value:"activity",label:t.tabActivity||"Activity"},
            ]}/>
          </div>
          {groupTab==="board" && activeGroup.members.map((m,i)=>(
            <div key={m.userId} style={{display:"flex",alignItems:"center",gap:11,background:m.you?"var(--color-sel-tint)":"var(--color-background-primary)",border:"1px solid "+(m.you?"var(--color-accent)":"var(--color-border-secondary)"),borderRadius:12,padding:"11px 13px",marginBottom:8}}>
              <span style={{width:20,textAlign:"center",fontWeight:800,fontSize:13,color:i===0?"#a3762b":"var(--color-text-tertiary)",fontFamily:"monospace",flexShrink:0}}>{i+1}</span>
              <AvatarInitial name={m.username} size={30}/>
              <div style={{flex:1,minWidth:0}}>
                <div style={{display:"flex",alignItems:"center",gap:6,minWidth:0}}>
                  <span style={{fontSize:13.5,fontWeight:600,color:"var(--color-text-primary)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{m.username}{m.you?` · ${t.youWord||"you"}`:""}{m.role==="owner"?" ★":""}</span>
                  <Flair rank={m.rank} badge={m.badge} t={t} small/>
                </div>
                <div style={{fontSize:11,color:"var(--color-text-secondary)",marginTop:1}}>{(t.answeredCount||"{n} answered").replace("{n}",m.answered)} · {m.accuracy}%</div>
              </div>
              <div style={{fontSize:15,fontWeight:800,color:"#d97706",fontFamily:"monospace",display:"inline-flex",alignItems:"center",gap:3,flexShrink:0}}><Icon name="flame" size={13} style={{color:"#f97316"}}/>{m.streak}</div>
            </div>
          ))}
          {groupTab==="library" && (<>
            <button onClick={()=>setShowShare(true)} style={{...Sb.btnPrimary,width:"100%",marginBottom:12,fontSize:13,display:"inline-flex",alignItems:"center",justifyContent:"center",gap:7}}><Icon name="upload" size={15}/>{t.shareToGroup||"Share a study set"}</button>
            {activeGroup.library.length ? activeGroup.library.map(d=>(
              <div key={d.id} style={{background:"var(--color-background-primary)",border:"1px solid var(--color-border-secondary)",borderRadius:12,padding:"12px 13px",marginBottom:8}}>
                <div style={{fontSize:13.5,fontWeight:600,color:"var(--color-text-primary)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{d.title}</div>
                <div style={{fontSize:11,color:"var(--color-text-tertiary)",marginTop:1}}>{d.subject?`${d.subject} · `:""}{(t.sharedBy||"by {n}").replace("{n}",d.by)}</div>
                <button onClick={()=>quizGroupDoc(d.id)} style={{...Sb.btnOutline,width:"100%",marginTop:10,fontSize:12.5,display:"inline-flex",alignItems:"center",justifyContent:"center",gap:6}}><Icon name="bolt" size={14}/>{t.quizThis||"Quiz me on this"}</button>
              </div>
            )) : <div style={{fontSize:12.5,color:"var(--color-text-tertiary)"}}>{t.groupLibEmpty||"No shared material yet. Share a study set so the group can quiz on it."}</div>}
          </>)}
          {groupTab==="activity" && (activeGroup.activity.length ? activeGroup.activity.map((a,i)=>(
            <div key={i} style={{display:"flex",alignItems:"center",gap:10,padding:"9px 2px",borderBottom:"1px solid var(--color-border-tertiary)"}}>
              <AvatarInitial name={a.by} size={26}/>
              <span style={{flex:1,fontSize:12.5,color:"var(--color-text-secondary)",lineHeight:1.4}}><strong style={{color:"var(--color-text-primary)"}}>{a.by}</strong> {activityText(a,t)}</span>
              <span style={{fontSize:10.5,color:"var(--color-text-tertiary)",flexShrink:0}}>{timeAgo(a.at)}</span>
            </div>
          )) : <div style={{fontSize:12.5,color:"var(--color-text-tertiary)"}}>{t.groupActivityEmpty||"No activity yet."}</div>)}
          {groupTab==="chat" && (
            <div>
              <div style={{maxHeight:"46vh",overflowY:"auto",display:"flex",flexDirection:"column",gap:8,marginBottom:12,padding:"2px"}}>
                {chatMsgs.length ? chatMsgs.map(m=>(
                  <div key={m.id} style={{alignSelf:m.mine?"flex-end":"flex-start",maxWidth:"82%"}}>
                    {!m.mine && <div style={{fontSize:10.5,color:"var(--color-text-tertiary)",margin:"0 0 2px 10px"}}>{m.by}</div>}
                    <div style={{background:m.mine?"var(--color-accent)":"var(--color-background-secondary)",color:m.mine?"#fff":"var(--color-text-primary)",borderRadius:14,padding:"8px 12px",fontSize:13.5,lineHeight:1.4,wordBreak:"break-word"}}>{m.text}</div>
                  </div>
                )) : <div style={{fontSize:12.5,color:"var(--color-text-tertiary)",textAlign:"center",padding:"20px 0"}}>{t.chatEmpty||"No messages yet. Say hi and plan your studying."}</div>}
              </div>
              <div style={{display:"flex",gap:8}}>
                <input value={chatInput} onChange={e=>setChatInput(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")sendChat();}} placeholder={t.chatPlaceholder||"Message the group"} maxLength={1000}
                  style={{flex:1,minWidth:0,borderRadius:999,border:"1px solid var(--color-border-secondary)",background:"var(--color-background-primary)",color:"var(--color-text-primary)",fontSize:14,padding:"10px 16px",fontFamily:"inherit",outline:"none",boxSizing:"border-box"}}/>
                <button onClick={sendChat} disabled={!chatInput.trim()} style={{...Sb.btnPrimary,padding:"0 16px",fontSize:13,opacity:chatInput.trim()?1:0.45}}>{t.sendWord||"Send"}</button>
              </div>
            </div>
          )}
          {groupTab!=="chat" && social?.friends?.length>0 && (()=>{
            const inGroup = new Set(activeGroup.members.map(m=>m.userId));
            const addable = social.friends.filter(f=>!inGroup.has(f.userId));
            if(!addable.length) return null;
            return (
              <div style={{marginTop:18}}>
                <p style={Sb.secLabel}>{t.inviteFriends||"Add your friends"}</p>
                {addable.map(f=>(
                  <div key={f.userId} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 2px"}}>
                    <AvatarInitial name={f.username} size={28}/>
                    <span style={{flex:1,fontSize:13,color:"var(--color-text-primary)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{f.username}</span>
                    <button onClick={()=>doInviteFriend(f.userId)} style={{background:"var(--color-accent)",color:"#fff",border:"none",borderRadius:9,padding:"6px 12px",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>{t.addWord||"Add"}</button>
                  </div>
                ))}
              </div>
            );
          })()}
        </>)}
      </div>
      {showShare && (
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",zIndex:500,display:"flex",alignItems:"flex-end"}} onClick={()=>setShowShare(false)}>
          <div className="slide-up" onClick={e=>e.stopPropagation()} style={{background:"var(--color-background-primary)",borderRadius:"20px 20px 0 0",padding:"22px 18px 30px",width:"100%",maxWidth:520,margin:"0 auto",boxSizing:"border-box",maxHeight:"80vh",overflowY:"auto"}}>
            <h3 style={{margin:"0 0 4px",fontSize:18,fontWeight:700,fontFamily:"'Fraunces',Georgia,serif",color:"var(--color-text-primary)"}}>{t.shareToGroup||"Share a study set"}</h3>
            <p style={{fontSize:12.5,color:"var(--color-text-secondary)",margin:"0 0 14px",lineHeight:1.5}}>{t.shareHint||"Pick a set from your library. The whole group can then quiz on it."}</p>
            {srs.library?.docs?.length ? srs.library.docs.map(d=>(
              <button key={d.id} onClick={()=>doShareToGroup(d)} style={{width:"100%",textAlign:"left",background:"var(--color-background-secondary)",border:"1px solid var(--color-border-secondary)",borderRadius:11,padding:"11px 13px",marginBottom:8,cursor:"pointer",fontFamily:"inherit"}}>
                <div style={{fontSize:13.5,fontWeight:600,color:"var(--color-text-primary)"}}>{d.title}</div>
                {d.subject&&<div style={{fontSize:11,color:"var(--color-text-tertiary)",marginTop:1}}>{d.subject}</div>}
              </button>
            )) : <div style={{fontSize:12.5,color:"var(--color-text-tertiary)"}}>{t.libEmptyShare||"Your library is empty. Make a quiz from your notes first, then share it here."}</div>}
            <button onClick={()=>setShowShare(false)} style={{width:"100%",marginTop:6,background:"none",border:"none",color:"var(--color-text-tertiary)",fontSize:13,cursor:"pointer",fontFamily:"inherit",padding:"8px"}}>{t.cancel||"Cancel"}</button>
          </div>
        </div>
      )}
    </div>
  );

  // ── GROUP CHALLENGES ──────────────────────────────────────────────
  if (screen==="global_board") return (
    <div style={Sb.root}><style>{CSS}</style>
      <AdBanners isPro={isPro}/>
      <div style={Sb.topbar} className="rv-topbar">
        <button style={Sb.backBtn} onClick={()=>setScreen("home")}>← {t.backWord||"Back"}</button>
        <span style={Sb.brand}>{t.globalBoardTitle||"Global leaderboard"}</span><span/>
      </div>
      <div className="rv-center-narrow" style={{padding:"18px 16px 40px"}}>
        <div style={{textAlign:"center",marginBottom:16}}>
          <div style={{fontSize:22,fontWeight:800,fontFamily:"'Fraunces',Georgia,serif",color:"var(--color-text-primary)"}}>🏆 {t.globalBoardHead||"Best of the best"}</div>
          <div style={{fontSize:12.5,color:"var(--color-text-secondary)",marginTop:3,lineHeight:1.5}}>{t.globalBoardSub||"The top 100 learners by rank across every mode."}{globalBoardData?.players?` · ${(t.globalPlayers||"{n} ranked").replace("{n}",globalBoardData.players.toLocaleString())}`:""}</div>
        </div>
        {globalBusy && <div style={{textAlign:"center",padding:"36px 0"}}><div className="spin-ring" style={{width:34,height:34,borderRadius:"50%",border:"3px solid var(--color-border-tertiary)",borderTopColor:"var(--color-accent)",margin:"0 auto"}}/></div>}
        {!globalBusy && globalBoardData && globalBoardData.locked && (
          <div style={{textAlign:"center",padding:"26px 18px",background:"var(--color-background-primary)",border:"0.5px solid var(--color-border-tertiary)",borderRadius:16}}>
            <div style={{display:"flex",justifyContent:"center",color:"var(--color-text-tertiary)",marginBottom:12}}><Icon name="lock" size={28}/></div>
            <h3 style={{margin:"0 0 8px",fontSize:18,fontWeight:700,fontFamily:"'Fraunces',Georgia,serif"}}>{t.globalLockedTitle||"The board opens soon"}</h3>
            <p style={{fontSize:13,color:"var(--color-text-secondary)",lineHeight:1.5,maxWidth:330,margin:"0 auto 16px"}}>{(t.globalLockedSub||"The global leaderboard unlocks once {need} learners are ranked. {have} so far, keep climbing.").replace("{need}",globalBoardData.need).replace("{have}",globalBoardData.players)}</p>
            <div style={{height:8,borderRadius:4,background:"var(--color-background-secondary)",overflow:"hidden",maxWidth:260,margin:"0 auto"}}>
              <div style={{height:"100%",width:`${Math.min(100,(globalBoardData.players/(globalBoardData.need||1))*100)}%`,background:"var(--color-accent)",borderRadius:4}}/>
            </div>
            <div style={{fontSize:12,fontFamily:"monospace",color:"var(--color-text-tertiary)",marginTop:8}}>{globalBoardData.players} / {globalBoardData.need}</div>
            {globalBoardData.you && <div style={{marginTop:18,fontSize:13,color:"var(--color-text-secondary)",display:"inline-flex",alignItems:"center",gap:8}}>{(t.globalYouPos||"You're #{n}").replace("{n}",(globalBoardData.you.pos||0).toLocaleString())} · {(globalBoardData.you.xp||0).toLocaleString()} XP <RankPill index={globalBoardData.you.tier} t={t} small/></div>}
          </div>
        )}
        {!globalBusy && globalBoardData && !globalBoardData.locked && (<>
          {globalBoardData.you && (
            <div style={{background:"var(--color-sel-tint)",border:"1px solid var(--color-accent)",borderRadius:12,padding:"12px 14px",marginBottom:12,display:"flex",justifyContent:"space-between",alignItems:"center",gap:10}}>
              <span style={{fontWeight:700,fontSize:14,display:"inline-flex",alignItems:"center",gap:8,minWidth:0}}>{(t.globalYouPos||"You're #{n}").replace("{n}",(globalBoardData.you.pos||0).toLocaleString())} <RankPill index={globalBoardData.you.tier} t={t} small/></span>
              <span style={{fontFamily:"monospace",fontWeight:700,color:"var(--color-accent)",flexShrink:0}}>{(globalBoardData.you.xp||0).toLocaleString()} XP</span>
            </div>
          )}
          {globalBoardData.top?.length ? (
            <div style={{border:"1px solid var(--color-border-secondary)",borderRadius:14,overflow:"hidden",background:"var(--color-background-primary)"}}>
              {globalBoardData.top.map((row,i)=>(
                <div key={i} style={{display:"grid",gridTemplateColumns:"32px 1fr auto",gap:10,alignItems:"center",padding:"11px 13px",background:row.you?"var(--color-sel-tint)":"transparent",borderBottom:i<globalBoardData.top.length-1?"0.5px solid var(--color-border-tertiary)":"none"}}>
                  <span style={{fontFamily:"monospace",fontWeight:800,fontSize:14,textAlign:"center",color:i===0?"#d97706":i===1?"#94a3b8":i===2?"#b45309":"var(--color-text-tertiary)"}}>{i+1}</span>
                  <div style={{minWidth:0,display:"flex",alignItems:"center",gap:9}}>
                    <AvatarInitial name={row.name} size={28}/>
                    <div style={{display:"flex",alignItems:"center",gap:6,minWidth:0}}>
                      <span style={{fontWeight:600,fontSize:14,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{row.name}{row.you?` · ${t.youWord||"you"}`:""}{i===0?" 👑":""}</span>
                      <Flair rank={row.tier} badge={row.badge} t={t} small/>
                    </div>
                  </div>
                  <span style={{fontFamily:"monospace",fontWeight:700,fontSize:14}}>{(row.xp||0).toLocaleString()}</span>
                </div>
              ))}
            </div>
          ) : <div style={{textAlign:"center",padding:"30px 0",fontSize:13,color:"var(--color-text-tertiary)"}}>{t.globalEmpty||"No one is ranked yet. Be the first to make the board."}</div>}
        </>)}
      </div>
    </div>
  );

  if (screen==="league") {
    const lg = leagueData;
    const tier = LEAGUE_TIERS[Math.max(0, Math.min(LEAGUE_TIERS.length - 1, lg?.tier || 0))];
    const board = lg?.board || [];
    const daysLeft = lg?.endsAt ? Math.max(0, Math.ceil((new Date(lg.endsAt).getTime() - Date.now()) / 86400000)) : null;
    const full = !!lg && board.length >= (lg.size || 30);
    return (
      <div style={Sb.root}><style>{CSS}</style>
        <AdBanners isPro={isPro}/>
        <div style={Sb.topbar} className="rv-topbar">
          <button style={Sb.backBtn} onClick={()=>setScreen("home")}>← {t.backWord||"Back"}</button>
          <span style={Sb.brand}>{t.leagueTitle||"Weekly League"}</span><span/>
        </div>
        <div className="rv-center-narrow" style={{padding:"18px 16px 40px"}}>
          {leagueBusy && <div style={{textAlign:"center",padding:"36px 0"}}><div className="spin-ring" style={{width:34,height:34,borderRadius:"50%",border:"3px solid var(--color-border-tertiary)",borderTopColor:"var(--color-accent)",margin:"0 auto"}}/></div>}
          {!leagueBusy && lg && lg.locked && (
            <div style={{textAlign:"center",padding:"26px 18px",background:"var(--color-background-primary)",border:"0.5px solid var(--color-border-tertiary)",borderRadius:16}}>
              <div style={{display:"flex",justifyContent:"center",color:"var(--color-text-tertiary)",marginBottom:12}}><Icon name="lock" size={28}/></div>
              <h3 style={{margin:"0 0 8px",fontSize:18,fontWeight:700,fontFamily:"'Fraunces',Georgia,serif"}}>{t.leagueLockedTitle||"Leagues open soon"}</h3>
              <p style={{fontSize:13,color:"var(--color-text-secondary)",lineHeight:1.5,maxWidth:340,margin:"0 auto 16px"}}>{(t.leagueLockedSub||"Weekly leagues unlock once {need} players are in the Arena, so cohorts have real competition. {have} so far.").replace("{need}",lg.need).replace("{have}",lg.players)}</p>
              <div style={{height:8,borderRadius:4,background:"var(--color-background-secondary)",overflow:"hidden",maxWidth:260,margin:"0 auto"}}>
                <div style={{height:"100%",width:`${Math.min(100,(lg.players/(lg.need||1))*100)}%`,background:"var(--color-accent)",borderRadius:4}}/>
              </div>
              <div style={{fontSize:12,fontFamily:"monospace",color:"var(--color-text-tertiary)",marginTop:8}}>{lg.players} / {lg.need}</div>
            </div>
          )}
          {!leagueBusy && lg && !lg.locked && (<>
            <div style={{background:`linear-gradient(135deg, ${tier.color}22, ${tier.color}0d)`,border:`1px solid ${tier.color}66`,borderRadius:16,padding:16,marginBottom:14}}>
              <div style={{display:"flex",alignItems:"center",gap:13}}>
                <div style={{width:52,height:52,borderRadius:14,flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center",background:tier.color+"26"}} aria-hidden="true"><Icon name="trophy" size={26} stroke={1.8} style={{color:tier.color}}/></div>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:11,fontWeight:700,letterSpacing:.5,textTransform:"uppercase",color:"var(--color-text-tertiary)"}}>{t.leagueTierLabel||"This week's league"}</div>
                  <div style={{fontSize:20,fontWeight:800,color:tier.color,fontFamily:"'Fraunces',Georgia,serif"}}>{(t["league_"+tier.key])||tier.name}</div>
                </div>
                {daysLeft!=null && <div style={{textAlign:"right",flexShrink:0}}>
                  <div style={{fontSize:20,fontWeight:800,fontFamily:"monospace",color:"var(--color-text-primary)"}}>{daysLeft}</div>
                  <div style={{fontSize:10.5,color:"var(--color-text-tertiary)"}}>{daysLeft===1?(t.leagueDayWord||"day left"):(t.leagueDaysWord||"days left")}</div>
                </div>}
              </div>
              <div style={{fontSize:11.5,color:"var(--color-text-secondary)",marginTop:12,lineHeight:1.5}}>{(t.leagueRule||"Top {p} promote, bottom {d} drop at week's end. Play the Arena to earn league points.").replace("{p}",lg.promote).replace("{d}",lg.demote)}</div>
            </div>
            {board.length ? (
              <div style={{border:"1px solid var(--color-border-secondary)",borderRadius:14,overflow:"hidden",background:"var(--color-background-primary)"}}>
                {board.map((row,i)=>{
                  const promo=(i+1)<=lg.promote, demo=full&&(i+1)>((lg.size||30)-lg.demote);
                  const accent=promo?"#22c55e":demo?"#ef4444":"transparent";
                  return (
                    <div key={i} style={{display:"grid",gridTemplateColumns:"30px 1fr auto",gap:10,alignItems:"center",padding:"11px 13px",borderLeft:`3px solid ${accent}`,background:row.you?"var(--color-sel-tint)":"transparent",borderBottom:i<board.length-1?"0.5px solid var(--color-border-tertiary)":"none"}}>
                      <span style={{fontFamily:"monospace",fontWeight:800,fontSize:14,textAlign:"center",color:"var(--color-text-tertiary)"}}>{i+1}</span>
                      <div style={{minWidth:0,display:"flex",alignItems:"center",gap:9}}>
                        <AvatarInitial name={row.name} size={28}/>
                        <div style={{display:"flex",alignItems:"center",gap:6,minWidth:0}}>
                          <span style={{fontWeight:600,fontSize:14,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{row.name}{row.you?` · ${t.youWord||"you"}`:""}</span>
                          <Flair rank={row.rank} badge={row.badge} t={t} small/>
                        </div>
                      </div>
                      <span style={{fontFamily:"monospace",fontWeight:700,fontSize:14}}>{(row.points||0).toLocaleString()}</span>
                    </div>
                  );
                })}
              </div>
            ) : <div style={{textAlign:"center",padding:"30px 0",fontSize:13,color:"var(--color-text-tertiary)"}}>{t.leagueEmpty||"No one has scored in your league yet. Play the Arena to get on the board."}</div>}
            <div style={{display:"flex",gap:16,justifyContent:"center",marginTop:12,fontSize:11.5,color:"var(--color-text-secondary)"}}>
              <span style={{display:"inline-flex",alignItems:"center",gap:6}}><span style={{width:10,height:10,borderRadius:2,background:"#22c55e",display:"inline-block"}}/>{t.leaguePromote||"Promotion"}</span>
              <span style={{display:"inline-flex",alignItems:"center",gap:6}}><span style={{width:10,height:10,borderRadius:2,background:"#ef4444",display:"inline-block"}}/>{t.leagueDemote||"Demotion"}</span>
            </div>
          </>)}
        </div>
      </div>
    );
  }

  if (screen==="badges") return (
    <div style={Sb.root}><style>{CSS}</style>
      <AdBanners isPro={isPro}/>
      <div style={Sb.topbar} className="rv-topbar">
        <button style={Sb.backBtn} onClick={()=>setScreen("home")}>← {t.backWord||"Back"}</button>
        <span style={{fontSize:12,fontWeight:600,color:"var(--color-text-secondary)"}}>{t.badgesTitle||"Badges & rank"}</span><span/>
      </div>
      <div className="rv-center-narrow" style={{padding:"18px 16px 44px"}}>
        {/* Rank header: your overall rank (Arena + study), with your Arena-only
            standing folded in below as a sub-line (Unranked until you play), so
            there is only ONE rank card, never two competing ones. */}
        {(()=>{ const r=RANKS[myRankInfo.index]; const nm=(t["rank_"+r.key])||r.name;
          const nextNm=myRankInfo.next?((t["rank_"+myRankInfo.next.key])||myRankInfo.next.name):null;
          const ab=srs.stats?.arenaBest||0; const ar=ab>0?rankFor(ab):null; const arNm=ar?((t["rank_"+ar.key])||ar.name):(t.unranked||"Unranked");
          return (
            <div onClick={()=>setShowRanks(true)} style={{background:"var(--color-background-primary)",border:"1px solid var(--color-border-secondary)",borderRadius:16,padding:"16px 16px 18px",marginBottom:16,cursor:"pointer"}}>
              <div style={{display:"flex",alignItems:"center",gap:12}}>
                <div style={{width:52,height:52,borderRadius:"50%",background:r.color+"22",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}} aria-hidden="true"><Icon name={r.icon} size={26} stroke={1.8} style={{color:r.color}}/></div>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:11,fontWeight:700,letterSpacing:.5,textTransform:"uppercase",color:"var(--color-text-tertiary)"}}>{t.yourRankHdr||"Your rank"}</div>
                  <div style={{fontSize:20,fontWeight:800,color:r.color,fontFamily:"'Fraunces',Georgia,serif"}}>{nm}</div>
                </div>
                <div style={{textAlign:"right"}}>
                  <div style={{fontSize:20,fontWeight:800,fontFamily:"monospace",color:"var(--color-text-primary)"}}>{myRankInfo.xp.toLocaleString()}</div>
                  <div style={{fontSize:10.5,color:"var(--color-text-tertiary)"}}>{t.xpWord||"XP"}</div>
                </div>
                <Icon name="chevron" size={16} stroke={2} style={{color:"var(--color-text-tertiary)",flexShrink:0}}/>
              </div>
              {nextNm ? (<>
                <div style={{height:7,background:"var(--color-border-tertiary)",borderRadius:4,marginTop:14,overflow:"hidden"}}><div style={{width:`${Math.round((myRankInfo.toNext||0)*100)}%`,height:"100%",background:r.color}}/></div>
                <div style={{fontSize:11.5,color:"var(--color-text-secondary)",marginTop:6}}>{(t.rankToNext||"{n} XP to {r}").replace("{n}",Math.max(0,myRankInfo.next.min-myRankInfo.xp).toLocaleString()).replace("{r}",nextNm)}</div>
              </>) : <div style={{fontSize:11.5,color:"var(--color-text-secondary)",marginTop:12}}>{t.rankMax||"You've reached the top tier. Legendary."}</div>}
              <div style={{fontSize:10.5,color:"var(--color-text-tertiary)",marginTop:8,display:"inline-flex",alignItems:"center",gap:5}}><Icon name="bolt" size={12} style={{flexShrink:0}}/>{t.rankSourceHint||"Your rank climbs with your Arena runs and your studying."}</div>
              <div style={{fontSize:11,color:"var(--color-text-tertiary)",marginTop:9,paddingTop:9,borderTop:"0.5px solid var(--color-border-tertiary)",display:"flex",alignItems:"center",gap:7}}>
                <Icon name={ar?ar.icon:"rank_unranked"} size={14} stroke={2} style={{color:ar?ar.color:"#9ca3af",flexShrink:0}}/>
                <span style={{minWidth:0}}>{t.arenaRankLabel||"Arena rank"}: <b style={{color:ar?ar.color:"var(--color-text-secondary)",fontWeight:800}}>{arNm}</b>{ab>0?` · ${ab.toLocaleString()} ${t.arenaBestLabel||"best run"}`:` · ${t.arenaUnrankedHint||"Play the Endless Arena to get ranked."}`}</span>
              </div>
            </div>
          ); })()}
        {showRanks && <RanksModal currentIndex={myRankInfo.index} xp={myRankInfo.xp} t={t} onClose={()=>setShowRanks(false)}/>}

        {/* Link to the global leaderboard */}
        {globalUnlocked && <button onClick={()=>{ if(requireLogin()) return; openGlobalBoard(); }} style={{width:"100%",display:"flex",alignItems:"center",justifyContent:"center",gap:7,background:"transparent",border:"1px solid var(--color-border-secondary)",borderRadius:12,padding:"10px 14px",marginBottom:16,fontSize:13,fontWeight:700,color:"var(--color-text-primary)",cursor:"pointer",fontFamily:"inherit"}}><span aria-hidden="true">🏆</span>{t.globalBoardSee||"See the global leaderboard"}</button>}

        {/* Public toggle + earned count */}
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:10,background:"var(--color-background-primary)",border:"1px solid var(--color-border-secondary)",borderRadius:12,padding:"11px 14px",marginBottom:8}}>
          <div style={{fontSize:12.5,color:"var(--color-text-secondary)"}}>{(t.badgesEarnedCount||"{n} of {m} badges").replace("{n}",earnedBadgeCount).replace("{m}",BADGES.length)}</div>
          <button onClick={()=>srs.setBadgesPublic(!flairPublic)} style={{fontSize:12,fontWeight:700,border:"1px solid "+(flairPublic?"var(--color-accent)":"var(--color-border-secondary)"),background:flairPublic?"var(--color-sel-tint)":"transparent",color:flairPublic?"var(--color-accent)":"var(--color-text-secondary)",borderRadius:20,padding:"5px 12px",cursor:"pointer"}}>{flairPublic?(t.badgesPublicOn||"Shown publicly"):(t.badgesPublicOff||"Hidden")}</button>
        </div>
        <div style={{fontSize:11.5,color:"var(--color-text-tertiary)",marginBottom:16}}>{t.badgesEquipHint||"Tap an earned badge to pin it next to your name."}</div>

        {/* All badges in one continuous grid (earned first for a fuller look) */}
        <p style={Sb.secLabel}>{t.allBadges||"All badges"}</p>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(150px,1fr))",gap:10}}>
          {[...BADGES].sort((a,b)=>(badgeEval.progress[b.id]?.earned?1:0)-(badgeEval.progress[a.id]?.earned?1:0)).map(b=>{
            const p = badgeEval.progress[b.id]||{value:0,target:b.target||1,earned:false,pct:0,count:null};
            const equipped = flairEquipped===b.id;
            const nm=(t["badge_"+b.id])||b.name, desc=(t["badgeDesc_"+b.id])||b.desc;
            return (
              <div key={b.id} onClick={p.earned?()=>srs.equipBadge(equipped?null:b.id):undefined}
                style={{background:"var(--color-background-primary)",border:"1px "+(equipped?"solid var(--color-accent)":p.earned?"solid var(--color-border-secondary)":"dashed var(--color-border-tertiary)"),borderRadius:12,padding:"13px 12px",textAlign:"center",cursor:p.earned?"pointer":"default",opacity:p.earned?1:0.72,position:"relative"}}>
                {equipped && <span style={{position:"absolute",top:7,right:9,fontSize:9.5,fontWeight:800,color:"var(--color-accent)",textTransform:"uppercase",letterSpacing:.4}}>{t.badgePinned||"Pinned"}</span>}
                <div style={{fontSize:26,lineHeight:1,marginBottom:6}} aria-hidden="true">{p.earned?b.emoji:"🔒"}</div>
                <div style={{fontSize:13,fontWeight:700,color:p.earned?"var(--color-text-primary)":"var(--color-text-secondary)"}}>{nm}</div>
                <div style={{fontSize:11,color:"var(--color-text-tertiary)",marginTop:2,lineHeight:1.35}}>{desc}</div>
                {p.earned ? (
                  <div style={{fontSize:10.5,fontWeight:700,color:"var(--color-accent)",marginTop:7}}>{p.count&&p.count>1?(t.badgeEarnedX||"Earned ×{n}").replace("{n}",p.count):(t.badgeEarned||"Earned")}</div>
                ) : (<>
                  <div style={{height:5,background:"var(--color-border-tertiary)",borderRadius:3,marginTop:8,overflow:"hidden"}}><div style={{width:`${p.pct}%`,height:"100%",background:"var(--color-accent)"}}/></div>
                  <div style={{fontSize:10,color:"var(--color-text-tertiary)",marginTop:4}}>{p.value.toLocaleString()} / {p.target.toLocaleString()}</div>
                </>)}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );

  if (screen==="challenges") return (
    <div style={Sb.root}><style>{CSS}</style>
      <AdBanners isPro={isPro}/>
      {notifToastEl}
      <div style={Sb.topbar} className="rv-topbar">
        <button style={Sb.backBtn} onClick={()=>{ if(activeChallenge){setActiveChallenge(null);} else {setScreen("group");} }}>← {activeChallenge?(t.backWord||"Back"):(activeGroup?.name||t.groupWord||"Group")}</button>
        <span style={{fontSize:12,fontWeight:600,color:"var(--color-text-secondary)"}}>{t.groupChallenges||"Challenges"}</span><span/>
      </div>
      <div className="rv-center-narrow" style={{padding:"18px 16px 40px"}}>
        {socialErr && <div style={{background:"var(--color-background-danger)",border:"1px solid var(--color-border-danger)",borderRadius:12,padding:"10px 14px",fontSize:13,color:"var(--color-text-danger)",marginBottom:14}}>{socialErr}</div>}
        {challengeBusy && <div style={{textAlign:"center",padding:"36px 0"}}><div className="spin-ring" style={{width:34,height:34,borderRadius:"50%",border:"3px solid var(--color-border-tertiary)",borderTopColor:"var(--color-accent)",margin:"0 auto"}}/></div>}

        {/* Detail view */}
        {!challengeBusy && activeChallenge && (()=>{
          const ch = activeChallenge;
          return (<>
            <h2 style={{...Sb.h2,fontSize:20,marginBottom:4}}>{ch.title}</h2>
            <div style={{fontSize:12,color:"var(--color-text-secondary)",marginBottom:16}}>{ch.mode==="teams"?(t.chalTeams||"Teams: A vs B"):(t.chalSolo||"Everyone for themselves")} · {(t.membersCount||"{n} members").replace("{n}",ch.results?.length||0).replace("members","played")}</div>
            {!ch.played ? (
              ch.mode==="teams" ? (
                <div style={{display:"flex",gap:10,marginBottom:18}}>
                  <button onClick={()=>playChallenge("A")} style={{...Sb.btnPrimary,flex:1,fontSize:13}}>{t.playTeamA||"Play for Team A"}</button>
                  <button onClick={()=>playChallenge("B")} style={{...Sb.btnPrimary,flex:1,fontSize:13,background:"#a3762b"}}>{t.playTeamB||"Play for Team B"}</button>
                </div>
              ) : (
                <button onClick={()=>playChallenge(null)} style={{...Sb.btnPrimary,width:"100%",marginBottom:18,fontSize:14,display:"inline-flex",alignItems:"center",justifyContent:"center",gap:7}}><Icon name="bolt" size={16}/>{t.playChallenge||"Play this challenge"}</button>
              )
            ) : <div style={{background:"var(--color-sel-tint)",border:"1px solid var(--color-accent)",borderRadius:12,padding:"11px 14px",fontSize:12.5,fontWeight:600,color:"var(--color-accent)",marginBottom:18,textAlign:"center"}}>{t.chalPlayed||"You've played. Here's how everyone did:"}</div>}

            {/* Team totals */}
            {ch.mode==="teams" && ch.teamTotals && (
              <div style={{display:"flex",gap:10,marginBottom:16}}>
                {["A","B"].map(tm=>{
                  const win = ch.teamTotals.A.score!==ch.teamTotals.B.score && ((tm==="A")===(ch.teamTotals.A.score>ch.teamTotals.B.score));
                  return (
                    <div key={tm} style={{flex:1,textAlign:"center",background:win?"var(--color-sel-tint)":"var(--color-background-primary)",border:"1px solid "+(win?"var(--color-accent)":"var(--color-border-secondary)"),borderRadius:14,padding:"14px 8px"}}>
                      <div style={{fontSize:11,fontWeight:700,letterSpacing:1,color:tm==="A"?"var(--color-accent)":"#a3762b",textTransform:"uppercase"}}>{(t.teamWord||"Team")} {tm}{win?" 🏆":""}</div>
                      <div style={{fontSize:26,fontWeight:800,color:"var(--color-text-primary)",fontFamily:"'Fraunces',Georgia,serif",lineHeight:1.1,marginTop:4}}>{ch.teamTotals[tm].score}</div>
                      <div style={{fontSize:11,color:"var(--color-text-tertiary)",marginTop:2}}>{(t.membersCount||"{n} members").replace("{n}",ch.teamTotals[tm].members)}</div>
                    </div>
                  );
                })}
              </div>
            )}
            {/* Standings */}
            <p style={Sb.secLabel}>{t.standings||"Standings"}</p>
            {ch.results?.length ? ch.results.map((r,i)=>(
              <div key={i} style={{display:"flex",alignItems:"center",gap:11,background:r.you?"var(--color-sel-tint)":"var(--color-background-primary)",border:"1px solid "+(r.you?"var(--color-accent)":"var(--color-border-secondary)"),borderRadius:12,padding:"10px 13px",marginBottom:8}}>
                <span style={{width:20,textAlign:"center",fontWeight:800,fontSize:13,color:i===0?"#a3762b":"var(--color-text-tertiary)",fontFamily:"monospace",flexShrink:0}}>{i+1}</span>
                <AvatarInitial name={r.username} size={28}/>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{display:"flex",alignItems:"center",gap:6,minWidth:0}}>
                    <span style={{fontSize:13.5,fontWeight:600,color:"var(--color-text-primary)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{r.username}{r.you?` · ${t.youWord||"you"}`:""}{r.team?` · ${(t.teamWord||"Team")} ${r.team}`:""}{i===0?" 👑":""}</span>
                    <Flair rank={r.rank} badge={r.badge} t={t} small/>
                  </div>
                </div>
                <div style={{fontSize:14,fontWeight:800,color:"var(--color-text-primary)",fontFamily:"monospace",flexShrink:0}}>{r.score}/{r.total}</div>
              </div>
            )) : <div style={{fontSize:12.5,color:"var(--color-text-tertiary)"}}>{t.chalNobody||"Nobody has played yet. Be the first!"}</div>}
          </>);
        })()}

        {/* List view */}
        {!challengeBusy && !activeChallenge && (<>
          {(()=>{
            const played=srs.stats?.challengePlayed||0, wins=srs.stats?.challengeWins||0;
            if(!played) return null;
            const rate=Math.round((wins/played)*100), strong=played>=3&&wins/played>=0.6;
            return (
              <div style={{background:strong?"var(--color-sel-tint)":"var(--color-background-primary)",border:"1px solid "+(strong?"var(--color-accent)":"var(--color-border-secondary)"),borderRadius:14,padding:"12px 14px",marginBottom:14}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",gap:8}}>
                  <span style={{fontSize:12,fontWeight:700,letterSpacing:.4,textTransform:"uppercase",color:"var(--color-text-secondary)"}}>{t.chalYourRecord||"Your record"}</span>
                  <span style={{fontSize:13,fontWeight:800,color:"var(--color-text-primary)",fontFamily:"monospace"}}>{(t.chalRecordLine||"{w} wins / {p} played").replace("{w}",wins).replace("{p}",played)} · {rate}%</span>
                </div>
                <div style={{fontSize:11.5,color:strong?"var(--color-accent)":"var(--color-text-tertiary)",marginTop:5,lineHeight:1.4}}>{strong?(t.chalRecordStrong||"You're on a winning streak, so Revyy is serving you harder, smarter questions."):(t.chalRecordHint||"Win more head-to-head and Revyy raises the difficulty of the questions it generates for you.")}</div>
              </div>
            );
          })()}
          <button onClick={()=>{setNewChalMode("solo");setShowNewChallenge(true);}} style={{...Sb.btnPrimary,width:"100%",marginBottom:14,fontSize:13,display:"inline-flex",alignItems:"center",justifyContent:"center",gap:7}}><Icon name="spark" size={15}/>{t.newChallenge||"New challenge"}</button>
          {chalList.length ? chalList.map(c=>(
            <div key={c.id} onClick={()=>openChallenge(c.id)} style={{background:"var(--color-background-primary)",border:"1px solid var(--color-border-secondary)",borderRadius:14,padding:"13px 14px",marginBottom:10,cursor:"pointer"}}>
              <div style={{display:"flex",justifyContent:"space-between",gap:8,alignItems:"center"}}>
                <div style={{fontSize:14,fontWeight:700,color:"var(--color-text-primary)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",minWidth:0}}>{c.title}</div>
                <span style={{flexShrink:0,fontSize:10,fontWeight:700,borderRadius:8,padding:"3px 8px",color:"#fff",background:c.mode==="teams"?"#a3762b":"var(--color-accent)"}}>{c.mode==="teams"?(t.teamsBadge||"TEAMS"):(t.soloBadge||"SOLO")}</span>
              </div>
              <div style={{fontSize:11.5,color:"var(--color-text-secondary)",marginTop:3}}>{(t.byWord||"by {n}").replace("{n}",c.by)} · {(t.playersCount||"{n} played").replace("{n}",c.players)}{c.myScore!=null?` · ${t.youWord||"you"} ${c.myScore}/${c.myTotal}`:""}</div>
            </div>
          )) : <div style={{fontSize:12.5,color:"var(--color-text-tertiary)"}}>{t.chalListEmpty||"No challenges yet. Create one from a shared study set and see who wins."}</div>}
        </>)}
      </div>

      {/* New challenge modal */}
      {showNewChallenge && (
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",zIndex:500,display:"flex",alignItems:"flex-end"}} onClick={()=>setShowNewChallenge(false)}>
          <div className="slide-up" onClick={e=>e.stopPropagation()} style={{background:"var(--color-background-primary)",borderRadius:"20px 20px 0 0",padding:"22px 18px 30px",width:"100%",maxWidth:520,margin:"0 auto",boxSizing:"border-box",maxHeight:"84vh",overflowY:"auto"}}>
            <h3 style={{margin:"0 0 4px",fontSize:18,fontWeight:700,fontFamily:"'Fraunces',Georgia,serif",color:"var(--color-text-primary)"}}>{t.newChallenge||"New challenge"}</h3>
            <p style={{fontSize:12.5,color:"var(--color-text-secondary)",margin:"0 0 12px",lineHeight:1.5}}>{t.newChalHint||"Everyone answers the same questions from a shared set. Pick the format, then the material."}</p>
            <div style={{marginBottom:14}}>
              <Segmented value={newChalMode} onChange={(o)=>setNewChalMode(o.value)} options={[
                {value:"solo",label:t.chalModeSolo||"1v1 / Free-for-all"},
                {value:"teams",label:t.chalModeTeams||"Teams"},
              ]}/>
            </div>
            <div style={{fontSize:12,fontWeight:700,color:"var(--color-text-secondary)",marginBottom:8}}>{t.pickMaterial||"Pick the material"}</div>
            {activeGroup?.library?.length ? activeGroup.library.map(d=>(
              <button key={d.id} onClick={()=>createChallenge(d,newChalMode)} style={{width:"100%",textAlign:"left",background:"var(--color-background-secondary)",border:"1px solid var(--color-border-secondary)",borderRadius:11,padding:"11px 13px",marginBottom:8,cursor:"pointer",fontFamily:"inherit"}}>
                <div style={{fontSize:13.5,fontWeight:600,color:"var(--color-text-primary)"}}>{d.title}</div>
                {d.subject&&<div style={{fontSize:11,color:"var(--color-text-tertiary)",marginTop:1}}>{d.subject}</div>}
              </button>
            )) : <div style={{fontSize:12.5,color:"var(--color-text-tertiary)"}}>{t.chalNeedLib||"Share a study set to the group first, then you can challenge on it."}</div>}
            <button onClick={()=>setShowNewChallenge(false)} style={{width:"100%",marginTop:6,background:"none",border:"none",color:"var(--color-text-tertiary)",fontSize:13,cursor:"pointer",fontFamily:"inherit",padding:"8px"}}>{t.cancel||"Cancel"}</button>
          </div>
        </div>
      )}
    </div>
  );

  // ── ENDLESS ARENA ─────────────────────────────────────────────────
  if (screen==="arena_intro") {
    const best = arenaBoardData?.you?.score ?? arenaResult?.best ?? null;
    // Subject-arena options: your own uploaded material first (the moat), then
    // the ready-made subjects. Each shows your personal best for that subject.
    const subjectSets = [
      ...(librarySize(srs.library) > 0 ? [{ id: "library", title: t.arenaYourMaterial || "Your material", subject: "", material: buildLibraryMaterial(srs.library) }] : []),
      ...STARTER_SUBJECTS,
    ];
    return (
      <div style={Sb.root}><style>{CSS}</style>
        <AdBanners isPro={isPro}/>
        <div style={Sb.topbar} className="rv-topbar">
          <button style={Sb.backBtn} onClick={()=>setScreen("upload")}>← {t.backWord}</button>
          <span style={Sb.brand}>{t.arenaTitle}</span><span/>
        </div>
        <div className="rv-center-narrow" style={{padding:"26px 16px 42px"}}>
          <div style={{textAlign:"center",marginBottom:20}}>
            <div style={{marginBottom:10,display:"flex",justifyContent:"center",color:"var(--color-accent)"}}><Icon name="bolt" size={40}/></div>
            <h2 style={{...Sb.h2,textAlign:"center",margin:"0 0 6px"}}>{t.arenaTitle}</h2>
            <p style={{fontSize:13,color:"var(--color-text-secondary)",lineHeight:1.55,maxWidth:360,margin:"0 auto"}}>{t.arenaTagline}</p>
          </div>
          {best!=null && (
            <div style={{textAlign:"center",background:"var(--color-background-primary)",border:"1px solid var(--color-border-secondary)",borderRadius:14,padding:"14px",marginBottom:16}}>
              <div style={{fontSize:10,fontWeight:700,letterSpacing:1,color:"var(--color-text-tertiary)",textTransform:"uppercase"}}>{t.arenaYourBest}</div>
              <div style={{fontSize:34,fontWeight:800,color:"var(--color-accent)",fontFamily:"'Fraunces',Georgia,serif",lineHeight:1.1}}>{best.toLocaleString()}</div>
            </div>
          )}
          {arenaErr && <div style={{background:"var(--color-background-danger)",border:"0.5px solid #fecaca",borderRadius:10,padding:"10px 14px",fontSize:13,color:"var(--color-text-danger)",marginBottom:14}}>{arenaErr}</div>}
          <button style={{...Sb.btnPrimary,width:"100%",display:"inline-flex",alignItems:"center",justifyContent:"center",gap:8,fontSize:16}} onClick={startArena}><Icon name="bolt" size={17}/>{t.arenaPlay}</button>
          {SHOW_ARENA_LEADERBOARD && <button style={{...Sb.btnOutline,width:"100%",marginTop:10,display:"inline-flex",alignItems:"center",justifyContent:"center",gap:7}} onClick={openArenaBoard}><Icon name="trophy" size={16}/>{t.arenaLeaderboard}</button>}
          <div style={{marginTop:24}}>
            <div style={{fontSize:11,fontWeight:700,letterSpacing:1,color:"var(--color-text-tertiary)",textTransform:"uppercase",marginBottom:10,textAlign:"center"}}>{t.arenaSubjectLabel||"Or race on your subject"}</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
              {subjectSets.map(s=>{ const sb=srs.subjectArena?.[s.id||s.subject||s.title];
                return (
                  <button key={s.id||s.title} onClick={()=>startSubjectArena(s)} className="rv-tile" style={{...Sb.navTile,padding:"12px 13px",gap:3,cursor:"pointer",textAlign:"left",alignItems:"flex-start"}}>
                    <div style={{fontWeight:700,fontSize:13,color:"var(--color-text-primary)",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",maxWidth:"100%"}}>{s.title}</div>
                    <div style={{fontSize:10.5,color: sb?"var(--color-accent)":"var(--color-text-secondary)",fontWeight:sb?700:400}}>{sb?`${t.arenaBestShort||"Best"} ${sb.toLocaleString()}`:(s.subject||t.arenaSubjectGo||"Play")}</div>
                  </button>
                );
              })}
            </div>
            <p style={{fontSize:11,color:"var(--color-text-tertiary)",marginTop:9,textAlign:"center",lineHeight:1.5}}>{t.arenaSubjectNote||"Questions are generated from the subject, so it counts toward your daily limit. Personal challenge, not the global board."}</p>
          </div>
          <div style={{marginTop:22,display:"flex",flexDirection:"column",gap:11}}>
            {[["bolt",t.arenaHow1],["target",t.arenaHow2],["gem",t.arenaHow3]].map(([ic,tx],i)=>(
              <div key={i} style={{display:"flex",gap:11,alignItems:"flex-start",fontSize:12.5,color:"var(--color-text-secondary)",lineHeight:1.5}}>
                <span style={{color:"var(--color-accent)",flexShrink:0,marginTop:1}}><Icon name={ic} size={15}/></span><span>{tx}</span>
              </div>
            ))}
          </div>
        </div>
        {showUsername && <UsernameModal value={unameInput} onChange={setUnameInput} onSave={submitUsername} onSkip={skipUsername} err={unameErr} busy={unameBusy} t={t}/>}
      </div>
    );
  }
  if (screen==="arena_gen") return (
    <div style={{...Sb.root,alignItems:"center",justifyContent:"center",padding:"0 24px",textAlign:"center",minHeight:"100vh",display:"flex",flexDirection:"column"}}><style>{CSS}</style>
      <div className="spin-ring" style={{width:48,height:48,borderRadius:"50%",border:"4px solid var(--color-border-tertiary)",borderTopColor:"var(--color-accent)"}}/>
      <h2 style={{...Sb.h2,textAlign:"center",marginTop:24}}>{t.arenaLoading}</h2>
    </div>
  );
  if (screen==="arena_play") return (
    <div style={Sb.root}><style>{CSS}</style>
      <div style={Sb.topbar} className="rv-topbar">
        <button style={Sb.backBtn} onClick={()=>{ if(typeof window!=="undefined" && window.confirm(t.arenaQuitConfirm)) setScreen("arena_intro"); }}>✕</button>
        <span style={Sb.brand}>{t.arenaTitle}</span><span/>
      </div>
      <ArenaGame key={`${arenaQs[0]?.id||0}_${arenaQs.length}`} questions={arenaQs} t={t} onEnd={onArenaEnd} initialPowerups={srs.wallet} onUsePowerup={srs.usePowerup}/>
    </div>
  );
  if (screen==="arena_over" && arenaResult) {
    const r = arenaResult;
    return (
      <div style={Sb.root}><style>{CSS}</style>
        {badgeToastEl}{rankToastEl}{streakToastEl}{promotionEl}{notifToastEl}{burstConfetti&&<Confetti/>}
        <AdBanners isPro={isPro}/>
        <div style={{background:"#312e81",padding:"36px 20px 28px",textAlign:"center"}}>
          {r.subject && <div style={{fontSize:12,fontWeight:700,color:"rgba(255,255,255,0.75)",marginBottom:8,display:"inline-flex",alignItems:"center",gap:6}}><Icon name="bolt" size={13}/>{r.subject.title}</div>}
          {r.isBest && <div style={{fontSize:12,fontWeight:800,letterSpacing:1,color:"#fcd34d",textTransform:"uppercase",marginBottom:6}}>{t.arenaNewBest}</div>}
          <div style={{fontSize:11,fontWeight:700,letterSpacing:1,color:"rgba(255,255,255,0.7)",textTransform:"uppercase"}}>{r.isBest?t.arenaScoreLbl:t.arenaRunScore}</div>
          <div style={{fontSize:58,fontWeight:800,color:"#fff",fontFamily:"'Fraunces',Georgia,serif",lineHeight:1.1}}>{(r.score||0).toLocaleString()}</div>
          <div style={{fontSize:13,color:"rgba(255,255,255,0.7)"}}>{t.arenaInQuestions.replace("{n}",r.questions||0)}</div>
          {!r.isBest && r.best!=null && <div style={{fontSize:12,color:"rgba(255,255,255,0.55)",marginTop:6}}>{t.arenaBestIs.replace("{n}",(r.best||0).toLocaleString())}</div>}
        </div>
        <div className="rv-center" style={{padding:"22px 16px 40px"}}>
          {r.earned && (
            <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:8,background:"var(--color-sel-tint)",border:"1px solid var(--color-accent)",borderRadius:12,padding:"11px 14px",marginBottom:16}}>
              <Icon name="gem" size={16}/>
              <span style={{fontSize:13.5,fontWeight:700,color:"var(--color-text-primary)"}}>{(t.rewardEarned||"You earned a {p} power-up!").replace("{p}",pupName(t,r.earned))}</span>
            </div>
          )}
          <div style={{display:"flex",gap:10,marginBottom:18}}>
            {[[t.arenaFreeze,r.freeze],[t.arenaHint,r.hint],[t.arenaSkip,r.skip]].map(([lbl,n],i)=>(
              <div key={i} style={{flex:1,textAlign:"center",background:"var(--color-background-primary)",border:"0.5px solid var(--color-border-tertiary)",borderRadius:12,padding:"11px 6px"}}>
                <div style={{fontSize:19,fontWeight:800,color:"var(--color-accent)",fontFamily:"monospace"}}>{n||0}</div>
                <div style={{fontSize:11,color:"var(--color-text-secondary)",fontWeight:600}}>{lbl}</div>
              </div>
            ))}
          </div>
          <button style={{...Sb.btnPrimary,width:"100%",display:"inline-flex",alignItems:"center",justifyContent:"center",gap:8}} onClick={()=>{ if(r.subject?.set) startSubjectArena(r.subject.set); else startArena(); }}><Icon name="repeat" size={16}/>{t.arenaPlayAgain}</button>
          {!r.subject && SHOW_ARENA_LEADERBOARD && <button style={{...Sb.btnOutline,width:"100%",marginTop:10,display:"inline-flex",alignItems:"center",justifyContent:"center",gap:7}} onClick={openArenaBoard}><Icon name="trophy" size={16}/>{t.arenaLeaderboard}</button>}
          {r.subject && <button style={{...Sb.btnOutline,width:"100%",marginTop:10,display:"inline-flex",alignItems:"center",justifyContent:"center",gap:7}} onClick={()=>setScreen("arena_intro")}><Icon name="bolt" size={16}/>{t.arenaOtherSubjects||"Pick another subject"}</button>}
          <button style={{width:"100%",background:"none",border:"none",color:"var(--color-text-tertiary)",fontSize:12.5,cursor:"pointer",fontFamily:"inherit",padding:"14px 4px 0"}} onClick={()=>setScreen("upload")}>{t.arenaHome}</button>
        </div>
      </div>
    );
  }
  if (screen==="arena_board") {
    const b = arenaBoardData;
    return (
      <div style={Sb.root}><style>{CSS}</style>
        <AdBanners isPro={isPro}/>
        <div style={Sb.topbar} className="rv-topbar">
          <button style={Sb.backBtn} onClick={()=>setScreen(arenaResult?"arena_over":"arena_intro")}>← {t.backWord}</button>
          <span style={Sb.brand}>{t.arenaLeaderboard}</span><span/>
        </div>
        <div className="rv-center-narrow" style={{padding:"20px 16px 40px"}}>
          {arenaBusy && <div style={{textAlign:"center",padding:"36px 0",color:"var(--color-text-tertiary)"}}><div className="spin-ring" style={{width:34,height:34,borderRadius:"50%",border:"3px solid var(--color-border-tertiary)",borderTopColor:"var(--color-accent)",margin:"0 auto"}}/></div>}
          {!arenaBusy && (<>
            {/* Your competitive Arena RANK (Novice..Luminary from your best run),
                with this month's season standing below. */}
            {(()=>{ const best=srs.stats?.arenaBest||0; const ar=best>0?rankFor(best):null; const r=ar||{color:"#9ca3af",icon:"rank_unranked",key:"unranked",name:"Unranked"}; const nm=ar?((t["rank_"+r.key])||r.name):(t.unranked||"Unranked"); const nextNm=ar&&ar.next?((t["rank_"+ar.next.key])||ar.next.name):null; const toNextPts=ar&&ar.next?Math.max(0,ar.next.min-best):0; const st=arenaSeasonData; const days=st?.endsAt?Math.max(0,Math.ceil((new Date(st.endsAt).getTime()-Date.now())/86400000)):null; return (
              <div style={{background:`linear-gradient(135deg, ${r.color}22, ${r.color}0d)`,border:`1px solid ${r.color}66`,borderRadius:16,padding:16,marginBottom:14}}>
                <div style={{display:"flex",alignItems:"center",gap:13}}>
                  <div style={{width:52,height:52,borderRadius:14,flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center",background:r.color+"26"}} aria-hidden="true"><Icon name={r.icon} size={26} stroke={1.8} style={{color:r.color}}/></div>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:10.5,fontWeight:800,letterSpacing:.5,textTransform:"uppercase",color:"var(--color-text-tertiary)"}}>{t.arenaRankLabel||"Arena rank"}</div>
                    <div style={{fontSize:19,fontWeight:800,fontFamily:"'Fraunces',Georgia,serif",color:r.color}}>{nm}</div>
                  </div>
                  <div style={{textAlign:"right",flexShrink:0}}>
                    <div style={{fontSize:19,fontWeight:800,fontFamily:"monospace",color:"var(--color-text-primary)"}}>{best.toLocaleString()}</div>
                    <div style={{fontSize:10.5,color:"var(--color-text-tertiary)"}}>{t.arenaBestLabel||"best run"}</div>
                  </div>
                </div>
                {ar && ar.next ? (<>
                  <div style={{height:7,background:"var(--color-border-tertiary)",borderRadius:4,marginTop:13,overflow:"hidden"}}><div style={{width:`${Math.round((ar.toNext||0)*100)}%`,height:"100%",background:r.color}}/></div>
                  <div style={{fontSize:11,color:"var(--color-text-secondary)",marginTop:6}}>{(t.arenaToNextRank||"+{n} pts to {r}").replace("{n}",toNextPts.toLocaleString()).replace("{r}",nextNm)}</div>
                </>) : ar ? <div style={{fontSize:11,color:"var(--color-text-secondary)",marginTop:12}}>{t.arenaTopRank||"Top rank. A Luminary of the Arena."}</div> : <div style={{fontSize:11,color:"var(--color-text-secondary)",marginTop:12}}>{t.arenaUnrankedHint||"Play the Endless Arena to get ranked."}</div>}
                {st?.you && days!=null && <div style={{fontSize:11,color:"var(--color-text-secondary)",marginTop:10,paddingTop:10,borderTop:`0.5px solid ${r.color}33`,display:"flex",justifyContent:"space-between",gap:8}}><span>{(t.arenaSeasonPos||"#{r} of {n} this season").replace("{r}",st.you.rank).replace("{n}",st.players)}</span><span style={{color:"var(--color-text-tertiary)"}}>{days===0?(t.arenaSeasonEndsToday||"Ends today"):(t.arenaSeasonEnds||"{n}d left").replace("{n}",days)}</span></div>}
              </div>
            ); })()}
            <div style={{marginBottom:12}}><Seg options={[["season",t.arenaThisSeason||"This season"],["all",t.arenaAllTime||"All time"]]} value={arenaTab} onChange={setArenaTab}/></div>

            {arenaTab==="season" && ((arenaSeasonData?.top?.length) ? (
              <div style={{border:"1px solid var(--color-border-secondary)",borderRadius:14,overflow:"hidden",background:"var(--color-background-primary)"}}>
                {arenaSeasonData.top.map((row,i)=>(
                  <div key={i} style={{display:"grid",gridTemplateColumns:"30px 1fr auto",gap:10,alignItems:"center",padding:"11px 14px",borderBottom:i<arenaSeasonData.top.length-1?"0.5px solid var(--color-border-tertiary)":"none"}}>
                    <span style={{fontFamily:"monospace",fontWeight:700,fontSize:14,textAlign:"center",color:i===0?"#d97706":i===1?"#94a3b8":i===2?"#b45309":"var(--color-text-tertiary)"}}>{i+1}</span>
                    <div style={{minWidth:0}}>
                      <div style={{display:"flex",alignItems:"center",gap:6,minWidth:0}}>
                        <span style={{fontWeight:600,fontSize:14,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{row.name}</span>
                        <Flair rank={row.rank} badge={row.badge} t={t} small/>
                      </div>
                      <div style={{fontSize:10.5,color:"var(--color-text-tertiary)",fontFamily:"monospace"}}>{t.arenaQCount.replace("{n}",row.questions)}</div>
                    </div>
                    <span style={{fontFamily:"monospace",fontWeight:700,fontSize:15}}>{(row.score||0).toLocaleString()}</span>
                  </div>
                ))}
              </div>
            ) : <div style={{textAlign:"center",padding:"26px 18px",background:"var(--color-background-primary)",border:"0.5px solid var(--color-border-tertiary)",borderRadius:16,fontSize:13,color:"var(--color-text-secondary)"}}>{t.arenaSeasonEmpty||"No scores yet this season. Play a run to claim the top spot."}</div>)}

            {arenaTab==="all" && b && b.locked && (
              <div style={{textAlign:"center",padding:"26px 18px",background:"var(--color-background-primary)",border:"0.5px solid var(--color-border-tertiary)",borderRadius:16}}>
                <div style={{display:"flex",justifyContent:"center",color:"var(--color-text-tertiary)",marginBottom:12}}><Icon name="lock" size={28}/></div>
                <h3 style={{margin:"0 0 8px",fontSize:18,fontWeight:700,fontFamily:"'Fraunces',Georgia,serif"}}>{t.arenaLockedTitle}</h3>
                <p style={{fontSize:13,color:"var(--color-text-secondary)",lineHeight:1.5,maxWidth:320,margin:"0 auto 16px"}}>{t.arenaLockedSub.replace("{need}",b.need).replace("{have}",b.players)}</p>
                <div style={{height:8,borderRadius:4,background:"var(--color-background-secondary)",overflow:"hidden",maxWidth:260,margin:"0 auto"}}>
                  <div style={{height:"100%",width:`${Math.min(100,(b.players/b.need)*100)}%`,background:"var(--color-accent)",borderRadius:4}}/>
                </div>
                <div style={{fontSize:12,fontFamily:"monospace",color:"var(--color-text-tertiary)",marginTop:8}}>{b.players} / {b.need}</div>
                {b.you && <div style={{marginTop:18,fontSize:13,color:"var(--color-text-secondary)"}}>{t.arenaBestIs.replace("{n}",(b.you.score||0).toLocaleString())}</div>}
              </div>
            )}
            {arenaTab==="all" && b && !b.locked && (<>
              {b.you && <div style={{background:"var(--color-sel-tint)",border:"1px solid var(--color-accent)",borderRadius:12,padding:"12px 14px",marginBottom:12,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <span style={{fontWeight:700,fontSize:14}}>{t.arenaYouRank.replace("{r}",b.you.rank||"—")}</span>
                <span style={{fontFamily:"monospace",fontWeight:700,color:"var(--color-accent)"}}>{(b.you.score||0).toLocaleString()}</span>
              </div>}
              <p style={{fontSize:10.5,color:"var(--color-text-tertiary)",margin:"0 0 8px 2px"}}>{t.arenaBoardLegend}</p>
              <div style={{border:"1px solid var(--color-border-secondary)",borderRadius:14,overflow:"hidden",background:"var(--color-background-primary)"}}>
                {(b.top||[]).map((row,i)=>(
                  <div key={i} style={{display:"grid",gridTemplateColumns:"30px 1fr auto",gap:10,alignItems:"center",padding:"11px 14px",borderBottom:i<b.top.length-1?"0.5px solid var(--color-border-tertiary)":"none"}}>
                    <span style={{fontFamily:"monospace",fontWeight:700,fontSize:14,textAlign:"center",color:i===0?"#d97706":i===1?"#94a3b8":i===2?"#b45309":"var(--color-text-tertiary)"}}>{i+1}</span>
                    <div style={{minWidth:0}}>
                      <div style={{display:"flex",alignItems:"center",gap:6,minWidth:0}}>
                        <span style={{fontWeight:600,fontSize:14,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{row.name}</span>
                        <Flair rank={row.rank} badge={row.badge} t={t} small/>
                      </div>
                      <div style={{fontSize:10.5,color:"var(--color-text-tertiary)",fontFamily:"monospace"}}>{t.arenaQCount.replace("{n}",row.questions)} · {row.freeze}/{row.hint}/{row.skip}</div>
                    </div>
                    <span style={{fontFamily:"monospace",fontWeight:700,fontSize:15}}>{(row.score||0).toLocaleString()}</span>
                  </div>
                ))}
              </div>
            </>)}
          </>)}
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
            style={{display:"flex",alignItems:"center",gap:12,background:"var(--color-background-primary)",border:"1px solid var(--color-border-secondary)",borderRadius:14,padding:"14px 16px",marginBottom:10,cursor:"pointer"}} className="exam-type-card">
            <div style={{width:46,height:46,borderRadius:11,background:"#312e81",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,color:"#fff",fontWeight:800,fontSize:13,letterSpacing:0.2,fontFamily:"'Fraunces',Georgia,serif"}}>{exam.name.split("/")[0].slice(0,4)}</div>
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
          <div style={{display:"flex",alignItems:"flex-start",gap:8,background:"#fffbeb",border:"0.5px solid #f59e0b44",borderRadius:10,padding:"11px 14px",fontSize:12,color:"#92400e",lineHeight:1.5,marginBottom:14}}><Icon name="clock" size={15} style={{flexShrink:0,marginTop:1}}/><span>{t.mockWarn}</span></div>
          {mockGenErr && <div style={{background:"var(--color-background-danger)",border:"0.5px solid #fecaca",borderRadius:10,padding:"10px 14px",fontSize:13,color:"var(--color-text-danger)",marginBottom:14,display:"flex",alignItems:"flex-start",gap:7}}><Icon name="alert" size={15} style={{flexShrink:0,marginTop:1}}/><span>{mockGenErr}</span></div>}
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
            <div style={{background:"var(--color-background-primary)",border:"1px solid var(--color-border-secondary)",borderRadius:14,padding:"16px 18px",maxWidth:360,width:"100%",boxSizing:"border-box",marginBottom:20}}>
              <div style={{fontSize:10.5,fontWeight:800,letterSpacing:0.8,color:"var(--color-text-tertiary)",textTransform:"uppercase",marginBottom:6}}>{t.mockUpNext}</div>
              <div style={{fontSize:18,fontWeight:700,color:"var(--color-text-primary)",fontFamily:"'Fraunces',Georgia,serif"}}>{next.name}</div>
              <div style={{fontSize:12.5,color:"var(--color-text-secondary)",marginTop:4}}>{next.count} {t.questionsLow} · {next.minutes} min</div>
            </div>
          )}
          {mockGenErr && <div style={{display:"flex",alignItems:"center",gap:8,background:"var(--color-background-danger)",border:"0.5px solid #fecaca",borderRadius:10,padding:"10px 14px",fontSize:13,color:"var(--color-text-danger)",marginBottom:14,maxWidth:360,width:"100%",boxSizing:"border-box"}}><Icon name="alert" size={15} style={{flexShrink:0}}/><span>{mockGenErr}</span></div>}
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
        <div style={{background:"#312e81",padding:"34px 20px 26px",textAlign:"center"}}>
          <div style={{fontSize:11,fontWeight:700,letterSpacing:1,color:"rgba(255,255,255,0.7)",textTransform:"uppercase"}}>{mock.name} {t.mockComposite}</div>
          <div style={{fontSize:58,fontWeight:800,color:"#fff",fontFamily:"'Fraunces',Georgia,serif",lineHeight:1.1}}>{sc.composite}</div>
          <div style={{fontSize:13,color:"rgba(255,255,255,0.7)"}}>{t.mockOutOf} {sc.compositeMax}</div>
          {sc.goodScore!=null && <div style={{fontSize:11.5,color:"rgba(255,255,255,0.55)",marginTop:6}}>{(t.mockGoodScore||"A strong score is around {n}+").replace("{n}",sc.goodScore)}</div>}
        </div>
        <div className="rv-center" style={{padding:"20px 16px 40px"}}>
          {earnedReward && (
            <div style={{display:"flex",alignItems:"center",gap:10,background:"var(--color-sel-tint)",border:"1px solid var(--color-accent)",borderRadius:12,padding:"11px 14px",marginBottom:16}}>
              <Icon name="gem" size={18} style={{color:"var(--color-accent)",flexShrink:0}}/>
              <span style={{flex:1,fontSize:12.5,fontWeight:700,color:"var(--color-text-primary)",lineHeight:1.4}}>{(t.rewardEarned||"You earned a {p} power-up!").replace("{p}",pupName(t,earnedReward))}</span>
            </div>
          )}
          {/* Retake motivation: cheer an improvement, soften a dip. */}
          {mockPrev && (() => {
            const cur = sc.composite, prev = mockPrev.composite;
            const up = cur > prev, down = cur < prev;
            const bg = up?"var(--color-background-success)":down?"#fffbeb":"var(--color-sel-tint)";
            const bd = up?"var(--color-border-success)":down?"#fcd34d":"var(--color-accent)";
            const col = up?"var(--color-text-success)":down?"#92400e":"var(--color-accent)";
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

  return <SettingsPanel draft={settingsDraft} update={updateDraft} onApply={applySettings} onCancel={cancelSettings} onSignOut={()=>signOut()} onDeleteAccount={confirmDeleteAccount} requiresPassword={requiresPassword} onReauthenticate={reauthenticate} isPro={isPro} onManageSubscription={openPortal} signedIn={!!user} onOpenStreak={()=>{setShowSettings(false);setScreen("home");setShowStreak(true);}} onOpenAccuracy={()=>{setShowSettings(false);setScreen("home");setOpenCard(c=>({...c,mastery:true}));}} onOpenReview={()=>{setShowSettings(false);if(srs.dueCards.length)startReview();else startQuick10();}} t={t}/>;
}













