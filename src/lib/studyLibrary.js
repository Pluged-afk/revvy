// ── Study library: material "memory" (Phase 3, summaries only) ────────────
// Pure helpers over the `library` slice of the synced study blob. When a learner
// makes a quiz from an upload, generation also returns a compact SUMMARY of that
// material (folded into the same API call, no extra cost). We keep those
// summaries, never the verbatim material, so Revyy can "remember what you've
// studied" and build a cumulative "quiz me on everything" review across all of
// it. Per-user and privacy-light by design: only short AI summaries the learner
// produced from their own uploads, in their own blob, deletable any time.

export const LIBRARY_MAX_DOCS = 40;      // remembered study sets per learner
export const LIB_SUMMARY_MAX = 1200;     // chars kept per summary
export const LIB_MATERIAL_BUDGET = 18000; // chars of summaries fed to a cumulative review

const cap = (s, n) => String(s ?? "").slice(0, n);
const uid = () => globalThis.crypto?.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2);

export function normLibrary(l) {
  const docs = Array.isArray(l?.docs) ? l.docs : [];
  return { docs: docs.filter((d) => d && d.id && d.summary).slice(-LIBRARY_MAX_DOCS) };
}

// Shape one remembered set from a finished generation, or null if there is not
// enough of a summary to be worth keeping.
export function makeLibraryDoc({ title, subject, topics, summary, n } = {}) {
  const sum = cap(summary, LIB_SUMMARY_MAX).trim();
  if (sum.length < 20) return null;
  const topicList = Array.isArray(topics)
    ? [...new Set(topics.map((t) => cap(t, 60).trim()).filter(Boolean))].slice(0, 12)
    : [];
  return {
    id: uid(),
    title: cap(title, 120).trim() || "Study set",
    subject: cap(subject, 80).trim(),
    topics: topicList,
    summary: sum,
    n: Math.max(0, Math.round(n) || 0),
    addedAt: Date.now(),
  };
}

// Add a doc, newest first. Re-quizzing the same material (same title+subject)
// refreshes the existing entry rather than duplicating it. Capped.
export function libraryAddDoc(library, doc) {
  if (!doc) return normLibrary(library);
  const b = normLibrary(library);
  const key = (d) => `${d.title}|${d.subject}`.toLowerCase();
  const k = key(doc);
  return { docs: [doc, ...b.docs.filter((d) => key(d) !== k)].slice(0, LIBRARY_MAX_DOCS) };
}

export function libraryRemove(library, id) {
  return { docs: normLibrary(library).docs.filter((d) => d.id !== id) };
}

export function librarySize(library) {
  return normLibrary(library).docs.length;
}

export function libraryTopics(library) {
  const set = new Set();
  for (const d of normLibrary(library).docs) for (const t of d.topics) set.add(t);
  return [...set];
}

// Build the material text for a "quiz me on everything" cumulative review from
// the stored summaries, newest first, within a char budget so a big library
// never blows the token budget.
export function buildLibraryMaterial(library) {
  const b = normLibrary(library);
  if (!b.docs.length) return "";
  const parts = [];
  let used = 0;
  for (const d of b.docs) {
    const block = `## ${d.title}${d.subject ? ` (${d.subject})` : ""}\n${d.topics.length ? `Topics: ${d.topics.join(", ")}\n` : ""}${d.summary}`;
    if (used + block.length > LIB_MATERIAL_BUDGET && parts.length) break;
    parts.push(block);
    used += block.length;
  }
  return `The student has studied the material below over time. Here is a summary of each set they have covered. Write questions that draw across ALL of it, mixing topics from the different sets so this feels like a cumulative review of everything they have studied:\n\n${parts.join("\n\n")}`;
}

// Merge two libraries (multi-device sync): union by id, then collapse duplicates
// of the same material (title+subject) keeping the newer, newest first, capped.
export function libraryMerge(a, b) {
  const A = normLibrary(a), B = normLibrary(b);
  const byId = new Map();
  for (const d of [...A.docs, ...B.docs]) {
    const ex = byId.get(d.id);
    if (!ex || (d.addedAt || 0) > (ex.addedAt || 0)) byId.set(d.id, d);
  }
  const byKey = new Map();
  for (const d of [...byId.values()].sort((x, y) => (y.addedAt || 0) - (x.addedAt || 0))) {
    const k = `${d.title}|${d.subject}`.toLowerCase();
    if (!byKey.has(k)) byKey.set(k, d);
  }
  return { docs: [...byKey.values()].sort((x, y) => (y.addedAt || 0) - (x.addedAt || 0)).slice(0, LIBRARY_MAX_DOCS) };
}
