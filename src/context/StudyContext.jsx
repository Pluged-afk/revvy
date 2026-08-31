import { createContext, useContext, useState, useRef, useEffect, useCallback } from "react";
import { useAuth } from "./AuthContext.jsx";
import { makePerfEntry } from "../lib/studentModel.js";
import { normBank, bankAddItems, bankRejectQ, bankMarkUsed, bankMerge } from "../lib/questionBank.js";
import { normLibrary, libraryAddDoc, libraryRemove, libraryMerge } from "../lib/studyLibrary.js";
import { normWallet, walletAdd, addSaverProgress, tickStreak, arenaEarn, passEarn, POWERUP_CAP, SAVER_CAP } from "../lib/rewards.js";

// ── Server-synced study data ──────────────────────────────────────────
// Single source of truth for the spaced-repetition deck, lifetime stats +
// streak, exam date, and AI study plans. Held in one blob, cached in
// localStorage (instant + offline), and synced to Neon per-user when signed
// in (debounced write-through; one read on sign-in with a merge so progress
// made while logged out is never lost). Replaces the old per-hook localStorage
// state in srs.js / stats.js, those now read from here.

const LS_KEY = "revyy_study_v1";
const DAY = 86400000;

const uid = () =>
  globalThis.crypto?.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2);
const dstr = (d = new Date()) => d.toLocaleDateString("en-CA"); // YYYY-MM-DD (local)
const yesterdayStr = () => { const d = new Date(); d.setDate(d.getDate() - 1); return dstr(d); };

function safeParse(raw, fallback) {
  try { return raw ? JSON.parse(raw) : fallback; } catch { return fallback; }
}
function normStats(s) {
  s = s || {};
  return {
    answered: s.answered || 0, correct: s.correct || 0,
    streak: s.streak || 0, best: s.best || 0, lastActive: s.lastActive || null,
  };
}
function emptyData() {
  return { cards: [], examDate: null, stats: normStats({}), plans: [], topicStats: {}, perf: normPerf({}), bank: normBank({}), library: normLibrary({}), mockScores: {}, wallet: normWallet({}), streakSavers: 0, savedProgress: 0, updatedAt: 0 };
}
const asTopicStats = (t) => (t && typeof t === "object" && !Array.isArray(t)) ? t : {};

// Rolling performance log that powers the student model + adaptive difficulty
// (see lib/studentModel.js). Deliberately tiny: the last PERF_MAX graded quiz
// rounds, each { at, type, diff, total, correct }. Capped so the synced blob
// never grows unbounded.
const PERF_MAX = 40;
function normPerf(p) {
  const recent = Array.isArray(p?.recent) ? p.recent : [];
  return {
    recent: recent
      .filter((s) => s && typeof s === "object" && (s.total || 0) > 0)
      .slice(-PERF_MAX)
      .map((s) => ({
        at: s.at || 0,
        type: String(s.type || "mcq"),
        diff: Math.max(0, Math.min(2, Math.round(Number(s.diff) || 0))),
        total: Math.max(0, Math.round(s.total) || 0),
        correct: Math.max(0, Math.min(Math.round(s.correct) || 0, Math.round(s.total) || 0)),
      })),
  };
}

// Load from the new blob, falling back to (and migrating) the pre-sync keys so
// existing users keep their deck, streak and exam date.
function loadLocal() {
  const blob = safeParse(typeof localStorage !== "undefined" && localStorage.getItem(LS_KEY), null);
  if (blob && typeof blob === "object") {
    return {
      cards: Array.isArray(blob.cards) ? blob.cards : [],
      examDate: blob.examDate || null,
      stats: normStats(blob.stats),
      plans: Array.isArray(blob.plans) ? blob.plans : [],
      topicStats: asTopicStats(blob.topicStats),
      perf: normPerf(blob.perf),
      bank: normBank(blob.bank),
      library: normLibrary(blob.library),
      mockScores: (blob.mockScores && typeof blob.mockScores === "object" && !Array.isArray(blob.mockScores)) ? blob.mockScores : {},
      wallet: normWallet(blob.wallet),
      streakSavers: Math.max(0, Math.min(SAVER_CAP, Number(blob.streakSavers) || 0)),
      savedProgress: Math.max(0, Number(blob.savedProgress) || 0),
      updatedAt: blob.updatedAt || 0,
    };
  }
  if (typeof localStorage === "undefined") return emptyData();
  return {
    cards: safeParse(localStorage.getItem("revyy_srs_cards_v1"), []),
    examDate: safeParse(localStorage.getItem("revyy_srs_exam_date"), null),
    stats: normStats(safeParse(localStorage.getItem("revyy_stats_v1"), {})),
    plans: [],
    topicStats: {},
    perf: normPerf({}),
    bank: normBank({}),
    library: normLibrary({}),
    mockScores: {},
    wallet: normWallet({}),
    streakSavers: 0,
    savedProgress: 0,
    updatedAt: 0,
  };
}

