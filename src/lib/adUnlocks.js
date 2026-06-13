import { useState, useEffect, useCallback } from "react";
import { simulateAdWatch } from "./ads.jsx";

// Granular, per-feature ad-unlock system for FREE users. Each feature has its
// own localStorage timestamp (and, for once-daily features, an "ad used" date).
// Pro users always have everything unlocked and never see these prompts.
//
// Rules:
//   flashcard   — unlimited unlocks/day, 1h each
//   fillinblank — once/day, 1h
//   matchterms  — once/day, 1h
//   questions   — up to 50/quiz, once/day, 1h
//   filesize    — 10MB uploads, once/day, 1h
const HOUR = 3600 * 1000;

export const UNLOCK_FEATURES = {
  flashcard:   { until: "flashcard_unlocked_until",   daily: false },
  fillinblank: { until: "fillinblank_unlocked_until", dateKey: "fillinblank_ad_used_date", daily: true },
  matchterms:  { until: "matchterms_unlocked_until",  dateKey: "matchterms_ad_used_date",  daily: true },
  questions:   { until: "questions_unlocked_until",   dateKey: "questions_ad_used_date",   daily: true },
  filesize:    { until: "filesize_unlocked_until",    dateKey: "filesize_ad_used_date",    daily: true },
};

const today = () => new Date().toLocaleDateString("en-US");
const getNum = (k) => { try { return parseInt(localStorage.getItem(k), 10) || 0; } catch { return 0; } };
const getStr = (k) => { try { return localStorage.getItem(k) || ""; } catch { return ""; } };

// `now` ticks every second so countdowns update and expiries re-evaluate live.
export function useAdUnlocks(isPro) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Currently within an active 1-hour window (Pro = always unlocked).
  const isUnlocked = useCallback((f) => {
    if (isPro) return true;
    const cfg = UNLOCK_FEATURES[f];
    return !!cfg && now < getNum(cfg.until);
  }, [isPro, now]);

  // The once-daily ad has already been used today (and isn't active now).
  const usedToday = useCallback((f) => {
    const cfg = UNLOCK_FEATURES[f];
    if (!cfg || !cfg.daily) return false;
    return getStr(cfg.dateKey) === today();
  }, [now]); // eslint-disable-line react-hooks/exhaustive-deps

  // Whether the user may watch an ad to unlock right now.
  const canUnlock = useCallback((f) => {
    if (isPro) return false;
    const cfg = UNLOCK_FEATURES[f];
    if (!cfg) return false;
    if (now < getNum(cfg.until)) return false;      // already active
    if (!cfg.daily) return true;                    // flashcards: unlimited
    return getStr(cfg.dateKey) !== today();         // once-daily: not used yet
  }, [isPro, now]);

  const remainingMs = useCallback((f) => {
    const cfg = UNLOCK_FEATURES[f];
    return cfg ? Math.max(0, getNum(cfg.until) - now) : 0;
  }, [now]);

  // "M:SS" countdown for the active window.
  const remainingLabel = useCallback((f) => {
    const ms = remainingMs(f);
    if (ms <= 0) return "";
    const s = Math.ceil(ms / 1000);
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, "0")}`;
  }, [remainingMs]);

  // Watch the (placeholder) ad and start a 1-hour window. Returns false if the
  // daily allowance is already used.
  const unlock = useCallback(async (f) => {
    const cfg = UNLOCK_FEATURES[f];
    if (!cfg) return false;
    if (cfg.daily && now < getNum(cfg.until)) return true;      // already active
    if (cfg.daily && getStr(cfg.dateKey) === today()) return false; // used today
    await simulateAdWatch();
    try {
      localStorage.setItem(cfg.until, String(Date.now() + HOUR));
      if (cfg.daily) localStorage.setItem(cfg.dateKey, today());
    } catch { /* ignore */ }
    setNow(Date.now()); // force re-evaluation
    return true;
  }, [now]);

  return { isUnlocked, canUnlock, usedToday, remainingMs, remainingLabel, unlock };
}
