import { useState, useEffect, useRef, useCallback } from "react";
import { buildServe, questionPoints, serveDifficulty, comboMult, timerFor } from "../lib/arena.js";
import { SoundEngine, Haptics } from "../studyquiz/audio.js";
import Icon from "./Icon.jsx";

const PUP_ICON = { hint: "bulb", fifty: "fifty", freeze: "snowflake", skip: "skip_next" };

// The endless run itself: one life, a visible per-question timer that ramps down,
// and the three power-ups (freeze / hint / skip) the player already owns. A wrong
// answer or a timeout ends the run. Anti-cheat: if the player leaves the tab (to
// go search), the timer PAUSES while away and the question is SWAPPED for a fresh
// one on return, with a short note, so any lookup is void. Power-ups are NOT
// earned mid-run: you bring your wallet in (initialPowerups) and spend it, and a
// run earns at most one new power-up at the end (granted by the score, outside
// this component). Self-contained: give it a batch of pool questions and it calls
// onEnd(result) when the player misses. onUsePowerup(type) is called the moment a
// power-up is spent so the shared wallet is debited immediately.
export default function ArenaGame({ questions, t, onEnd, initialPowerups, onUsePowerup }) {
  const [qi, setQi] = useState(0);                    // depth shown (1-based label)
  const [serve, setServe] = useState(() => buildServe(questions[0]));
  const [score, setScore] = useState(0);
  const [streak, setStreak] = useState(0);
  const [timeLeft, setTimeLeft] = useState(() => timerFor(0));
  const [frozen, setFrozen] = useState(false);        // freeze power-up: pause the timer
  const [tabHidden, setTabHidden] = useState(false);  // tab is backgrounded: pause the timer
  const [picked, setPicked] = useState(null);         // index once answered (brief reveal)
  const [eliminated, setEliminated] = useState([]);   // option indices hidden by the 50/50 power-up
  const [hintText, setHintText] = useState(null);     // a text clue from the hint power-up
  const [swapNote, setSwapNote] = useState(false);    // "question changed, you left the tab" toast
  const [pups, setPups] = useState(() => ({          // available (from the player's wallet)
    hint: Math.max(0, Number(initialPowerups?.hint) || 0),
    fifty: Math.max(0, Number(initialPowerups?.fifty) || 0),
    freeze: Math.max(0, Number(initialPowerups?.freeze) || 0),
    skip: Math.max(0, Number(initialPowerups?.skip) || 0),
  }));
  const [used, setUsed] = useState({ hint: 0, fifty: 0, freeze: 0, skip: 0 }); // power-ups spent
  const answersRef = useRef([]);
  const overRef = useRef(false);
  const poolRef = useRef(0);            // index of the last question consumed from the batch
  const pickedRef = useRef(null);       // mirror of `picked` for the visibility handler
  const hiddenRef = useRef(false);      // did the tab go hidden since the last question?
  const swapTimerRef = useRef(null);
  useEffect(() => { pickedRef.current = picked; }, [picked]);

  const total = questions.length;
  const cur = serve;
  const diff = serveDifficulty(cur.baseDiff, cur.closeness);
  const pot = questionPoints(diff, streak);        // points this question is worth right now

  const finish = useCallback((lastAnsweredCount) => {
    if (overRef.current) return;
    overRef.current = true;
    onEnd({
      score, questions: lastAnsweredCount, answers: answersRef.current,
      freeze: used.freeze, hint: used.hint, skip: used.skip, fifty: used.fifty,
    });
  }, [onEnd, score, used]);

  // Draw the next question from the batch, wrapping so the run stays truly endless
  // (it ends only on a wrong answer or a timeout, never because the batch ran out).
  const nextServe = useCallback(() => {
    poolRef.current = total ? (poolRef.current + 1) % total : 0;
    return buildServe(questions[poolRef.current]);
  }, [questions, total]);

  // Move to the next question.
  const advance = useCallback((nextIndex) => {
    setServe(nextServe());
    setTimeLeft(timerFor(nextIndex));
    setPicked(null); setEliminated([]); setHintText(null); setFrozen(false);
    setQi(nextIndex);
  }, [nextServe]);

  // Swap the current (unanswered) question for a fresh one and restart its timer.
  // Used when the player leaves the tab and returns, so any lookup is void.
  const swapQuestion = useCallback(() => {
    if (overRef.current || pickedRef.current !== null) return;
    setServe(nextServe());
    setTimeLeft(timerFor(qi));
    setEliminated([]); setHintText(null); setFrozen(false);
    setSwapNote(true);
    if (swapTimerRef.current) clearTimeout(swapTimerRef.current);
    swapTimerRef.current = setTimeout(() => setSwapNote(false), 2600);
  }, [nextServe, qi]);

  // Anti-cheat: leaving the tab pauses the timer; returning swaps the question.
  useEffect(() => {
    const onVis = () => {
      if (document.hidden) { hiddenRef.current = true; setTabHidden(true); return; }
      if (!hiddenRef.current) return;
      hiddenRef.current = false; setTabHidden(false);
      swapQuestion();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => { document.removeEventListener("visibilitychange", onVis); if (swapTimerRef.current) clearTimeout(swapTimerRef.current); };
  }, [swapQuestion]);

  // Answer the current question.
  const pick = useCallback((i) => {
    if (picked !== null || overRef.current) return;
    setPicked(i);
    const ok = i === cur.correctIndex;
    const pts = ok ? pot : 0;
    answersRef.current.push({ id: cur.id, ok, pts });
    if (ok) { SoundEngine.correct(); Haptics.buzz(28); } else { SoundEngine.wrong(); Haptics.buzz(60); }
    if (ok) {
      setScore((s) => s + pts);
      setStreak(streak + 1);
      setTimeout(() => advance(qi + 1), 650);   // brief green flash, then next
    } else {
      setTimeout(() => finish(answersRef.current.length), 900);  // brief red flash, then game over
    }
  }, [picked, cur, pot, streak, qi, advance, finish]);

  // Countdown. Paused while frozen, answered, backgrounded, or over.
  useEffect(() => {
    if (frozen || tabHidden || picked !== null || overRef.current) return;
    if (timeLeft <= 0) { // ran out of time counts as a miss
      if (!overRef.current && picked === null) { SoundEngine.wrong(); Haptics.buzz(60); answersRef.current.push({ id: cur.id, ok: false, pts: 0 }); setPicked(-1); setTimeout(() => finish(answersRef.current.length), 700); }
      return;
    }
    const id = setInterval(() => setTimeLeft((tl) => Math.max(0, tl - 0.1)), 100);
    return () => clearInterval(id);
  }, [timeLeft, frozen, tabHidden, picked, cur, finish]);

  // ── Power-ups (event handlers, so ref/RNG access here is off the render path) ──
  const doFreeze = useCallback(() => { if (pups.freeze <= 0 || picked !== null || frozen) return; setPups((p) => ({ ...p, freeze: p.freeze - 1 })); setUsed((u) => ({ ...u, freeze: u.freeze + 1 })); onUsePowerup?.("freeze"); setFrozen(true); }, [pups.freeze, picked, frozen, onUsePowerup]);
  // 50/50: remove two of the wrong options.
  const doFifty = useCallback(() => {
    if (pups.fifty <= 0 || picked !== null || eliminated.length) return;
    const wrong = cur.options.map((_, i) => i).filter((i) => i !== cur.correctIndex);
    for (let x = wrong.length - 1; x > 0; x--) { const j = Math.floor(Math.random() * (x + 1)); [wrong[x], wrong[j]] = [wrong[j], wrong[x]]; }
    setPups((p) => ({ ...p, fifty: p.fifty - 1 })); setUsed((u) => ({ ...u, fifty: u.fifty + 1 })); onUsePowerup?.("fifty");
    setEliminated(wrong.slice(0, 2));   // hide two wrong options
  }, [pups.fifty, picked, eliminated, cur, onUsePowerup]);
  // Hint: an actual clue about the answer (first letter + its length), without
  // revealing it outright.
  const doHint = useCallback(() => {
    if (pups.hint <= 0 || picked !== null || hintText) return;
    const ans = String(cur.options[cur.correctIndex] || "").trim();
    const first = ans.charAt(0).toUpperCase();
    const letters = ans.replace(/[^\p{L}\p{N}]/gu, "").length;
    setPups((p) => ({ ...p, hint: p.hint - 1 })); setUsed((u) => ({ ...u, hint: u.hint + 1 })); onUsePowerup?.("hint");
    setHintText((t.arenaHintText || 'Starts with "{c}" · {n} letters').replace("{c}", first || "?").replace("{n}", letters));
  }, [pups.hint, picked, hintText, cur, onUsePowerup, t]);
  const doSkip = useCallback(() => { if (pups.skip <= 0 || picked !== null) return; setPups((p) => ({ ...p, skip: p.skip - 1 })); setUsed((u) => ({ ...u, skip: u.skip + 1 })); onUsePowerup?.("skip"); advance(qi + 1); }, [pups.skip, picked, advance, qi, onUsePowerup]);

  const timerPct = Math.max(0, Math.min(100, (timeLeft / timerFor(qi)) * 100));
  const low = timeLeft <= 4 && !frozen && !tabHidden;

  const box = { background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 14 };
  const pupLabel = { hint: t.arenaHint || "Hint", fifty: t.arenaFifty || "50/50", freeze: t.arenaFreeze || "Freeze", skip: t.arenaSkip || "Skip" };
  const pupFn = { hint: doHint, fifty: doFifty, freeze: doFreeze, skip: doSkip };

  return (
    <div style={{ maxWidth: 560, margin: "0 auto", padding: "16px 16px 28px", width: "100%", boxSizing: "border-box" }}>
      {/* header: score + streak */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, color: "var(--color-text-tertiary)", textTransform: "uppercase" }}>{t.arenaScoreLbl || "Score"}</div>
          <div style={{ fontSize: 30, fontWeight: 800, color: "var(--color-accent)", fontFamily: "'Fraunces',Georgia,serif", lineHeight: 1 }}>{score.toLocaleString()}</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 11, color: "var(--color-text-secondary)", fontFamily: "monospace" }}>{(t.arenaQNum || "Q{n}").replace("{n}", qi + 1)}</div>
          {streak >= 3 && <div style={{ fontSize: 13, fontWeight: 800, color: "#d97706", fontFamily: "monospace" }}>&times;{comboMult(streak)} {t.arenaCombo || "combo"}</div>}
        </div>
      </div>

      {/* timer */}
      <div style={{ height: 7, borderRadius: 4, background: "var(--color-background-secondary)", overflow: "hidden", marginBottom: 4 }}>
        <div style={{ height: "100%", width: `${timerPct}%`, background: (frozen || tabHidden) ? "#38bdf8" : low ? "#dc2626" : "var(--color-accent)", transition: "width .1s linear", borderRadius: 4 }} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--color-text-tertiary)", fontFamily: "monospace", marginBottom: 14 }}>
        <span>{(frozen || tabHidden) ? (t.arenaFrozen || "Frozen") : `${Math.ceil(timeLeft)}s`}</span>
        <span style={{ color: "#d97706" }}>+{pot}</span>
      </div>

      {/* question */}
      <div style={{ ...box, padding: "20px 18px", marginBottom: 12, minHeight: 92, display: "flex", flexDirection: "column", justifyContent: "center" }}>
        {cur.category && <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, color: "var(--color-accent)", textTransform: "uppercase", marginBottom: 7 }}>{cur.category}</div>}
        <div style={{ fontSize: 18, fontWeight: 600, color: "var(--color-text-primary)", lineHeight: 1.35 }}>{cur.question}</div>
      </div>

      {/* hint clue (from the hint power-up) */}
      {hintText && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, background: "var(--color-sel-tint)", border: "1px solid var(--color-accent)", borderRadius: 12, padding: "9px 13px", marginBottom: 12 }}>
          <Icon name="bulb" size={15} style={{ color: "var(--color-accent)", flexShrink: 0 }} />
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--color-text-primary)" }}>{hintText}</span>
        </div>
      )}

      {/* options */}
      <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
        {cur.options.map((opt, i) => {
          if (eliminated.includes(i)) return <div key={i} style={{ height: 50, borderRadius: 12, border: "1px dashed var(--color-border-tertiary)", opacity: 0.35 }} />;
          const isPicked = picked === i;
          const revealCorrect = picked !== null && i === cur.correctIndex;
          const revealWrong = isPicked && i !== cur.correctIndex;
          let bg = "var(--color-background-primary)", bd = "var(--color-border-tertiary)", col = "var(--color-text-primary)";
          if (revealCorrect) { bg = "#f0fdf4"; bd = "#16a34a"; col = "#15803d"; }
          else if (revealWrong) { bg = "#fef2f2"; bd = "#dc2626"; col = "#b91c1c"; }
          return (
            <button key={i} onClick={() => pick(i)} disabled={picked !== null} style={{
              display: "flex", alignItems: "center", gap: 12, padding: "14px 16px", minHeight: 50, textAlign: "left",
              background: bg, border: `1.5px solid ${bd}`, borderRadius: 12, cursor: picked !== null ? "default" : "pointer",
              fontFamily: "inherit", fontSize: 15.5, fontWeight: 600, color: col, transition: "background .1s, border-color .1s",
            }}>
              <span style={{ width: 22, height: 22, borderRadius: "50%", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, background: revealCorrect ? "#16a34a" : revealWrong ? "#dc2626" : "var(--color-background-secondary)", color: revealCorrect || revealWrong ? "#fff" : "var(--color-text-tertiary)" }}>{"ABCD"[i]}</span>
              <span style={{ flex: 1 }}>{opt}</span>
            </button>
          );
        })}
      </div>

      {/* power-ups */}
      <div style={{ display: "flex", gap: 7, marginTop: 16 }}>
        {["hint", "fifty", "freeze", "skip"].map((key) => {
          const n = pups[key];
          const disabled = n <= 0 || picked !== null || (key === "freeze" && frozen) || (key === "hint" && !!hintText) || (key === "fifty" && eliminated.length > 0);
          return (
            <button key={key} disabled={disabled}
              onClick={() => pupFn[key]()}
              style={{
                flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 3, padding: "9px 3px",
                background: n > 0 && !disabled ? "var(--color-sel-tint)" : "var(--color-background-secondary)",
                border: `1px solid ${n > 0 && !disabled ? "var(--color-accent)" : "var(--color-border-tertiary)"}`,
                borderRadius: 11, cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.45 : 1, fontFamily: "inherit",
              }}>
              <Icon name={PUP_ICON[key]} size={18} stroke={1.9} style={{ color: n > 0 && !disabled ? "var(--color-accent)" : "var(--color-text-tertiary)" }} />
              <span style={{ fontSize: 13, fontWeight: 700, color: "var(--color-text-primary)" }}>{pupLabel[key]}</span>
              <span style={{ fontSize: 10, fontWeight: 700, color: n > 0 ? "var(--color-accent)" : "var(--color-text-tertiary)", fontFamily: "monospace" }}>&times;{n}</span>
            </button>
          );
        })}
      </div>
      <p style={{ fontSize: 10.5, color: "var(--color-text-tertiary)", textAlign: "center", marginTop: 8 }}>{t.arenaWalletHint || "Power-ups come from your wallet. Score high to earn one, usable here or in any quiz."}</p>

      {swapNote && (
        <div style={{ position: "fixed", left: "50%", bottom: 30, transform: "translateX(-50%)", background: "var(--color-text-primary)", color: "var(--color-background-primary)", padding: "10px 18px", borderRadius: 999, fontSize: 12.5, fontWeight: 600, boxShadow: "0 8px 24px rgba(0,0,0,0.25)", zIndex: 50, maxWidth: "90%", textAlign: "center" }}>
          {t.arenaTabSwap || "New question: you left the tab, so this one was swapped."}
        </div>
      )}
    </div>
  );
}
