// App-scoped styles for StudyQuiz: the inline style bag (Sb) and the global
// CSS string injected via a <style> tag. Pure data, no JS references, so this
// lives on its own instead of tailing the 7k-line component file.
export const Sb = {
  root:        { minHeight:"100vh", background:"var(--color-background-tertiary)", color:"var(--color-text-primary)", fontFamily:"'DM Sans','Helvetica Neue',sans-serif", display:"flex", flexDirection:"column" },
  brand:       { fontFamily:"'Fraunces',Georgia,serif", fontSize:16, fontWeight:700, color:"var(--color-text-primary)", letterSpacing:0.5, display:"flex", alignItems:"center", gap:8 },
  hero:        { background:"#312e81", padding:"26px 24px 28px" },
  h1:          { fontFamily:"'Fraunces',Georgia,serif", fontSize:32, fontWeight:700, color:"#fff", lineHeight:1.15, letterSpacing:-0.5, margin:"14px 0 12px" },
  h2:          { fontFamily:"'Fraunces',Georgia,serif", fontSize:22, fontWeight:700, color:"var(--color-text-primary)", letterSpacing:-0.3, margin:"0 0 16px" },
  secLabel:    { fontSize:11, fontWeight:700, color:"var(--color-text-tertiary)", letterSpacing:1.5, margin:"0 0 12px", textTransform:"uppercase" },
  navTile:     { background:"var(--color-background-primary)", border:"1px solid var(--color-border-secondary)", borderRadius:14, padding:"14px", cursor:"pointer", display:"flex", flexDirection:"column", gap:10, minWidth:0 },
  navTileTitle:{ fontWeight:700, fontSize:14, color:"var(--color-text-primary)", letterSpacing:-0.1, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" },
  navTileSub:  { fontSize:11.5, marginTop:2, lineHeight:1.45, color:"var(--color-text-secondary)", overflow:"hidden", textOverflow:"ellipsis" },
  fCard:       { background:"var(--color-background-primary)", borderRadius:14, padding:"15px 14px", border:"1px solid var(--color-border-secondary)", display:"flex", flexDirection:"column", gap:5, cursor:"default" },
  planCard:    { flex:1, background:"var(--color-background-primary)", borderRadius:14, padding:"16px 15px", border:"1px solid var(--color-border-secondary)" },
  topbar:      { display:"flex", justifyContent:"space-between", alignItems:"center", padding:"12px 16px", background:"var(--color-background-primary)", borderBottom:"0.5px solid var(--color-border-tertiary)", position:"sticky", top:0, zIndex:10 },
  backBtn:     { background:"none", border:"none", cursor:"pointer", fontSize:13, color:"var(--color-text-secondary)", fontFamily:"inherit", padding:0, fontWeight:500 },
  dropzone:    { border:"1.5px dashed var(--color-border-secondary)", borderRadius:16, padding:"28px 20px", minHeight:230, cursor:"pointer", background:"var(--color-background-primary)", textAlign:"center", marginBottom:14, transition:"all 0.2s", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:8 },
  textarea:    { width:"100%", height:180, borderRadius:12, border:"0.5px solid var(--color-border-secondary)", background:"var(--color-background-primary)", color:"var(--color-text-primary)", fontSize:14, padding:"13px 14px", resize:"vertical", fontFamily:"inherit", outline:"none", marginBottom:14, boxSizing:"border-box", lineHeight:1.6 },
  settingsBox: { background:"var(--color-background-primary)", borderRadius:12, border:"0.5px solid var(--color-border-tertiary)", marginBottom:14, overflow:"hidden" },
  settingRow:  { display:"flex", alignItems:"center", justifyContent:"space-between", padding:"11px 14px", borderBottom:"0.5px solid var(--color-border-tertiary)", gap:10, flexWrap:"wrap" },
  settingLabel:{ fontSize:13, fontWeight:600, color:"var(--color-text-primary)", flexShrink:0 },
  langSel:     { background:"var(--color-background-secondary)", border:"0.5px solid var(--color-border-secondary)", borderRadius:8, padding:"5px 8px", fontSize:12, color:"var(--color-text-primary)", cursor:"pointer", fontFamily:"inherit", outline:"none" },
  btnPrimary:  { background:"#4338ca", color:"#fff", border:"none", borderRadius:12, padding:"13px 20px", fontSize:15, fontWeight:600, cursor:"pointer", fontFamily:"inherit", letterSpacing:0.1, boxShadow:"0 1px 2px rgba(35,31,26,0.12)", transition:"opacity 0.15s, box-shadow 0.15s", margin:0 },
  btnHero:     { background:"#fff", color:"#312e81", border:"none", borderRadius:12, padding:"13px 30px", fontSize:15, fontWeight:700, cursor:"pointer", fontFamily:"inherit" },
  btnOutline:  { background:"none", color:"var(--color-text-primary)", border:"1px solid var(--color-border-secondary)", borderRadius:12, padding:"12px 20px", fontSize:13, fontWeight:500, cursor:"pointer", fontFamily:"inherit" },
  btnGhost:    { background:"none", color:"var(--color-text-secondary)", border:"0.5px solid var(--color-border-tertiary)", borderRadius:12, padding:"11px 20px", fontSize:13, cursor:"pointer", fontFamily:"inherit" },
  coachLabel:  { display:"block", fontSize:12, fontWeight:700, color:"var(--color-text-secondary)", margin:"0 0 6px", letterSpacing:0.2 },
  coachInput:  { width:"100%", borderRadius:10, border:"1.5px solid var(--color-border-secondary)", background:"var(--color-background-primary)", color:"var(--color-text-primary)", fontSize:14, padding:"11px 13px", fontFamily:"inherit", outline:"none", boxSizing:"border-box", marginBottom:14 },
};

export const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600;9..144,700&family=DM+Sans:opsz,wght@9..40,400..800&display=swap');
  *{box-sizing:border-box} body{margin:0}
  /* Small-font zoom (body{zoom:0.9}) leaves a gap below the app; painting html
     with the theme colour stops a white rectangle showing through there. */
  html,body{background:var(--color-background-tertiary);-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;text-rendering:optimizeLegibility}
  /* Modern polish: crisp selection, an accessible accent focus ring on controls. */
  ::selection{background:var(--color-sel-tint)}
  button:focus-visible,a:focus-visible,[role="button"]:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible{outline:2px solid var(--color-accent);outline-offset:2px}
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
  @keyframes flameFlicker{0%,100%{transform:scale(1) rotate(-2deg)}50%{transform:scale(1.06) rotate(2deg)}}
  @keyframes flameFlickerHot{0%,100%{transform:scale(1) rotate(-3deg)}25%{transform:scale(1.1) rotate(2deg)}50%{transform:scale(0.96) rotate(-2deg)}75%{transform:scale(1.12) rotate(3deg)}}
  .rv-flame{display:inline-block;transform-origin:center bottom;animation:flameFlicker 1.6s ease-in-out infinite}
  .rv-flame-hot{animation:flameFlickerHot 0.85s ease-in-out infinite}
  @keyframes badgePop{0%{transform:scale(0.7);opacity:0}55%{transform:scale(1.08)}100%{transform:scale(1);opacity:1}}
  .rv-badge-pop{animation:badgePop 0.42s cubic-bezier(.34,1.56,.64,1) both}
  @keyframes rankBurst{0%{transform:scale(0.6);opacity:0}50%{transform:scale(1.12);opacity:1}100%{transform:scale(1);opacity:1}}
  .rv-rank-burst{animation:rankBurst 0.5s cubic-bezier(.34,1.56,.64,1) both}
  /* Rank promotion celebration */
  @keyframes rvPromoIn{from{opacity:0}to{opacity:1}}
  @keyframes rvPromoCard{0%{transform:translateY(18px) scale(.9);opacity:0}60%{transform:translateY(0) scale(1.03)}100%{transform:translateY(0) scale(1);opacity:1}}
  @keyframes rvPromoSpin{to{transform:rotate(360deg)}}
  @keyframes rvPromoGlow{0%,100%{transform:scale(.9);opacity:.5}50%{transform:scale(1.12);opacity:.9}}
  @keyframes rvPromoBadge{0%{transform:scale(0) rotate(-12deg)}55%{transform:scale(1.18) rotate(4deg)}100%{transform:scale(1) rotate(0)}}
  @keyframes rvPromoShimmer{0%{transform:translateX(-140%) skewX(-16deg)}100%{transform:translateX(320%) skewX(-16deg)}}
  .rv-promo-wrap{animation:rvPromoIn .28s ease both}
  .rv-promo-card{animation:rvPromoCard .55s cubic-bezier(.34,1.56,.64,1) both}
  .rv-promo-rays{position:absolute;inset:-6px;border-radius:50%;filter:blur(1.5px);opacity:.9;transform-origin:50% 50%;animation:rvPromoSpin 10s linear infinite,rvPromoIn .7s ease both}
  .rv-promo-glow{position:absolute;inset:10px;border-radius:50%;animation:rvPromoGlow 2.3s ease-in-out infinite}
  .rv-promo-disc{position:absolute;inset:38px;border-radius:50%;display:flex;align-items:center;justify-content:center}
  .rv-promo-badge{animation:rvPromoBadge .7s cubic-bezier(.34,1.7,.5,1) .14s both}
  .rv-promo-shimmer{position:absolute;top:0;bottom:0;left:0;width:36%;pointer-events:none;background:linear-gradient(90deg,transparent,rgba(255,255,255,.35),transparent);animation:rvPromoShimmer 1.25s ease .4s both}
  @media (prefers-reduced-motion: reduce){.rv-promo-rays,.rv-promo-glow,.rv-promo-badge,.rv-promo-shimmer,.rv-promo-card{animation-duration:.01ms!important;animation-iteration-count:1!important}}
  .step{animation:fadeIn 0.4s ease forwards;opacity:0}
  .step-0{animation-delay:0.3s}.step-1{animation-delay:0.8s}.step-2{animation-delay:1.3s}.step-3{animation-delay:1.8s}
  .exam-type-card:hover{transform:translateY(-2px);box-shadow:0 4px 16px rgba(67,56,202,0.18)!important;border-color:#4338ca!important;background:var(--color-hover-tint)!important}
  button:hover:not(:disabled){transform:translateY(-1px)}
  .rv-tile{transition:transform .15s ease,border-color .15s ease,box-shadow .15s ease}
  .rv-tile:hover{transform:translateY(-1px);border-color:#4338ca;box-shadow:0 4px 14px rgba(67,56,202,0.12)}
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
  ::-webkit-scrollbar{width:8px;height:8px}::-webkit-scrollbar-thumb{background:var(--color-border-primary);border-radius:5px;border:2px solid transparent;background-clip:content-box}::-webkit-scrollbar-thumb:hover{background:var(--color-text-tertiary);background-clip:content-box}::-webkit-scrollbar-track{background:transparent}

  /* Hero (mobile base, stacks: back, brand bar, headline, sub, CTA) */
  .rv-hero-top{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px;}
  .rv-hero-bar{display:flex;align-items:center;justify-content:space-between;gap:12px;}
  .rv-hero-tools{display:flex;align-items:center;gap:10px;}
  .rv-hero-sub{margin-top:14px!important;}
  .rv-hero-cta{margin-top:22px;}

  /* ── Desktop layout ────────────────────────────────────────────── */
  @media(min-width:768px){
    /* Root: wider centered card */
    .rv-root-inner{max-width:900px;margin:0 auto;width:100%;}

    /* Hero: a clean app header - account tools on the top row (right), then the
       brand, then the greeting, all left-aligned. */
    .rv-hero-inner{max-width:760px;margin:0 auto;width:100%;}
    .rv-hero-head{font-size:32px!important;margin:12px 0 0!important;text-align:left;}

    /* Home body: fill a comfortable centered width so it never looks cramped. */
    .rv-home-body{max-width:760px;margin:0 auto;width:100%;padding:28px 40px 44px!important;}
    .rv-home-body .rv-feat-grid{grid-template-columns:repeat(3,1fr)!important;}
    .rv-plans-row{gap:16px!important;}

    /* Topbar full width with more breathing room */
    .rv-topbar{padding:12px 40px!important;}

    /* Upload: left=file input, right=settings */
    .rv-upload-body{display:grid;grid-template-columns:1fr 1fr;gap:0 40px;padding:32px 40px!important;max-width:1000px;margin:0 auto;align-items:start;align-content:center;min-height:calc(100vh - 116px);}
    .rv-ul-right{padding-top:2px;}

    /* Quiz / Results / Loading / Exam: centered wider */
    .rv-center{max-width:800px;margin:0 auto;width:100%;padding:32px 40px!important;}
    .rv-center-narrow{max-width:680px;margin:0 auto;width:100%;padding:32px 40px!important;}
    .rv-exam-body{max-width:960px;margin:0 auto;width:100%;padding:28px 40px!important;}
    /* Mock two-panel (passage left, question right) reads wider, like the real test UI */
    .rv-mock-wide{max-width:1080px;margin:0 auto;width:100%;padding:24px 36px!important;}
  }
`;
