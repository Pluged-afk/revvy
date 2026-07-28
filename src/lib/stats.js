import { useState, useCallback } from "react";

// Lightweight study-stats tracker (localStorage): lifetime questions answered,
// accuracy, and a daily streak. Feeds the account "Your progress" panel so the
// account is a study home, not just a billing record. Per-device for now; would
// move to the account server-side alongside the review deck later.

const KEY = "revyy_stats_v1";
const dstr = (d = new Date()) => d.toLocaleDateString("en-CA"); // YYYY-MM-DD (local)
const yesterday = () => { const d = new Date(); d.setDate(d.getDate() - 1); return dstr(d); };

function load() {
  try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; }
}
function save(v) {
  try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* ignore */ }
}

export function useStudyStats() {
  const [stats, setStats] = useState(() => {
    const s = load();
    return {
      answered: s.answered || 0, correct: s.correct || 0,
      streak: s.streak || 0, best: s.best || 0, lastActive: s.lastActive || null,
    };
  });

  // Call when a study activity completes (quiz, exam, or review session).
  const recordSession = useCallback((answered = 0, correct = 0) => {
    setStats((prev) => {
      const today = dstr();
      let streak = prev.streak;
      if (prev.lastActive === today) { /* already counted today */ }
      else if (prev.lastActive === yesterday()) streak = prev.streak + 1;
      else streak = 1;
      const next = {
        answered: prev.answered + answered,
        correct: prev.correct + correct,
        streak,
        best: Math.max(prev.best || 0, streak),
        lastActive: today,
      };
      save(next);
      return next;
    });
  }, []);

  const accuracy = stats.answered ? Math.round((stats.correct / stats.answered) * 100) : null;
  // A streak only "counts" if the last activity was today or yesterday.
  const liveStreak = (stats.lastActive === dstr() || stats.lastActive === yesterday()) ? stats.streak : 0;

  return { ...stats, streak: liveStreak, accuracy, recordSession };
}