// Merge server blob with whatever is in memory locally. Used once on sign-in so
// that a deck/streak/plan built while logged out (or on another device) is
// preserved rather than clobbered. Union cards & plans by identity; take the
// larger lifetime stats.
function mergeStudy(server, local) {
  server = server || {};
  const hasServer =
    (server.cards && server.cards.length) ||
    (server.plans && server.plans.length) ||
    (server.stats && (server.stats.answered || server.stats.best)) ||
    server.examDate;
  if (!hasServer) return local; // fresh account → push local up

  // Cards: union by front text; keep the more-progressed copy for duplicates.
  const byFront = new Map();
  for (const c of server.cards || []) byFront.set((c.front || "").toLowerCase(), c);
  for (const c of local.cards || []) {
    const k = (c.front || "").toLowerCase();
    const ex = byFront.get(k);
    if (!ex || (c.reps || 0) > (ex.reps || 0)) byFront.set(k, c);
  }
  // Plans: union by id; server wins on conflict.
  const byId = new Map();
  for (const p of local.plans || []) byId.set(p.id, p);
  for (const p of server.plans || []) byId.set(p.id, p);

  const ss = normStats(server.stats), ls = normStats(local.stats);
  const laterActive = (ss.lastActive || "") >= (ls.lastActive || "") ? ss : ls;
  // Topic stats: per topic keep the side with more attempts (avoids double-count).
  const ts = { ...asTopicStats(server.topicStats) };
  for (const [k, v] of Object.entries(asTopicStats(local.topicStats))) {
    if (!ts[k] || (v.seen || 0) > (ts[k].seen || 0)) ts[k] = v;
  }
  // Perf log: union both devices' sessions, dedupe by timestamp, keep newest.
  const byAt = new Map();
  for (const s of [...normPerf(server.perf).recent, ...normPerf(local.perf).recent]) byAt.set(s.at, s);
  const mergedPerf = [...byAt.values()].sort((a, b) => a.at - b.at).slice(-PERF_MAX);
  return {
    cards: [...byFront.values()],
    examDate: server.examDate || local.examDate || null,
    stats: {
      answered: Math.max(ss.answered, ls.answered),
      correct: Math.max(ss.correct, ls.correct),
      best: Math.max(ss.best, ls.best),
      streak: laterActive.streak,
      lastActive: laterActive.lastActive,
    },
    plans: [...byId.values()],
    topicStats: ts,
    perf: { recent: mergedPerf },
    bank: bankMerge(server.bank, local.bank),
    library: libraryMerge(server.library, local.library),
    mockScores: mergeMockScores(server.mockScores, local.mockScores),
    // Rewards: never lose an earned power-up or saver across devices, so keep the
    // higher of each (they are capped, so this cannot inflate past the limit).
    wallet: (() => { const a = normWallet(server.wallet), b = normWallet(local.wallet); return { hint: Math.max(a.hint, b.hint), freeze: Math.max(a.freeze, b.freeze), skip: Math.max(a.skip, b.skip) }; })(),
    streakSavers: Math.max(0, Math.min(SAVER_CAP, Math.max(Number(server.streakSavers) || 0, Number(local.streakSavers) || 0))),
    savedProgress: Math.max(0, Number(server.savedProgress) || 0, Number(local.savedProgress) || 0),
    updatedAt: Date.now(),
  };
}

// Merge per-exam mock scores across devices: keep the higher best, the newer
// last, and the larger attempt count.
function mergeMockScores(a, b) {
  a = (a && typeof a === "object") ? a : {}; b = (b && typeof b === "object") ? b : {};
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const ex = out[k];
    if (!ex) { out[k] = v; continue; }
    const bestOf = (x, y) => (!x ? y : !y ? x : (y.composite > x.composite ? y : x));
    const lastOf = (x, y) => (!x ? y : !y ? x : ((y.at || 0) > (x.at || 0) ? y : x));
    out[k] = { best: bestOf(ex.best, v.best), last: lastOf(ex.last, v.last), count: Math.max(ex.count || 0, v.count || 0) };
  }
  return out;
}

