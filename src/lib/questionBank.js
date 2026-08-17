// ── Per-user vetted question bank (Phase 2) ───────────────────────────────
// Pure helpers over the `bank` slice of the synced study blob. The bank is a
// growing, self-vetting store of the learner's OWN good MCQs (well-formed and
// never flagged), plus a short memory of the questions they flagged as bad. It
// powers two things:
//   1. Cost + speed: "drill weak spots" reuses vetted questions instead of
//      regenerating every one from the API.
//   2. Self-improving quality: a flagged question is rejected (never reused) and
//      its gist is fed back into generation as an explicit "avoid these" list,
//      so the questions a learner sees get better over time.
// Per-user ONLY (privacy): a bank item is derived from that learner's material
// and lives in their own blob, exactly like the rest of study_data. Nothing is
// pooled across users.

export const BANK_MAX_ITEMS = 120;   // reusable vetted questions kept per learner
export const BANK_MAX_REJECTS = 40;  // recent flagged-bad questions remembered

const cap = (s, n) => String(s ?? "").slice(0, n);
export const normTopicKey = (t) => String(t || "").trim().toLowerCase();

// Stable, cheap hash of a question's identity (its normalized stem), used to
// dedupe and to match a question against the reject list.
export function qhashOf(text) {
  const s = String(text || "").toLowerCase().replace(/\s+/g, " ").trim();
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// Keep only a well-formed MCQ, size-capped so the synced blob stays lean.
// Returns null for anything that is not a reusable multiple-choice question
// (flashcards / fill / match have no options and are skipped automatically).
function leanQ(q) {
  if (!q || !Array.isArray(q.options) || q.options.length < 2) return null;
  if (!Number.isInteger(q.correct) || q.correct < 0 || q.correct >= q.options.length) return null;
  const question = cap(q.question, 400);
  if (question.length < 8) return null;
  return {
    question,
    options: q.options.slice(0, 6).map((o) => cap(o, 200)),
    correct: q.correct,
    answer: cap(q.answer, 300),
    explanation: cap(q.explanation, 300),
    topic: cap(q.topic, 60),
    source: cap(q.source, 240),
  };
}

// Shape one vetted item from a finished question, or null if not bankable.
export function makeBankItem({ q, diff = 1, type = "mcq", quality = 1 } = {}) {
  const lean = leanQ(q);
  if (!lean) return null;
  return {
    hash: qhashOf(lean.question),
    topicKey: normTopicKey(lean.topic),
    diff: Math.max(0, Math.min(2, Math.round(diff) || 0)),
    type,
    quality,
    seen: 1,
    lastUsed: 0,           // ms of last reuse; 0 = never reused
    addedAt: Date.now(),
    q: lean,
  };
}

export function normBank(b) {
  b = b || {};
  return {
    items: (Array.isArray(b.items) ? b.items : []).filter((x) => x && x.hash && x.q).slice(-BANK_MAX_ITEMS * 2),
    rejects: (Array.isArray(b.rejects) ? b.rejects : []).filter((x) => x && x.hash).slice(-BANK_MAX_REJECTS),
  };
}

// Prune to the cap, dropping low-quality first, then least-recently-useful.
function prune(items) {
  if (items.length <= BANK_MAX_ITEMS) return items;
  return [...items]
    .sort((a, b) => (b.quality - a.quality) || ((b.lastUsed || 0) - (a.lastUsed || 0)) || ((b.seen || 0) - (a.seen || 0)) || ((b.addedAt || 0) - (a.addedAt || 0)))
    .slice(0, BANK_MAX_ITEMS);
}

// Upsert vetted items (dedupe by hash; bump `seen`; keep the best quality).
// A hash already on the reject list is never re-banked. Returns a new bank.
export function bankAddItems(bank, newItems) {
  const b = normBank(bank);
  const rejected = new Set(b.rejects.map((r) => r.hash));
  const byHash = new Map(b.items.map((it) => [it.hash, it]));
  for (const it of newItems || []) {
    if (!it || !it.hash || rejected.has(it.hash)) continue;
    const ex = byHash.get(it.hash);
    if (ex) byHash.set(it.hash, { ...ex, seen: (ex.seen || 1) + 1, quality: Math.max(ex.quality || 0, it.quality || 0), topicKey: ex.topicKey || it.topicKey });
    else byHash.set(it.hash, it);
  }
  return { items: prune([...byHash.values()]), rejects: b.rejects };
}

// Record a flagged-bad question: drop it from reusable items and remember its
// gist so generation can steer clear. Returns a new bank.
export function bankRejectQ(bank, { question, reason = "" } = {}) {
  const b = normBank(bank);
  const hash = qhashOf(question);
  return {
    items: b.items.filter((it) => it.hash !== hash),
    rejects: [...b.rejects.filter((r) => r.hash !== hash), { hash, text: cap(question, 200), reason: cap(reason, 20), at: Date.now() }].slice(-BANK_MAX_REJECTS),
  };
}

// Mark reused items so rotation favours ones not served recently.
export function bankMarkUsed(bank, hashes) {
  const b = normBank(bank);
  const set = new Set(hashes || []);
  if (!set.size) return b;
  return { items: b.items.map((it) => set.has(it.hash) ? { ...it, lastUsed: Date.now(), seen: (it.seen || 1) + 1 } : it), rejects: b.rejects };
}

// Pick up to n vetted MCQs for the given topics, least-recently-used first, so a
// drill can reuse them instead of generating. Only reuses on-topic questions (a
// weak-spot drill must stay on the weak topics). Each returned question carries
// a hidden `_bankHash` so the caller can mark it used.
export function bankPick(bank, topicKeys, n, { excludeHashes = [] } = {}) {
  const b = normBank(bank);
  const want = new Set((topicKeys || []).map(normTopicKey).filter(Boolean));
  if (!want.size || n <= 0) return [];
  const exclude = new Set(excludeHashes);
  const pool = b.items.filter((it) => it.type === "mcq" && it.quality >= 1 && want.has(it.topicKey) && !exclude.has(it.hash));
  return pool
    .sort((a, b2) => (a.lastUsed || 0) - (b2.lastUsed || 0) || (b2.quality - a.quality))
    .slice(0, n)
    .map((it) => ({ ...it.q, _bankHash: it.hash }));
}

// Recent flagged-bad question stems, for an explicit "do not generate anything
// like these" instruction. Returns [] when the learner has flagged nothing.
export function bankAvoid(bank, max = 4) {
  return normBank(bank).rejects.map((r) => r.text).filter(Boolean).slice(-max);
}

// Build the localized-agnostic AVOID block appended to generation prompts. This
// is the visible half of the content feedback loop: what the learner rejected
// steers what the model produces next. Empty (no cost) when nothing was flagged.
export function buildAvoidNote(bank, { max = 4 } = {}) {
  const texts = bankAvoid(bank, max);
  if (!texts.length) return "";
  return `AVOID: the learner has flagged questions like these as unclear, off-topic, or mis-keyed. Do NOT produce anything similar in wording or answer key:\n- ${texts.map((t) => t.slice(0, 140)).join("\n- ")}`;
}

// Count of reusable vetted questions (for UI / analytics).
export function bankSize(bank) {
  return normBank(bank).items.filter((it) => it.quality >= 1).length;
}

// Merge two banks (multi-device sync). Union items by hash keeping the stronger
// copy; union rejects by hash keeping the newer; a reject on either side wins,
// so a question one device flagged is dropped from the other's reusable items.
export function bankMerge(a, b) {
  const A = normBank(a), B = normBank(b);
  const rejectsByHash = new Map();
  for (const r of [...A.rejects, ...B.rejects]) {
    const ex = rejectsByHash.get(r.hash);
    if (!ex || (r.at || 0) > (ex.at || 0)) rejectsByHash.set(r.hash, r);
  }
  const rejected = new Set(rejectsByHash.keys());
  const byHash = new Map();
  for (const it of [...A.items, ...B.items]) {
    if (rejected.has(it.hash)) continue;
    const ex = byHash.get(it.hash);
    if (!ex) byHash.set(it.hash, it);
    else byHash.set(it.hash, { ...ex, seen: Math.max(ex.seen || 1, it.seen || 1), quality: Math.max(ex.quality || 0, it.quality || 0), lastUsed: Math.max(ex.lastUsed || 0, it.lastUsed || 0) });
  }
  return { items: prune([...byHash.values()]), rejects: [...rejectsByHash.values()].slice(-BANK_MAX_REJECTS) };
}
