// Pure, self-contained helpers extracted from StudyQuiz.jsx (no React, no DOM).

// Strip a leading emoji (and its trailing space) from a translated label so we
// can show a clean SVG icon in front of it instead. Leaves the words intact.
export const stripEmoji = (s) => String(s ?? "").replace(/^[\u{1F000}-\u{1FAFF}☀-➿⬀-⯿←-⇿️‍\s]+/u, "").trim();

// Unread social notifications = server counts minus the learner's last-seen
// counts. Split by category so the pop-ups + toggles can target each type.
export function computeUnread(data, seen) {
  const s = seen || {};
  if (!data) return { friends: 0, msg: 0, chal: 0, total: 0, byGroup: {}, byFriend: {} };
  const friends = Math.max(0, (data.friendReqs || 0) - (s.friendReqs || 0));
  let msg = 0, chal = 0; const byGroup = {}, byFriend = {};
  for (const g of data.groups || []) {
    const sg = (s.g && s.g[g.id]) || { m: 0, c: 0 };
    const m = Math.max(0, (g.msg || 0) - (sg.m || 0));
    const c = Math.max(0, (g.chal || 0) - (sg.c || 0));
    msg += m; chal += c; byGroup[g.id] = { m, c };
  }
  for (const d of data.dms || []) {
    const dm = Math.max(0, (d.msg || 0) - ((s.f && s.f[d.id]) || 0));
    msg += dm; byFriend[d.id] = dm;
  }
  return { friends, msg, chal, total: friends + msg + chal, byGroup, byFriend };
}

// A group-activity line in words.
export function activityText(a, t) {
  if (a.kind === "created") return t.actCreated || "created the group";
  if (a.kind === "joined") return t.actJoined || "joined the group";
  if (a.kind === "shared") return `${t.actShared || "shared"} ${a.detail || ""}`.trim();
  if (a.kind === "quiz") return `${t.actScored || "scored"} ${a.detail || ""}`.trim();
  return a.detail || a.kind;
}

// Compact relative time ("now", "5m", "2h", "3d").
export function timeAgo(at) {
  const d = new Date(at).getTime();
  if (isNaN(d)) return "";
  const s = Math.max(0, Math.floor((Date.now() - d) / 1000));
  if (s < 60) return "now";
  const m = Math.floor(s / 60); if (m < 60) return m + "m";
  const h = Math.floor(m / 60); if (h < 24) return h + "h";
  return Math.floor(h / 24) + "d";
}

// Parse a pasted Quizlet export into flashcards. Quizlet separates term from
// definition with a Tab (or comma) and cards with a newline (or semicolon); we
// split on the first separator per row so definitions keep their own commas.
// Pure string work, no URL, no network, no fetch: none of the link-import risk.
export function parseQuizlet(text) {
  const raw = String(text || "").trim();
  if (!raw) return [];
  const rows = raw.includes("\n") ? raw.split(/\r?\n+/) : raw.split(/;+/);
  const cards = [];
  for (const row of rows) {
    const line = row.trim();
    if (!line) continue;
    let m = line.match(/^([^\t]+)\t+(.+)$/);      // term<TAB>definition
    if (!m) m = line.match(/^(.+?) {2,}(.+)$/);    // term<2+ spaces>definition
    if (!m) m = line.match(/^([^,]+),\s*(.+)$/);   // term,definition
    if (!m) continue;
    const term = m[1].trim(), def = m[2].trim();
    if (term && def) cards.push({ question: term, answer: def, topic: "" });
    if (cards.length >= 300) break; // sane cap
  }
  return cards;
}

// Marks for a custom-exam section. Two modes: "perQ" (the user sets marks per
// question) or "total" (the user sets the section's overall score, split evenly
// across its questions). Per-question marks stay exact (fractional if needed) so
// the section total is preserved when scoring. Missing markMode = "perQ" (old).
export function sectionPerQMarks(sec) {
  const count = Math.max(1, parseInt(sec?.count) || 1);
  if (sec?.markMode === "total") {
    const tot = parseFloat(sec.sectionMarks);
    return (isFinite(tot) && tot > 0) ? tot / count : 1;
  }
  return parseFloat(sec?.marksPerQ) || 1;
}

export function sectionMarksTotal(sec) {
  return (parseInt(sec?.count) || 0) * sectionPerQMarks(sec);
}

export const roundMarks = (x) => Math.round((Number(x) || 0) * 100) / 100; // tidy fractional marks for display