// SM-2-flavoured scheduling for a graded card.
function schedule(card, ok, examDate) {
  if (ok) {
    const reps = card.reps + 1;
    const interval = reps === 1 ? 1 : reps === 2 ? 3 : Math.max(1, Math.round(card.interval * card.ease));
    const ease = Math.min(2.7, card.ease + 0.05);
    let due = Date.now() + interval * DAY;
    const ex = examDate ? new Date(examDate).getTime() : 0; // never schedule past the exam
    if (ex && ex > Date.now() && due > ex) due = ex;
    return { ...card, reps, interval, ease, due };
  }
  return { ...card, reps: 0, interval: 0, lapses: card.lapses + 1, ease: Math.max(1.3, card.ease - 0.2), due: Date.now() + 10 * 60000 };
}

const StudyContext = createContext(null);
// eslint-disable-next-line react-refresh/only-export-components
export const useStudy = () => useContext(StudyContext);
// eslint-disable-next-line react-refresh/only-export-components
export const usePlans = () => {
  const s = useStudy();
  return {
    plans: s?.plans || [],
    savePlan: s?.savePlan || (() => {}),
    deletePlan: s?.deletePlan || (() => {}),
    completePlanDay: s?.completePlanDay || (() => {}),
    setPlanDayStatus: s?.setPlanDayStatus || (() => {}),
  };
};

