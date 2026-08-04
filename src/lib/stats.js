import { useStudy } from "../context/StudyContext.jsx";

// Study-stats view: lifetime questions answered, accuracy, and a daily streak.
// State lives in StudyContext (server-synced when signed in); this hook is a
// thin, backwards-compatible view — call sites are unchanged. Feeds the account
// "Your progress" panel so the account is a study home, not just a billing row.

const dstr = (d = new Date()) => d.toLocaleDateString("en-CA"); // YYYY-MM-DD (local)
const yesterday = () => { const d = new Date(); d.setDate(d.getDate() - 1); return dstr(d); };

export function useStudyStats() {
  const study = useStudy();
  const s = study?.stats || {};
  const answered = s.answered || 0, correct = s.correct || 0;
  const best = s.best || 0, streak = s.streak || 0, lastActive = s.lastActive || null;

  const accuracy = answered ? Math.round((correct / answered) * 100) : null;
  // A streak only "counts" if the last activity was today or yesterday.
  const liveStreak = (lastActive === dstr() || lastActive === yesterday()) ? streak : 0;

  return {
    answered, correct, best, lastActive,
    streak: liveStreak, accuracy,
    recordSession: study?.recordSession || (() => {}),
  };
}