export function fmtMB(bytes)  { return (bytes/1024/1024).toFixed(1)+"MB"; }

export function fmtDate(iso)  {
  if (!iso) return "";
  try { return new Date(iso).toLocaleDateString(undefined,{year:"numeric",month:"long",day:"numeric"}); }
  catch { return ""; }
}

export function stripFences(t) {
  return (t||"").trim().replace(/^```json\s*/i,"").replace(/^```\s*/i,"").replace(/\s*```$/i,"").trim();
}

// Randomize which position holds the correct option, so the key isn't clustered
// (models tend to over-use one letter, e.g. every answer "B"). No-op for
// non-MCQ questions (empty options) and safe against duplicate option text.
export function shuffleMCQOptions(q) {
  if (!q || !Array.isArray(q.options) || q.options.length < 2 || !Number.isInteger(q.correct) || q.correct < 0 || q.correct >= q.options.length) return q;
  const correctVal = q.options[q.correct];
  const opts = q.options.map((text, i) => ({ text, wasCorrect: i === q.correct }));
  for (let i = opts.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [opts[i], opts[j]] = [opts[j], opts[i]]; }
  const correct = opts.findIndex((o) => o.wasCorrect);
  return { ...q, options: opts.map((o) => o.text), correct: correct >= 0 ? correct : q.correct, answer: correctVal ?? q.answer };
}

// Shape a model-returned MCQ into the app's question object, or null if it is
// malformed. Shared by flag/fix regeneration and flag verification.
export function normalizeQuestion(parsed, orig) {
  const options = Array.isArray(parsed?.options) ? parsed.options.filter((o)=>typeof o==="string"&&o.trim()) : [];
  if (options.length < 2 || !Number.isInteger(parsed.correct) || parsed.correct < 0 || parsed.correct >= options.length) return null;
  return {
    question: String(parsed.question || "").trim(),
    options,
    correct: parsed.correct,
    answer: options[parsed.correct] || "",
    explanation: String(parsed.explanation || "").trim().slice(0, 400),
    topic: String(parsed.topic || orig?.topic || "").trim().slice(0, 60),
    source: typeof parsed.source === "string" ? parsed.source.trim().slice(0, 240) : "",
  };
}

// ── Fill-in-the-blank grading ──────────────────────────────────────────
// Normalize an answer for fair comparison: lowercase, strip accents, drop
// punctuation, collapse whitespace, and remove a leading article.
export function normFill(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "") // strip accents
    .replace(/[^\p{L}\p{N}\s]/gu, " ")                // punctuation -> space
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(the|a|an)\s+/, "");
}
// Grade a fill-in-the-blank response. Deliberately STRICT so a different but
// similar-looking WORD is NEVER marked right: only a normalized exact match, an
// AI-supplied acceptable alternative, or a singular/plural form of the same word.
// We intentionally do NO fuzzy edit-distance matching, because a genuine typo and
// a different real word can be the identical single edit (compliment/complement,
// desert/dessert, form/from, affect/effect) and no offline algorithm can tell
// them apart. Genuine typos are instead handled by the model's per-question
// `accept` list (which includes likely misspellings), so a match is always
// against a vetted answer, never a coincidental look-alike. Cheap, no AI call.
export function gradeFill(userVal, answer, accept = []) {
  const u = normFill(userVal);
  if (!u) return false;
  const candidates = [answer, ...(Array.isArray(accept) ? accept : [])].map(normFill).filter(Boolean);
  for (const c of candidates) {
    if (u === c) return true;
    // singular/plural of the SAME word (skip very short stems where +s could
    // form an unrelated word, e.g. as/ass, bu/bus).
    if (u.length >= 3 && c.length >= 3 && (u + "s" === c || c + "s" === u || u + "es" === c || c + "es" === u)) return true;
  }
  return false;
}

// Keep a figure only if it is a clean, self-contained <svg> (rendered inside an
// <img> data-URI, which can't run scripts; this strips anything scriptable too).
// an SVG shown via <img> must carry the SVG namespace or the browser shows a
// broken image, so add xmlns when the model leaves it off.
export function safeSvg(s) {
  s = typeof s === "string" ? s.trim() : "";
  if (!(/^<svg[\s>]/i.test(s) && s.length < 12000 && !/<script|<foreignobject|\son\w+\s*=|javascript:/i.test(s))) return "";
  if (!/\sxmlns\s*=/i.test(s)) s = s.replace(/^<svg/i, "<svg xmlns='http://www.w3.org/2000/svg'");
  return s;
}