export function StudyProvider({ children }) {
  const { user, getToken } = useAuth();
  const [data, setData] = useState(loadLocal);
  const dataRef = useRef(data);
  const hydrated = useRef(false);   // server load/merge done → safe to write up
  const saveTimer = useRef(null);

  // Persist locally + (debounced) to the server on every change.
  useEffect(() => {
    dataRef.current = data;
    try { localStorage.setItem(LS_KEY, JSON.stringify(data)); } catch { /* ignore */ }
    if (!user || !hydrated.current) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try {
        const token = await getToken?.();
        if (!token) return;
        await fetch("/api/study", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ data: dataRef.current }),
        });
      } catch { /* offline / transient, localStorage keeps the copy */ }
    }, 1200);
  }, [data, user, getToken]);

  // On sign-in: pull the server blob, merge with local, adopt as canonical.
  // On sign-out: drop back to local-only (stop writing up).
  useEffect(() => {
    if (!user) { hydrated.current = false; return; }
    let cancelled = false;
    (async () => {
      try {
        const token = await getToken?.();
        if (!token) return;
        const res = await fetch("/api/study", { headers: { Authorization: `Bearer ${token}` } });
        const body = res.ok ? await res.json().catch(() => ({})) : {};
        if (cancelled) return;
        const merged = mergeStudy(body?.data || {}, dataRef.current);
        hydrated.current = true;
        setData(merged); // change effect pushes the merged blob back up once
      } catch {
        if (!cancelled) hydrated.current = true; // allow local→server on next edit
      }
    })();
    return () => { cancelled = true; };
  }, [user, getToken]);

  // ── Mutators (all go through commit → local + server) ──
  const commit = useCallback((updater) => {
    setData((prev) => {
      const base = typeof updater === "function" ? updater(prev) : updater;
      return { ...base, updatedAt: Date.now() };
    });
  }, []);

  // Add missed questions to the deck (deduped by front text). Returns # added.
  const addMissed = useCallback((items) => {
    const prev = dataRef.current;
    const seen = new Set((prev.cards || []).map((c) => (c.front || "").toLowerCase()));
    const toAdd = [];
    for (const it of items || []) {
      const front = String(it.front ?? it.question ?? "").trim();
      const key = front.toLowerCase();
      if (!front || seen.has(key)) continue;
      seen.add(key);
      toAdd.push({
        id: uid(), front,
        back: String(it.back ?? (it.options && it.options[it.correct]) ?? it.answer ?? "").trim(),
        explanation: String(it.explanation ?? "").trim(),
        topic: String(it.topic ?? "").trim(),
        ease: 2.3, interval: 0, due: Date.now(), reps: 0, lapses: 0, createdAt: Date.now(),
      });
    }
    if (toAdd.length) commit((p) => ({ ...p, cards: [...(p.cards || []), ...toAdd] }));
    return toAdd.length;
  }, [commit]);

  const grade = useCallback((id, ok) => {
    commit((p) => ({ ...p, cards: (p.cards || []).map((c) => (c.id === id ? schedule(c, ok, p.examDate) : c)) }));
  }, [commit]);
  const removeCard = useCallback((id) => {
    commit((p) => ({ ...p, cards: (p.cards || []).filter((c) => c.id !== id) }));
  }, [commit]);
  const clearAll = useCallback(() => commit((p) => ({ ...p, cards: [] })), [commit]);
  const setExamDate = useCallback((d) => commit((p) => ({ ...p, examDate: d || null })), [commit]);

  const recordSession = useCallback((answered = 0, correct = 0) => {
    commit((p) => {
      const s = normStats(p.stats), today = dstr();
      let streak = s.streak;
      if (s.lastActive === today) { /* already counted today */ }
      else if (s.lastActive === yesterdayStr()) streak = s.streak + 1;
      else streak = 1;
      return { ...p, stats: {
        answered: s.answered + answered, correct: s.correct + correct,
        streak, best: Math.max(s.best || 0, streak), lastActive: today,
      } };
    });
  }, [commit]);

  // Finish an activity (the one place rewards are granted): tick the universal
  // streak (any mode keeps it alive), award the earned power-up (endless by
  // score; quiz/exam/mock only on a pass), and add study questions toward the
  // next streak saver (study modes only, never the arena). Returns the power-up
  // type earned this time (or null) so the caller can show a toast.
  const completeActivity = useCallback((opts = {}) => {
    const mode = opts.mode || "quiz";
    const correct = Math.max(0, Number(opts.correct) || 0);
    const total = Math.max(0, Number(opts.total) || 0);
    const score = Number(opts.score) || 0;
    const isArena = mode === "arena";
    const earned = isArena ? arenaEarn(score) : passEarn(correct, total);
    commit((p) => {
      const s = normStats(p.stats), today = dstr();
      const st = tickStreak(
        { streak: s.streak, best: s.best, lastActive: s.lastActive, streakSavers: p.streakSavers || 0 },
        today, yesterdayStr(),
      );
      let streakSavers = st.streakSavers;
      let savedProgress = Number(p.savedProgress) || 0;
      if (!isArena) { const sp = addSaverProgress(savedProgress, streakSavers, total); savedProgress = sp.savedProgress; streakSavers = sp.streakSavers; }
      const wallet = earned ? walletAdd(p.wallet, earned) : normWallet(p.wallet);
      return {
        ...p, wallet, streakSavers, savedProgress,
        stats: {
          answered: isArena ? s.answered : s.answered + total,
          correct: isArena ? s.correct : s.correct + correct,
          streak: st.streak, best: st.best, lastActive: today,
        },
      };
    });
    return earned;
  }, [commit]);

  // Spend one power-up the moment it is USED mid-activity, in any mode.
  const usePowerup = useCallback((type) => {
    if (!type || !(type in POWERUP_CAP)) return;
    commit((p) => { const w = normWallet(p.wallet); return { ...p, wallet: { ...w, [type]: Math.max(0, w[type] - 1) } }; });
  }, [commit]);

  // Record per-topic outcomes (seen + correct) from a finished quiz/exam. Powers
  // the mastery view and "drill weak spots". Ignores blank / "general" topics.
  const recordTopics = useCallback((rows) => {
    const clean = (rows || [])
      .map((r) => ({ key: String(r.topic || "").trim().toLowerCase(), label: String(r.topic || "").trim(), correct: !!r.correct }))
      .filter((r) => r.key && r.key !== "general");
    if (!clean.length) return;
    commit((p) => {
      const ts = { ...asTopicStats(p.topicStats) };
      for (const r of clean) {
        const g = ts[r.key] || { label: r.label, seen: 0, correct: 0, lastSeen: 0 };
        ts[r.key] = { label: g.label || r.label, seen: (g.seen || 0) + 1, correct: (g.correct || 0) + (r.correct ? 1 : 0), lastSeen: Date.now() };
      }
      return { ...p, topicStats: ts };
    });
  }, [commit]);

  // Log one graded quiz round into the rolling performance history that powers
  // the student model + adaptive difficulty (lib/studentModel.js). Only called
  // for fresh, difficulty-calibrated quiz rounds (not fix-your-misses re-drills
  // or retries of already-seen sets), so the accuracy signal stays honest.
  const recordPerf = useCallback((entry) => {
    const e = makePerfEntry(entry || {});
    if (!e.total) return;
    commit((p) => ({ ...p, perf: { recent: [...(normPerf(p.perf).recent), e].slice(-PERF_MAX) } }));
  }, [commit]);

  // ── Vetted question bank (Phase 2, lib/questionBank.js) ──
  // Store well-formed MCQs the learner saw and did not flag (reusable), record
  // flagged-bad ones as rejects (never reused + fed to generation as "avoid"),
  // and mark reused ones so drills rotate. All go through the same commit, so
  // the bank syncs and merges like the rest of the study blob.
  const bankAdd = useCallback((items) => {
    if (!items || !items.length) return;
    commit((p) => ({ ...p, bank: bankAddItems(p.bank, items) }));
  }, [commit]);
  const bankReject = useCallback((question, reason) => {
    if (!question) return;
    commit((p) => ({ ...p, bank: bankRejectQ(p.bank, { question, reason }) }));
  }, [commit]);
  const bankUsed = useCallback((hashes) => {
    if (!hashes || !hashes.length) return;
    commit((p) => ({ ...p, bank: bankMarkUsed(p.bank, hashes) }));
  }, [commit]);

  // ── Study library (Phase 3, lib/studyLibrary.js) ──
  // Remember a compact summary of each uploaded material (never the material
  // itself) so Revyy can build a cumulative "quiz me on everything" review.
  const addLibraryDoc = useCallback((doc) => {
    if (!doc) return;
    commit((p) => ({ ...p, library: libraryAddDoc(p.library, doc) }));
  }, [commit]);
  const removeLibraryDoc = useCallback((id) => {
    if (!id) return;
    commit((p) => ({ ...p, library: libraryRemove(p.library, id) }));
  }, [commit]);

  // Record a finished mock's composite for an exam, so a re-test can be cheered
  // (or softened) against the previous attempt. Keeps last + best + count.
  const recordMockScore = useCallback((examId, composite, max) => {
    if (!examId || typeof composite !== "number") return;
    commit((p) => {
      const ms = { ...(p.mockScores || {}) };
      const prev = ms[examId] || { count: 0, best: null, last: null };
      const entry = { composite, max: max ?? null, at: Date.now() };
      ms[examId] = { last: entry, best: (prev.best && prev.best.composite >= composite) ? prev.best : entry, count: (prev.count || 0) + 1 };
      return { ...p, mockScores: ms };
    });
  }, [commit]);

  // ── Study plans ──
  const savePlan = useCallback((plan) => {
    commit((p) => ({ ...p, plans: [...(p.plans || []).filter((x) => x.id !== plan.id), plan] }));
  }, [commit]);
  const deletePlan = useCallback((id) => {
    commit((p) => ({ ...p, plans: (p.plans || []).filter((x) => x.id !== id) }));
  }, [commit]);
  const setPlanDayStatus = useCallback((planId, dayIdx, status) => {
    commit((p) => ({ ...p, plans: (p.plans || []).map((pl) => pl.id !== planId ? pl :
      { ...pl, days: pl.days.map((d, i) => i !== dayIdx ? d :
        { ...d, status, ...(status === "done" ? { doneAt: Date.now() } : { doneAt: null, score: null, total: null }) }) }) }));
  }, [commit]);
  const completePlanDay = useCallback((planId, dayIdx, result) => {
    commit((p) => ({ ...p, plans: (p.plans || []).map((pl) => pl.id !== planId ? pl :
      { ...pl, days: pl.days.map((d, i) => i !== dayIdx ? d :
        { ...d, status: "done", doneAt: Date.now(), score: result?.score ?? null, total: result?.total ?? null }) }) }));
  }, [commit]);

  const value = {
    cards: data.cards, examDate: data.examDate, stats: data.stats, plans: data.plans, topicStats: data.topicStats, perf: data.perf, bank: data.bank, library: data.library, mockScores: data.mockScores,
    wallet: data.wallet, streakSavers: data.streakSavers, savedProgress: data.savedProgress,
    addMissed, grade, removeCard, clearAll, setExamDate, recordSession, recordTopics, recordPerf,
    completeActivity, usePowerup,
    bankAdd, bankReject, bankUsed, addLibraryDoc, removeLibraryDoc, recordMockScore,
    savePlan, deletePlan, completePlanDay, setPlanDayStatus,
  };
  return <StudyContext.Provider value={value}>{children}</StudyContext.Provider>;
}
