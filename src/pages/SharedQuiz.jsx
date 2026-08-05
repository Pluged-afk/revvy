import { useState, useEffect, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";

// Public "share-a-quiz" taker. Anyone with the link can take a quiz a Revyy
// user shared — no account needed — then see their score against a friend
// leaderboard and a nudge to make their own. Self-contained (its own light
// styling, no app shell) so it loads fast for first-time visitors. This is the
// viral loop: every shared quiz is a marketing touch.

const C = {
  indigo: "#4f46e5", indigoDark: "#312e81", ink: "#1e293b", sub: "#64748b", faint: "#94a3b8",
  border: "#e2e8f0", card: "#ffffff", bg: "#f8fafc", green: "#16a34a", red: "#dc2626",
};
const btn = { border: "none", borderRadius: 12, padding: "13px 22px", fontSize: 15, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" };
const primary = { ...btn, background: C.indigo, color: "#fff", width: "100%" };
const LETTERS = ["A", "B", "C", "D", "E", "F"];

function Logo({ size = 30 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ flexShrink: 0 }}>
      <rect width="28" height="28" rx="8" fill="#fff" />
      <path d="M9.7 7.4 V20.6 M9.7 7.4 H14.6 A3.95 3.95 0 0 1 14.6 15.3 H9.7" stroke="#4f46e5" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M11 15.3 L14.9 20.6 L20.7 11" stroke="#4f46e5" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function normFill(v) { return String(v || "").toLowerCase().trim(); }

export default function SharedQuiz() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [state, setState] = useState("loading"); // loading | error | intro | quiz | done
  const [quiz, setQuiz] = useState(null);
  const [owner, setOwner] = useState("");
  const [results, setResults] = useState([]);
  const [name, setName] = useState("");
  const [idx, setIdx] = useState(0);
  const [answers, setAnswers] = useState([]); // {correct, picked}
  const [sel, setSel] = useState(null);       // mcq selection
  const [fillVal, setFillVal] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [flipped, setFlipped] = useState(false);
  const [posted, setPosted] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/study?shared=${encodeURIComponent(id)}`);
        if (!res.ok) throw new Error();
        const d = await res.json();
        if (cancelled) return;
        setQuiz(d.quiz); setOwner(d.owner || ""); setResults(d.results || []);
        document.title = `${d.quiz?.title || "Quiz"} · Revyy`;
        setState("intro");
      } catch { if (!cancelled) setState("error"); }
    })();
    return () => { cancelled = true; };
  }, [id]);

  const questions = quiz?.questions || [];
  const q = questions[idx];
  const isLast = idx + 1 >= questions.length;
  const score = answers.filter((a) => a.correct).length;
  // Cards / match are taken as self-graded flashcards.
  const selfGraded = quiz && (quiz.type === "cards" || quiz.type === "match");

  const advance = useCallback((correct, picked) => {
    const next = [...answers, { correct, picked }];
    setAnswers(next);
    setSel(null); setFillVal(""); setRevealed(false); setFlipped(false);
    if (idx + 1 >= questions.length) setState("done");
    else setIdx((i) => i + 1);
  }, [answers, idx, questions.length]);

  // Post the score to the leaderboard once, when the results screen opens.
  useEffect(() => {
    if (state !== "done" || posted) return;
    setPosted(true);
    (async () => {
      try {
        const res = await fetch("/api/study", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "shareScore", id, name: name.trim() || "Anonymous", score, total: questions.length }),
        });
        const d = await res.json().catch(() => ({}));
        if (Array.isArray(d.results)) setResults(d.results);
      } catch { /* leaderboard is best-effort */ }
    })();
  }, [state, posted, id, name, score, questions.length]);

  const page = (children) => (
    <div style={{ minHeight: "100vh", background: C.bg, fontFamily: "'DM Sans','Helvetica Neue',sans-serif", color: C.ink }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700&family=DM+Sans:wght@400;500;600;700&display=swap');*{box-sizing:border-box}body{margin:0}`}</style>
      <div style={{ background: `linear-gradient(145deg,${C.indigoDark},${C.indigo})`, padding: "16px 20px", display: "flex", alignItems: "center", gap: 10 }}>
        <Logo /><span style={{ color: "#fff", fontFamily: "'Playfair Display',Georgia,serif", fontWeight: 700, fontSize: 18 }}>Revyy</span>
      </div>
      <div style={{ maxWidth: 560, margin: "0 auto", padding: "22px 16px 48px" }}>{children}</div>
    </div>
  );

  if (state === "loading") return page(<div style={{ textAlign: "center", color: C.sub, marginTop: 40 }}>Loading quiz…</div>);
  if (state === "error") return page(
    <div style={{ textAlign: "center", marginTop: 30 }}>
      <div style={{ fontSize: 40, marginBottom: 10 }}>🔍</div>
      <h2 style={{ fontFamily: "'Playfair Display',Georgia,serif", margin: "0 0 8px" }}>Quiz not found</h2>
      <p style={{ color: C.sub, marginBottom: 20 }}>This shared quiz may have expired or the link is wrong.</p>
      <button style={primary} onClick={() => navigate("/app")}>Make your own quiz free →</button>
    </div>
  );

  // ── INTRO ──
  if (state === "intro") return page(
    <div>
      <div style={{ background: C.card, border: `0.5px solid ${C.border}`, borderRadius: 16, padding: "24px 20px", textAlign: "center", boxShadow: "0 4px 20px rgba(0,0,0,0.05)" }}>
        <div style={{ fontSize: 34, marginBottom: 8 }}>🧠</div>
        <div style={{ fontSize: 12, fontWeight: 700, color: C.indigo, letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 6 }}>
          {owner ? `${owner} shared a quiz` : "Someone shared a quiz"}
        </div>
        <h1 style={{ fontFamily: "'Playfair Display',Georgia,serif", fontSize: 24, margin: "0 0 6px", lineHeight: 1.25 }}>{quiz.title}</h1>
        <p style={{ color: C.sub, fontSize: 13.5, margin: "0 0 20px" }}>
          {questions.length} question{questions.length > 1 ? "s" : ""}{quiz.subject ? ` · ${quiz.subject}` : ""}{selfGraded ? " · flashcards" : ""}
        </p>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name (for the leaderboard)" maxLength={24}
          style={{ width: "100%", borderRadius: 10, border: `1.5px solid ${C.border}`, background: "#fff", color: C.ink, fontSize: 14, padding: "11px 13px", fontFamily: "inherit", outline: "none", boxSizing: "border-box", marginBottom: 12, textAlign: "center" }} />
        <button style={primary} onClick={() => setState("quiz")}>Start quiz →</button>
      </div>
      {results.length > 0 && <Leaderboard results={results} />}
      <CTA navigate={navigate} />
    </div>
  );

  // ── QUIZ ──
  if (state === "quiz" && q) {
    const correctText = quiz.type === "mcq" ? (q.options?.[q.correct] ?? "") : (q.answer || "");
    return page(
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: C.sub, fontWeight: 600, marginBottom: 10 }}>
          <span>{quiz.title}</span><span>{idx + 1} / {questions.length}</span>
        </div>
        <div style={{ height: 4, background: C.border, borderRadius: 2, marginBottom: 18 }}>
          <div style={{ height: "100%", width: `${(idx / questions.length) * 100}%`, background: C.indigo, borderRadius: 2, transition: "width .3s" }} />
        </div>

        {selfGraded ? (
          <div>
            <div onClick={() => setFlipped((f) => !f)} style={{ cursor: "pointer", background: C.card, border: `1.5px solid ${flipped ? C.indigo : C.border}`, borderRadius: 16, padding: "40px 22px", textAlign: "center", minHeight: 190, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: C.faint, letterSpacing: 1.5, marginBottom: 14 }}>{flipped ? "ANSWER" : "TERM"}</div>
              <div style={{ fontFamily: "'Playfair Display',Georgia,serif", fontSize: 19, fontWeight: 700, lineHeight: 1.5 }}>{flipped ? correctText : q.question}</div>
              <div style={{ marginTop: 18, fontSize: 12, color: C.faint }}>{flipped ? "Tap to flip back" : "Tap to reveal"}</div>
            </div>
            {flipped && (
              <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
                <button style={{ ...btn, flex: 1, background: "#fef2f2", border: "1px solid #fca5a5", color: C.red }} onClick={() => advance(false, "Didn't know")}>✗ Didn't know</button>
                <button style={{ ...btn, flex: 1, background: "#f0fdf4", border: "1px solid #86efac", color: C.green }} onClick={() => advance(true, "Knew it")}>✓ Got it</button>
              </div>
            )}
          </div>
        ) : quiz.type === "fill" ? (
          <div>
            <h3 style={{ fontFamily: "'Playfair Display',Georgia,serif", fontSize: 19, lineHeight: 1.5, margin: "0 0 18px" }}>{q.question}</h3>
            {!revealed ? (
              <>
                <input value={fillVal} onChange={(e) => setFillVal(e.target.value)} onKeyDown={(e) => e.key === "Enter" && fillVal.trim() && setRevealed(true)} placeholder="Type your answer…"
                  style={{ width: "100%", borderRadius: 10, border: `1.5px solid ${C.border}`, fontSize: 15, padding: "12px 14px", fontFamily: "inherit", outline: "none", boxSizing: "border-box", marginBottom: 12 }} />
                <button style={{ ...primary, opacity: fillVal.trim() ? 1 : 0.4 }} disabled={!fillVal.trim()} onClick={() => setRevealed(true)}>Check</button>
              </>
            ) : (() => {
              const ok = normFill(fillVal) === normFill(q.answer) || (normFill(q.answer) && normFill(q.answer).includes(normFill(fillVal)) && normFill(fillVal).length >= 3);
              return (
                <>
                  <div style={{ borderRadius: 10, padding: "12px 14px", marginBottom: 14, background: ok ? "#f0fdf4" : "#fef2f2", border: `1px solid ${ok ? "#86efac" : "#fca5a5"}`, color: ok ? C.green : C.red }}>
                    <strong>{ok ? "Correct!" : "Not quite"}</strong>
                    <div style={{ fontSize: 13, marginTop: 4, color: C.ink }}>Answer: <strong>{q.answer}</strong></div>
                    {q.explanation && <div style={{ fontSize: 13, marginTop: 4, color: C.sub }}>{q.explanation}</div>}
                  </div>
                  <button style={primary} onClick={() => advance(ok, fillVal.trim())}>{isLast ? "See results →" : "Next →"}</button>
                </>
              );
            })()}
          </div>
        ) : (
          <div>
            <h3 style={{ fontFamily: "'Playfair Display',Georgia,serif", fontSize: 19, lineHeight: 1.4, margin: 0 }}>{q.question}</h3>
            <div style={{ display: "flex", flexDirection: "column", gap: 9, marginTop: 18 }}>
              {(q.options || []).map((opt, i) => {
                const chosen = sel === i, isCorrect = q.correct === i;
                let extra = {};
                if (sel !== null) {
                  if (isCorrect) extra = { border: "1.5px solid #22c55e", background: "#f0fdf4", color: C.green };
                  else if (chosen) extra = { border: "1.5px solid #ef4444", background: "#fef2f2", color: C.red };
                  else extra = { opacity: 0.5 };
                }
                return (
                  <button key={i} disabled={sel !== null} onClick={() => setSel(i)} style={{ display: "flex", alignItems: "center", gap: 12, background: C.card, border: `1.5px solid ${C.border}`, borderRadius: 12, padding: "13px 14px", cursor: sel !== null ? "default" : "pointer", fontSize: 14, color: C.ink, fontFamily: "inherit", textAlign: "left", ...extra }}>
                    <span style={{ width: 26, height: 26, borderRadius: "50%", background: C.bg, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700, flexShrink: 0 }}>{LETTERS[i]}</span>
                    <span style={{ flex: 1 }}>{opt}</span>
                  </button>
                );
              })}
            </div>
            {sel !== null && (
              <>
                {q.explanation && <div style={{ borderRadius: 10, padding: "11px 14px", marginTop: 14, background: C.bg, border: `0.5px solid ${C.border}`, fontSize: 13, color: C.sub, lineHeight: 1.5 }}>{q.explanation}</div>}
                <button style={{ ...primary, marginTop: 14 }} onClick={() => advance(sel === q.correct, q.options?.[sel] ?? "")}>{isLast ? "See results →" : "Next →"}</button>
              </>
            )}
          </div>
        )}
      </div>
    );
  }

  // ── DONE ──
  const pct = questions.length ? Math.round((score / questions.length) * 100) : 0;
  return page(
    <div>
      <div style={{ background: `linear-gradient(145deg,${C.indigoDark},${C.indigo})`, borderRadius: 16, padding: "28px 20px", textAlign: "center", color: "#fff", marginBottom: 18 }}>
        <div style={{ fontSize: 44, marginBottom: 6 }}>{pct >= 80 ? "🏆" : pct >= 50 ? "🎯" : "📚"}</div>
        <div style={{ fontSize: 46, fontWeight: 800, fontFamily: "'Playfair Display',Georgia,serif" }}>{pct}%</div>
        <div style={{ opacity: 0.85, fontSize: 14, marginTop: 2 }}>{score} / {questions.length} correct{selfGraded ? " (self-graded)" : ""}</div>
      </div>

      {!selfGraded && (
        <div style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.faint, letterSpacing: 1.2, textTransform: "uppercase", marginBottom: 10 }}>Review</div>
          {questions.map((qq, i) => {
            const a = answers[i];
            const correctText = quiz.type === "mcq" ? (qq.options?.[qq.correct] ?? "") : (qq.answer || "");
            return (
              <div key={i} style={{ background: C.card, borderRadius: 10, padding: "12px 13px 12px 11px", marginBottom: 9, border: `0.5px solid ${C.border}`, borderLeft: `3px solid ${a?.correct ? C.green : C.red}` }}>
                <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                  <span style={{ fontSize: 14, flexShrink: 0 }}>{a?.correct ? "✅" : "❌"}</span>
                  <span style={{ fontSize: 13.5, fontWeight: 600, lineHeight: 1.4 }}>{qq.question}</span>
                </div>
                {!a?.correct && <div style={{ fontSize: 12, color: C.red, marginTop: 5, paddingLeft: 22 }}>Your answer: {a?.picked || "—"}</div>}
                <div style={{ fontSize: 12, color: C.green, marginTop: 3, paddingLeft: 22, fontWeight: 500 }}>✓ Correct: {correctText}</div>
              </div>
            );
          })}
        </div>
      )}

      <Leaderboard results={results} highlight={name.trim() || "Anonymous"} />
      <CTA navigate={navigate} big />
    </div>
  );
}

