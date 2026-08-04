import { useState, useEffect } from "react";
import { useStudy } from "../context/StudyContext.jsx";

// Spaced-repetition (SM-2-flavoured) review deck. The state + scheduling now
// live in StudyContext (server-synced when signed in); this hook is a thin,
// backwards-compatible view over it — call sites are unchanged. Missed
// questions become review cards resurfaced on expanding intervals until they
// stick, turning Revyy from a one-off generator into a daily review habit.

const DAY = 86400000;

// Normalise any quiz/exam question (mcq, cards, fill, match, written) into a
// front/back review card. Correct answer = explicit `answer` or the right MCQ
// option.
export function toCard(q) {
  return {
    front: String(q?.question || "").trim(),
    back: String(q?.answer || (q?.options && q.options[q.correct]) || "").trim(),
    explanation: String(q?.explanation || "").trim(),
  };
}

export function useSRS() {
  const study = useStudy();
  const [now, setNow] = useState(() => Date.now());
  // Re-evaluate "due" counts periodically without a full reload.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(id);
  }, []);

  const cards = study?.cards || [];
  const examDate = study?.examDate || null;
  const dueCards = cards.filter((c) => c.due <= now).sort((a, b) => a.due - b.due);
  const daysToExam = examDate
    ? Math.max(0, Math.ceil((new Date(examDate).getTime() - now) / DAY))
    : null;

  return {
    cards, totalCount: cards.length,
    dueCards, dueCount: dueCards.length,
    learnedCount: cards.filter((c) => c.interval >= 7).length,
    addMissed: study?.addMissed || (() => 0),
    grade: study?.grade || (() => {}),
    removeCard: study?.removeCard || (() => {}),
    clearAll: study?.clearAll || (() => {}),
    examDate, setExamDate: study?.setExamDate || (() => {}), daysToExam,
  };
}
