import { useState, useEffect, useRef, useCallback } from "react";

// Lightweight spaced-repetition engine (SM-2-flavoured) backed by localStorage.
// When a learner misses a question in a quiz or exam, it's saved here as a
// review card and resurfaced on expanding intervals until it sticks — turning
// Revyy from a one-off generator into a daily review habit. v1 is per-device
// (localStorage); cross-device sync would move this to the server later.

const CARDS_KEY = "revyy_srs_cards_v1";
const EXAM_KEY = "revyy_srs_exam_date";
const DAY = 86400000;
const uid = () =>
  (globalThis.crypto?.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2));

function load(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
  catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
}

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
  const [cards, setCards] = useState(() => load(CARDS_KEY, []));
  const [examDate, setExamDateState] = useState(() => load(EXAM_KEY, null));
  const [now, setNow] = useState(() => Date.now());

  const cardsRef = useRef(cards);
  const examRef = useRef(examDate);
  useEffect(() => { cardsRef.current = cards; save(CARDS_KEY, cards); }, [cards]);
  useEffect(() => { examRef.current = examDate; save(EXAM_KEY, examDate); }, [examDate]);

  // Re-evaluate "due" counts periodically without a full reload.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(id);
  }, []);

  // Add missed questions (deduped by front text). Returns how many were new.
  const addMissed = useCallback((items) => {
    const prev = cardsRef.current;
    const seen = new Set(prev.map((c) => c.front.toLowerCase()));
    const toAdd = [];
    for (const it of items || []) {
      const card = toCard(it.front !== undefined ? it : it); // accept card or question
      const front = (it.front ?? card.front ?? "").trim();
      const key = front.toLowerCase();
      if (!front || seen.has(key)) continue;
      seen.add(key);
      toAdd.push({
        id: uid(), front,
        back: it.back ?? card.back ?? "",
        explanation: it.explanation ?? card.explanation ?? "",
        ease: 2.3, interval: 0, due: Date.now(), reps: 0, lapses: 0, createdAt: Date.now(),
      });
    }
    if (toAdd.length) {
      const next = [...prev, ...toAdd];
      cardsRef.current = next;
      setCards(next);
    }
    return toAdd.length;
  }, []);

  // Grade a review: `ok` pushes the card further out; a miss brings it back soon.
  const grade = useCallback((id, ok) => {
    const next = cardsRef.current.map((c) => {
      if (c.id !== id) return c;
      if (ok) {
        const reps = c.reps + 1;
        const interval = reps === 1 ? 1 : reps === 2 ? 3 : Math.max(1, Math.round(c.interval * c.ease));
        const ease = Math.min(2.7, c.ease + 0.05);
        let due = Date.now() + interval * DAY;
        // Never schedule past the exam — make sure everything is seen before it.
        const ex = examRef.current ? new Date(examRef.current).getTime() : 0;
        if (ex && ex > Date.now() && due > ex) due = ex;
        return { ...c, reps, interval, ease, due };
      }
      return { ...c, reps: 0, interval: 0, lapses: c.lapses + 1, ease: Math.max(1.3, c.ease - 0.2), due: Date.now() + 10 * 60000 };
    });
    cardsRef.current = next;
    setCards(next);
  }, []);

  const removeCard = useCallback((id) => {
    const next = cardsRef.current.filter((c) => c.id !== id);
    cardsRef.current = next;
    setCards(next);
  }, []);

  const clearAll = useCallback(() => { cardsRef.current = []; setCards([]); }, []);

  const setExamDate = useCallback((d) => setExamDateState(d || null), []);

  const dueCards = cards.filter((c) => c.due <= now).sort((a, b) => a.due - b.due);
  const daysToExam = examDate
    ? Math.max(0, Math.ceil((new Date(examDate).getTime() - now) / DAY))
    : null;

  return {
    cards, totalCount: cards.length,
    dueCards, dueCount: dueCards.length,
    learnedCount: cards.filter((c) => c.interval >= 7).length,
    addMissed, grade, removeCard, clearAll,
    examDate, setExamDate, daysToExam,
  };
}
