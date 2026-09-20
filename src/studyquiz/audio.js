// Sound + haptics engine extracted from StudyQuiz.jsx. Self-contained (Web
// Audio API + navigator.vibrate); exported objects are shared live bindings,
// so settings toggles (Haptics.on, SoundEngine.setEnabled/setVolume) still
// reach every caller through the same instance.

// Haptic feedback. navigator.vibrate exists only where the Vibration API is
// implemented, Android phones/tablets. iOS Safari and virtually all desktop
// browsers don't implement it, so this is a silent no-op there (exactly the
// "mobile/tablets only" behaviour we want). `.on` mirrors the user setting.
export const Haptics = { on:false, buzz(ms=35){ try{ if(this.on && navigator.vibrate) navigator.vibrate(ms); }catch{ /* ignore */ } } };

export const SoundEngine = (() => {
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
    } catch { /* ignore */ }
  };
  return {
    click:     ()=>tone(780,'sine',0.05,0.12),
    // Ultra-subtle tap for the universal "clicked a button" feedback: soft and
    // short so it sits UNDER the richer event sounds (correct/wrong/etc.).
    tap:       ()=>tone(600,'sine',0.028,0.075),
    tick:      ()=>tone(520,'sine',0.03,0.10),
    // A gentle two-beep warning when a timer is running low (not alarming).
    timeLow:   ()=>{ tone(784,'sine',0.10,0.15); tone(784,'sine',0.10,0.15,0.15); },
    correct:   ()=>{ tone(523,'sine',0.12,0.18); tone(659,'sine',0.12,0.18,0.08); tone(784,'sine',0.15,0.18,0.16); },
    wrong:     ()=>{ tone(220,'sawtooth',0.12,0.14); tone(196,'sawtooth',0.10,0.10,0.07); },
    submit:    ()=>{ tone(440,'sine',0.15,0.15); tone(370,'sine',0.15,0.12,0.12); },
    pass:      ()=>{ tone(523,'sine',0.18,0.18); tone(659,'sine',0.20,0.18,0.14); },
    fail:      ()=>tone(280,'sine',0.25,0.15),
    celebrate: ()=>[[523,0],[659,.08],[784,.16],[1047,.26],[784,.42],[1047,.52],[1319,.62]].forEach(([f,d])=>tone(f,'sine',0.18,0.22,d)),
    // A bright sparkle when a badge unlocks.
    unlock:    ()=>[[659,0],[880,.08],[1175,.17],[1568,.28]].forEach(([f,d])=>tone(f,'triangle',0.17,0.20,d)),
    // A triumphant fanfare when the learner's rank tier goes up.
    rankUp:    ()=>[[523,0],[659,.1],[784,.2],[1047,.32],[1319,.46],[1568,.60]].forEach(([f,d])=>tone(f,'triangle',0.22,0.24,d)),
    // A rising "streak" flare that gets hotter (higher, brighter) with the count.
    streak:    (lvl=1)=>{ const n=Math.min(Math.max(lvl,1),30); const base=380+n*22; tone(base,'sine',0.09,0.16); tone(base*1.33,'sine',0.11,0.15,0.06); tone(base*1.66,'triangle',0.12,0.13,0.12); },
    // A clear chime for a new social notification (friend request / message / challenge).
    ping:      ()=>{ tone(784,'sine',0.11,0.28); tone(1047,'sine',0.13,0.26,0.09); tone(1319,'sine',0.15,0.22,0.18); },
    setVolume:(v)=>{ if(master) master.gain.value = Math.max(0,Math.min(1,v/100)); },
    setEnabled:(v)=>{ enabled = !!v; },
  };
})();
