import { useState, useEffect } from "react";
import { useStudy } from "../context/StudyContext.jsx";

// Spaced-repetition (SM-2-flavoured) review deck. The state + scheduling now
// live in StudyContext (server-synced when signed in); this hook is a thin,
// backwards-compatible view over it, call sites are unchanged. Missed
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
    topic: String(q?.topic || "").trim(), // for weak-topic detection
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
    topicStats: study?.topicStats || {}, recordTopics: study?.recordTopics || (() => {}),
    perf: study?.perf || { recent: [] }, recordPerf: study?.recordPerf || (() => {}),
    bank: study?.bank || { items: [], rejects: [] },
    bankAdd: study?.bankAdd || (() => {}), bankReject: study?.bankReject || (() => {}), bankUsed: study?.bankUsed || (() => {}),
    library: study?.library || { docs: [] },
    addLibraryDoc: study?.addLibraryDoc || (() => {}), removeLibraryDoc: study?.removeLibraryDoc || (() => {}),
    mockScores: study?.mockScores || {}, recordMockScore: study?.recordMockScore || (() => {}),
    // Rewards economy: power-up wallet, streak savers, and the grant/spend API.
    wallet: study?.wallet || { hint: 0, freeze: 0, skip: 0 },
    streakSavers: study?.streakSavers || 0, savedProgress: study?.savedProgress || 0,
    completeActivity: study?.completeActivity || (() => null), usePowerup: study?.usePowerup || (() => {}), grantPowerups: study?.grantPowerups || (() => {}),
    // Head-to-head challenge record + recorder (feeds adaptive difficulty).
    stats: study?.stats || {},
    recordChallengeResult: study?.recordChallengeResult || (() => {}),
    // Badges / trophy case + public flair.
    badges: study?.badges || { earned: [], equipped: null, seen: [], public: true },
    syncBadges: study?.syncBadges || (() => {}),
    equipBadge: study?.equipBadge || (() => {}),
    setBadgesPublic: study?.setBadgesPublic || (() => {}),
    markBadgesSeen: study?.markBadgesSeen || (() => {}),
  };
}
