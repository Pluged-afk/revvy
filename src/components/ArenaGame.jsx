import { useState, useEffect, useRef, useCallback } from "react";
import { buildServe, questionPoints, serveDifficulty, comboMult, timerFor, powerupAt, ARENA } from "../lib/arena.js";

// The endless run itself: one life, a per-question timer that ramps down, and
// three earn-as-you-go power-ups (freeze / hint / skip). Self-contained, it just
// needs a batch of pool questions and calls onEnd(result) when the player misses.
export default function ArenaGame({ questions, t, onEnd }) {
  const [qi, setQi] = useState(0);
  const [serve, setServe] = useState(() => buildServe(questions[0]));
  const [score, setScore] = useState(0);
  const [streak, setStreak] = useState(0);
  const [timeLeft, setTimeLeft] = useState(() => timerFor(0));
  const [frozen, setFrozen] = useState(false);
  const [picked, setPicked] = useState(null);        // index once answered (brief reveal)
  const [eliminated, setEliminated] = useState([]);   // option indices hidden by a hint
  const [pups, setPups] = useState({ freeze: 0, hint: 0, skip: 0 });   // available
  const [earned, setEarned] = useState(null);         // toast text for a just-earned power-up
  const [used, setUsed] = useState({ freeze: 0, hint: 0, skip: 0 }); // power-ups spent (submitted at the end)
  const answersRef = useRef([]);
  const overRef = useRef(false);

  const total = questions.length;
  const cur = serve;
  const diff = serveDifficulty(cur.baseDiff, cur.closeness);
  const pot = questionPoints(diff, streak);        // points this question is worth right now

  const finish = useCallback((lastAnsweredCount) => {
    if (overRef.current) return;
    overRef.current = true;
    onEnd({
      score, questions: lastAnsweredCount, answers: answersRef.current,
      freeze: used.freeze, hint: used.hint, skip: used.skip,
    });
  }, [onEnd, score, used]);

  // Move to the next question (or end if the batch is exhausted).
  const advance = useCallback((nextIndex) => {
    if (nextIndex >= total) { finish(nextIndex); return; }
    setServe(buildServe(questions[nextIndex]));
    setTimeLeft(timerFor(nextIndex));
    setPicked(null); setEliminated([]); setFrozen(false);
    // Earn a power-up for surviving to this depth (1-based count of questions cleared).
    const earn = powerupAt(nextIndex);
    if (earn) { setPups((p) => ({ ...p, [earn]: p[earn] + 1 })); setEarned(earn); setTimeout(() => setEarned(null), 1400); }
    setQi(nextIndex);
  }, [questions, total, finish]);

  // Answer the current question.
  const pick = useCallback((i) => {
    if (picked !== null || overRef.current) return;
    setPicked(i);
    const ok = i === cur.correctIndex;
    const pts = ok ? pot : 0;
    answersRef.current.push({ id: cur.id, ok, pts });
    if (ok) {
      setScore((s) => s + pts);
      const ns = streak + 1;
      setStreak(ns);
      setTimeout(() => advance(qi + 1), 650);   // brief green flash, then next
    } else {
      setTimeout(() => finish(answersRef.current.length), 900);  // brief red flash, then game over
    }
  }, [picked, cur, pot, streak, qi, advance, finish]);

  // Countdown. Frozen (via the freeze power-up) pauses it; answered pauses it.
  useEffect(() => {
    if (frozen || picked !== null || overRef.current) return;
    if (timeLeft <= 0) { // ran out of time counts as a miss
      if (!overRef.current && picked === null) { answersRef.current.push({ id: cur.id, ok: false, pts: 0 }); setPicked(-1); setTimeout(() => finish(answersRef.current.length), 700); }
      return;
    }
    const id = setInterval(() => setTimeLeft((tl) => Math.max(0, tl - 0.1)), 100);
    return () => clearInterval(id);
  }, [timeLeft, frozen, picked, cur, finish]);

  // ── Power-ups (event handlers, so ref/RNG access here is off the render path) ──
  const doFreeze = useCallback(() => { if (pups.freeze <= 0 || picked !== null || frozen) return; setPups((p) => ({ ...p, freeze: p.freeze - 1 })); setUsed((u) => ({ ...u, freeze: u.freeze + 1 })); setFrozen(true); }, [pups.freeze, picked, frozen]);
  const doHint = useCallback(() => {
    if (pups.hint <= 0 || picked !== null || eliminated.length) return;
    const wrong = cur.options.map((_, i) => i).filter((i) => i !== cur.correctIndex);
    for (let x = wrong.length - 1; x > 0; x--) { const j = Math.floor(Math.random() * (x + 1)); [wrong[x], wrong[j]] = [wrong[j], wrong[x]]; }
    setPups((p) => ({ ...p, hint: p.hint - 1 })); setUsed((u) => ({ ...u, hint: u.hint + 1 }));
    setEliminated(wrong.slice(0, 2));   // hide two wrong options
  }, [pups.hint, picked, eliminated, cur]);
  const doSkip = useCallback(() => { if (pups.skip <= 0 || picked !== null) return; setPups((p) => ({ ...p, skip: p.skip - 1 })); setUsed((u) => ({ ...u, skip: u.skip + 1 })); advance(qi + 1); }, [pups.skip, picked, advance, qi]);

  const timerPct = Math.max(0, Math.min(100, (timeLeft / timerFor(qi)) * 100));
  const low = timeLeft <= 4 && !frozen;

  const box = { background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 14 };
  const pupLabel = { freeze: t.arenaFreeze || "Freeze", hint: t.arenaHint || "Hint", skip: t.arenaSkip || "Skip" };

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
        <div style={{ height: "100%", width: `${timerPct}%`, background: frozen ? "#38bdf8" : low ? "#dc2626" : "var(--color-accent)", transition: "width .1s linear", borderRadius: 4 }} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--color-text-tertiary)", fontFamily: "monospace", marginBottom: 14 }}>
        <span>{frozen ? (t.arenaFrozen || "Frozen") : `${Math.ceil(timeLeft)}s`}</span>
        <span style={{ color: "#d97706" }}>+{pot}</span>
      </div>

      {/* question */}
      <div style={{ ...box, padding: "20px 18px", marginBottom: 12, minHeight: 92, display: "flex", flexDirection: "column", justifyContent: "center" }}>
        {cur.category && <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, color: "var(--color-accent)", textTransform: "uppercase", marginBottom: 7 }}>{cur.category}</div>}
        <div style={{ fontSize: 18, fontWeight: 600, color: "var(--color-text-primary)", lineHeight: 1.35 }}>{cur.question}</div>
      </div>

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
      <div style={{ display: "flex", gap: 9, marginTop: 16 }}>
        {["freeze", "hint", "skip"].map((key) => {
          const n = pups[key];
          const disabled = n <= 0 || picked !== null;
          return (
            <button key={key} disabled={disabled}
              onClick={() => { if (key === "freeze") doFreeze(); else if (key === "hint") doHint(); else doSkip(); }}
              style={{
                flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 3, padding: "9px 4px",
                background: n > 0 && picked === null ? "var(--color-sel-tint)" : "var(--color-background-secondary)",
                border: `1px solid ${n > 0 && picked === null ? "var(--color-accent)" : "var(--color-border-tertiary)"}`,
                borderRadius: 11, cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.45 : 1, fontFamily: "inherit",
              }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: "var(--color-text-primary)" }}>{pupLabel[key]}</span>
              <span style={{ fontSize: 10, fontWeight: 700, color: n > 0 ? "var(--color-accent)" : "var(--color-text-tertiary)", fontFamily: "monospace" }}>&times;{n}</span>
            </button>
          );
        })}
      </div>
      <p style={{ fontSize: 10.5, color: "var(--color-text-tertiary)", textAlign: "center", marginTop: 8 }}>{(t.arenaEarnHint || "Earn a power-up every {n} questions").replace("{n}", ARENA.POWERUP_EVERY)}</p>

      {earned && (
        <div style={{ position: "fixed", left: "50%", bottom: 30, transform: "translateX(-50%)", background: "var(--color-accent)", color: "#fff", padding: "10px 18px", borderRadius: 999, fontSize: 13, fontWeight: 700, boxShadow: "0 8px 24px rgba(0,0,0,0.25)", zIndex: 50 }}>
          {(t.arenaEarned || "Earned a {p}!").replace("{p}", earned === "freeze" ? (t.arenaFreeze || "Freeze") : earned === "hint" ? (t.arenaHint || "Hint") : (t.arenaSkip || "Skip"))}
        </div>
      )}
    </div>
  );
}