function Leaderboard({ results, highlight }) {
  if (!results || !results.length) return null;
  return (
    <div style={{ background: C.card, border: `0.5px solid ${C.border}`, borderRadius: 14, padding: "14px 16px", marginTop: 16 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: C.faint, letterSpacing: 1, textTransform: "uppercase", marginBottom: 10 }}>🏅 Leaderboard</div>
      {results.slice(0, 8).map((r, i) => {
        const p = Math.round((r.score / Math.max(1, r.total)) * 100);
        const me = highlight && r.name === highlight;
        return (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 0", borderTop: i ? `0.5px solid ${C.border}` : "none" }}>
            <span style={{ width: 20, fontSize: 12, fontWeight: 700, color: i === 0 ? "#d97706" : C.faint }}>{i + 1}</span>
            <span style={{ flex: 1, fontSize: 13, fontWeight: me ? 700 : 500, color: me ? C.indigo : C.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}{me ? " (you)" : ""}</span>
            <span style={{ fontSize: 13, fontWeight: 700, color: C.ink }}>{p}%</span>
          </div>
        );
      })}
    </div>
  );
}

function CTA({ navigate, big }) {
  return (
    <div style={{ marginTop: 18, textAlign: "center", ...(big ? { background: "#ede9fe", border: "1px solid #c7d2fe", borderRadius: 14, padding: "18px 16px" } : {}) }}>
      {big && <div style={{ fontSize: 14, fontWeight: 700, color: C.indigoDark, marginBottom: 4 }}>Turn your own notes into a quiz</div>}
      {big && <div style={{ fontSize: 12.5, color: C.sub, marginBottom: 12, lineHeight: 1.5 }}>Upload a PDF, paste notes, or snap a photo — free.</div>}
      <button style={primary} onClick={() => navigate("/app")}>Make your own quiz free →</button>
    </div>
  );
}
