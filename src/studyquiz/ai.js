// Claude generation + grading layer extracted from StudyQuiz.jsx. Pure request
// helpers over /api/anthropic: quiz/exam generation, short-answer grading,
// tutor explanations, flag-verify/regenerate, and the upload content gate. No
// React, no component state; depends only on shared constants + helpers.
import { AI_MODEL, DIFFICULTY } from "./constants.js";
import { stripFences, shuffleMCQOptions, normalizeQuestion } from "./helpers.js";

// ── Claude API ────────────────────────────────────────────────────────
// The AI proxy + file upload spend the server's Anthropic key, so both require
// a signed-in user. StudyQuiz registers Clerk's getToken here so these
// module-level request helpers can attach a fresh bearer token to every call.
let _getToken = null;
export async function authHeader() {
  try { const t = await _getToken?.(); return t ? { Authorization: `Bearer ${t}` } : {}; }
  catch { return {}; }
}
// StudyQuiz registers Clerk's getToken (see the effect in the component) so
// these module-level helpers can attach a fresh bearer token to every call.
export function registerToken(fn) { _getToken = fn; }
export async function callClaude({ blocks, numQ, diff, type, uiLangName, learnerBrief, withSummary }) {
  const typeMap = {
    mcq:   `Multiple choice: exactly 4 options. "correct" is 0-based index of the right answer.`,
    cards: `Flashcards: "question" = front (term/concept), "answer" = back (full explanation). Set options:[] correct:0.`,
    fill:  `Fill in the blank: each "question" has exactly one blank written as ___. "answer" = the missing word or phrase. Also add "accept": an array of up to 5 OTHER responses that should also count as correct (synonyms, abbreviations, singular/plural, alternate spellings, and the most likely genuine misspellings of the answer); do NOT include different words that merely look similar; use [] if there are none. Keep the answer a short word or phrase, not a whole sentence. Set options:[] correct:0.`,
    match: `Matching pairs: "question" = term, "answer" = definition. Set options:[] correct:0.`,
    written: `Short answer: "question" = an open-ended question that needs a 1-3 sentence written response. "answer" = a concise, complete model answer the response is graded against. Set options:[] correct:0.`,
    diagram: `Diagram questions on the image the user uploaded (their real diagram/figure). For EACH question pick ONE distinct part or region, and give its location as "x" and "y": numbers 0 to 100 for the CENTER of that part as a percentage of the image width (x, 0=left 100=right) and height (y, 0=top 100=bottom), so a red circle marker can be drawn on it, be accurate. Then ask a question ABOUT that marked part with 4 plausible "options", "correct" (0-based index), and "answer" (the correct option's exact text). Refer to it in the question as "the circled part / structure / region" (a red circle is drawn there), NOT by a vague location like "on the left". CRITICAL: if the diagram ALREADY LABELS its parts (names printed on the image), do NOT ask "what is the circled part", the answer would be sitting right next to the marker; instead test real understanding of it, its FUNCTION or role, what it connects to or interacts with, its step or order in the process, what happens if it is removed or fails, or how it differs from another part. Only ask a plain "what is the circled part" identification question when the diagram is UNLABELED. Never write a question that can be answered just by reading text printed in the image. Vary the question types across the set, and do not mark the same part twice.`,
  };
  const wantsCoords = type === "diagram";
  const wantsAccept = type === "fill";
  // `diff` is the 0/1/2 index; map to the difficulty rubric.
  const d = DIFFICULTY[typeof diff === "number" ? diff : 1] || DIFFICULTY[1];
  const prompt = `Generate EXACTLY ${numQ} study questions from the material, not ${numQ-1}, not ${numQ+1}, EXACTLY ${numQ}. This is a strict requirement: the "questions" array MUST contain exactly ${numQ} items. Do not stop early; produce all ${numQ}, then count them before responding.\nQuiz type: ${typeMap[type]}\nDIFFICULTY: ${d.name}. ${d.guide} Calibrate every question to this ${d.name} level.\nFAIRNESS: whatever the level, difficulty must come from the depth of thinking and the number of concepts a learner must connect, NEVER from trick wording, deliberate ambiguity, obscure trivia, or gotchas. Every question must be clearly answerable from a genuine understanding of the material and have exactly ONE defensible correct answer.\nLANGUAGE: Write the ENTIRE quiz, every question, all answer options, the answer, the explanation, and the title/subject/topic, in the SAME language as the study material above. Match the material's language exactly; do NOT translate it into English.${uiLangName?` If the material is too short to tell its language, use ${uiLangName}.`:""}${learnerBrief?`\n${learnerBrief}`:""}\nReturn ONLY raw JSON (no markdown, no backticks):\n{"title":"Short title","subject":"Subject","questions":[{"question":"...","options":["A","B","C","D"],"correct":0,"answer":"...","explanation":"One sentence","topic":"2-4 word sub-topic","source":"..."${wantsCoords?`,"x":50,"y":50`:""}${wantsAccept?`,"accept":["alternative answer"]`:""}}]${withSummary?`,"summary":"a compact digest of this material for the study library"`:""}}\nSet "topic" to the specific concept each question tests (2-4 words, e.g. "Photosynthesis", "Supply and demand"), used to track weak areas. Set "source" to SHORT verbatim words copied straight from the study material (a phrase or one sentence, max ~25 words, exact wording, no paraphrasing) that back up the correct answer, so the learner can see exactly where it came from; if a question leans on general knowledge NOT stated in the material, set "source" to an empty string "". For any question that needs working out, compute the answer FIRST and make sure "correct" points to that result; the "explanation" must be a single clean final sentence that never second-guesses or recalculates itself (no "wait", "let me recalculate", "actually"). Make all 4 options plausible. Vary question styles across the set. The "questions" array length MUST equal ${numQ}.${withSummary?`\nALSO add a top-level "summary" field LAST: a compact digest (max 120 words) of the KEY concepts, definitions and facts this material covers, in the SAME language as the material, so the learner's study library can remember what it was about later. Cover the material as a whole, not any single question.`:""}`;

  // Scale output budget with the question count so big sets aren't truncated
  // (each Q ≈ 160 tokens, +generous headroom). Haiku 4.5 allows up to 64k
  // output and the proxy streams, so a high ceiling is safe; capped at 48k.
  // max_tokens is a ceiling, not a charge, you're billed only for tokens
  // actually generated. Generous per-question budget so a 100-question set
  // never truncates mid-generation.
  const maxTokens = Math.min(Math.max(Math.round(numQ * 300) + 3000, 4000), 48000);

  const res = await fetch("/api/anthropic", {
    method:"POST", headers:{"Content-Type":"application/json", ...(await authHeader())},
    body: JSON.stringify({ model:AI_MODEL, max_tokens:maxTokens,
      system:"You are an expert educator. Return ONLY valid raw JSON, no markdown.",
      messages:[{ role:"user", content:[...blocks,{type:"text",text:prompt}] }] }),
  });
  if (!res.ok) { const e=await res.json().catch(()=>({})); throw new Error(e.error?.message||`Error ${res.status}`); }
  const raw = stripFences(await readStream(res));
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch {
    // Truncated on a big set (hit the token ceiling): salvage the questions that
    // completed by closing the array + object after the last complete object,
    // so the generate loop keeps a partial set instead of losing everything.
    const cut = raw.lastIndexOf("}");
    if (cut > 0) { try { parsed = JSON.parse(raw.slice(0, cut + 1) + "]}"); } catch { /* fall through */ } }
    if (!parsed) throw new Error("Unexpected format");
  }
  // Bound the per-question "source" excerpt (feature A: show the learner where
  // each answer came from in their own material). A blank/missing source means
  // the question leaned on general knowledge, which the UI flags to double-check.
  if (parsed && Array.isArray(parsed.questions)) {
    parsed.questions = parsed.questions.map((q) =>
      q && typeof q === "object"
        ? shuffleMCQOptions({
            ...q,
            question: deDash(q.question),
            answer: deDash(q.answer),
            explanation: deDash(q.explanation),
            topic: deDash(q.topic),
            options: Array.isArray(q.options) ? q.options.map(deDash) : q.options,
            // diagram: keep the marker coords (0..100), clamped
            ...(typeof q.x === "number" && typeof q.y === "number" ? { x: Math.max(0, Math.min(100, q.x)), y: Math.max(0, Math.min(100, q.y)) } : {}),
            // fill: keep the AI's acceptable-alternative answers (bounded, de-dashed)
            ...(Array.isArray(q.accept) ? { accept: q.accept.filter((x) => typeof x === "string" && x.trim()).slice(0, 6).map(deDash) } : {}),
            // source stays verbatim (it's an exact quote from the learner's own material)
            source: typeof q.source === "string" ? q.source.trim().slice(0, 240) : "",
          })
        : q
    );
  }
  if (parsed) { parsed.title = deDash(parsed.title); parsed.subject = deDash(parsed.subject); }
  // Phase 3: cap the optional material summary (study library "memory"). Absent
  // on a truncated response, which is fine, the library just skips that upload.
  if (parsed && typeof parsed.summary === "string") parsed.summary = deDash(parsed.summary.trim().slice(0, 1200));
  return parsed;
}

// Read the streamed plain-text response from /api/anthropic into one string.
export async function readStream(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let out = "";
  for (;;) { const { done, value } = await reader.read(); if (done) break; out += dec.decode(value, { stream: true }); }
  out += dec.decode();
  return out;
}
// House rule: no em/en dashes in any user-facing text (a well-known AI tell). The
// model reaches for them constantly, so strip them from generated content and
// tutor replies, replacing with a comma. Non-strings pass through untouched.
export const deDash = (s) => typeof s === "string" ? s.replace(/\s*[—–]\s*/g, ", ") : s;

// One-shot plain-text tutor completion via the same proxy (no JSON). Used by
// the "Explain why" feature on wrong answers.
export async function callClaudeText(prompt, max = 400) {
  const res = await fetch("/api/anthropic", {
    method:"POST", headers:{"Content-Type":"application/json", ...(await authHeader())},
    body: JSON.stringify({ model:AI_MODEL, max_tokens:max,
      system:"You are a warm, encouraging tutor. Keep replies SHORT and to the point, usually 1-3 sentences; only write more when the concept genuinely needs it. Plain text, no markdown, no headings, no preamble or filler, get straight to the point.",
      messages:[{ role:"user", content:[{type:"text",text:prompt}] }] }),
  });
  if (!res.ok) throw new Error("explain failed");
  // de-dash tutor explanations + short-answer grading feedback (see deDash)
  return deDash((await readStream(res)).trim());
}

// Grade one short-answer response against its model answer. Fair and
// encouraging: rewards correct understanding even when the wording differs.
// Returns { score: 1 | 0.5 | 0, feedback }.
export async function gradeWritten({ question, modelAnswer, userAnswer, subject }) {
  if (!String(userAnswer || "").trim()) return { score: 0, feedback: "" };
  const raw = await callClaudeText(
    `Grade a student's short answer fairly and encouragingly; reward correct understanding even when the wording differs from the model answer.\nQuestion: ${question}\nModel answer: ${modelAnswer || "(none given)"}\nStudent answer: ${userAnswer}${subject ? `\nSubject: ${subject}` : ""}\nReply with ONLY compact JSON, no other text: {"score":1|0.5|0,"feedback":"one short sentence"}. 1 = correct, 0.5 = partially correct, 0 = incorrect.`,
    300,
  );
  try {
    const j = JSON.parse(stripFences(raw));
    const score = j.score === 1 ? 1 : j.score === 0.5 ? 0.5 : 0;
    return { score, feedback: String(j.feedback || "").slice(0, 240) };
  } catch {
    // model didn't return clean JSON: keep its text as feedback, award nothing
    return { score: 0, feedback: String(raw || "").slice(0, 240) };
  }
}
export function explainAnswer({ question, correct, picked, subject }) {
  return callClaudeText(
    `A student just answered a study question wrong.\nQuestion: ${question}\nCorrect answer: ${correct}\nStudent's answer: ${picked || "(left blank)"}${subject ? `\nSubject: ${subject}` : ""}\nIn 1-2 short sentences, say why the correct answer is right and gently name the likely misunderstanding. Be concise and concrete, no filler.`
  );
}
export function followupAnswer({ question, correct, prior, ask }) {
  return callClaudeText(
    `A student is reviewing a quiz question they got wrong.\nQuestion: ${question}\nCorrect answer: ${correct}\nYour earlier explanation: ${prior}\nThe student now asks: "${ask}"\nAnswer concisely in 1-2 sentences; expand only if the question truly needs it. If they go off-topic, answer in ONE short friendly line and steer back, do not lecture.`
  );
}

// Feature B: write ONE replacement multiple-choice question when the learner
// flags one as confusing / off-material (or as a fallback after verification).
// Reuses the ORIGINAL study material (blocks) so the fix stays grounded.
export async function regenerateQuestion({ blocks, q, subject, reason, uiLangName, diff }) {
  const d = DIFFICULTY[typeof diff === "number" ? diff : 1] || DIFFICULTY[1];
  const reasonLine = {
    wrong:   "The learner says the marked correct answer looks wrong.",
    unclear: "The learner says it was confusing or badly worded.",
    offnotes:"The learner says it was not covered in their material.",
  }[reason] || "The learner flagged a problem with it.";
  const topic = q.topic || subject || "the same concept";
  const optLine = Array.isArray(q.options) ? q.options.join(" / ") : "(none)";
  const prompt = `A study question was flagged as having a problem. ${reasonLine}
Flagged question: ${q.question}
Its options were: ${optLine}
Write ONE brand-new multiple-choice question that tests the SAME concept (${topic}) but fixes the problem: exactly 4 options, exactly ONE clearly correct answer, plausible distractors, and clear unambiguous wording. Work the answer out yourself first and make sure "correct" is the index of that answer. Do not repeat the flagged question.
DIFFICULTY: ${d.name}. ${d.guide}
Base it on the study material above. In "source", copy SHORT verbatim words from that material that back up the answer (max ~25 words, exact wording, no paraphrasing); if it must rely on general knowledge not in the material, set "source" to "".
LANGUAGE: write the question, every option, the explanation and the source in the SAME language as the study material.${uiLangName ? ` If that is unclear, use ${uiLangName}.` : ""}
Return ONLY raw JSON, no markdown: {"question":"...","options":["A","B","C","D"],"correct":0,"answer":"...","explanation":"One sentence","topic":"${topic}","source":"..."}`;
  const res = await fetch("/api/anthropic", {
    method:"POST", headers:{"Content-Type":"application/json", ...(await authHeader())},
    body: JSON.stringify({ model:AI_MODEL, max_tokens:1200,
      system:"You are an expert educator. Return ONLY valid raw JSON, no markdown.",
      messages:[{ role:"user", content:[...(blocks||[]),{type:"text",text:prompt}] }] }),
  });
  if (!res.ok) { const e=await res.json().catch(()=>({})); throw new Error(e.error?.message||`Error ${res.status}`); }
  const nq = normalizeQuestion(JSON.parse(stripFences(await readStream(res))), q);
  if (!nq) throw new Error("Malformed replacement");
  return nq;
}

// Feature B (verify): when the learner says the marked answer is WRONG, don't
// blindly rewrite. Re-check the question against their material plus the model's
// own knowledge and return a verdict: the answer holds up (with the reason and a
// supporting quote), the learner is right (with a corrected question), or it was
// genuinely ambiguous (with a clearer one).
export async function verifyFlaggedQuestion({ blocks, q, uiLangName, diff }) {
  const d = DIFFICULTY[typeof diff === "number" ? diff : 1] || DIFFICULTY[1];
  const marked = Array.isArray(q.options) ? (q.options[q.correct] ?? "") : (q.answer || "");
  const optLine = Array.isArray(q.options) ? q.options.map((o,i)=>`${i}: ${o}`).join(" | ") : "(none)";
  const prompt = `A learner thinks this quiz question is mis-keyed, that the marked "correct" answer is actually wrong. Check carefully whether the marked answer is truly correct, using the study material above plus your own reliable knowledge. Reason it out before deciding.
Question: ${q.question}
Options (index: text): ${optLine}
Marked correct answer: index ${q.correct} = "${marked}"
Choose ONE verdict:
- "answer_correct": the marked answer is right. Briefly explain why for the learner, and if the material states it, quote the exact supporting words in "answerSource". Set "replacement" to null.
- "student_right": the marked answer is genuinely wrong. Give a corrected replacement question (with the right answer keyed) in "replacement".
- "ambiguous": the question is unclear or has more than one defensible answer. Give a clearer replacement question in "replacement".
Keep any replacement at a similar difficulty (${d.name}) and grounded in the material, with a "source" quote where possible.
Write every learner-facing string in the SAME language as the study material.${uiLangName ? ` If unclear, use ${uiLangName}.` : ""}
Return ONLY raw JSON, no markdown: {"verdict":"answer_correct","explanation":"...","answerSource":"...","replacement":{"question":"...","options":["A","B","C","D"],"correct":0,"answer":"...","explanation":"One sentence","topic":"${q.topic || ""}","source":"..."}}`;
  const res = await fetch("/api/anthropic", {
    method:"POST", headers:{"Content-Type":"application/json", ...(await authHeader())},
    body: JSON.stringify({ model:AI_MODEL, max_tokens:1400,
      system:"You are a meticulous fact-checker and educator. Return ONLY valid raw JSON, no markdown.",
      messages:[{ role:"user", content:[...(blocks||[]),{type:"text",text:prompt}] }] }),
  });
  if (!res.ok) { const e=await res.json().catch(()=>({})); throw new Error(e.error?.message||`Error ${res.status}`); }
  const parsed = JSON.parse(stripFences(await readStream(res)));
  const verdict = ["answer_correct","student_right","ambiguous"].includes(parsed.verdict) ? parsed.verdict : "answer_correct";
  return {
    verdict,
    explanation: String(parsed.explanation || "").trim().slice(0, 500),
    answerSource: typeof parsed.answerSource === "string" ? parsed.answerSource.trim().slice(0, 240) : "",
    replacement: verdict === "answer_correct" ? null : normalizeQuestion(parsed.replacement || {}, q),
  };
}

// Content gate (feature F, safety). Before generating, judge the uploaded
// material by intent, not surface keywords, so factual/educational content on
// any subject passes (Wikipedia, articles, studies, and sensitive-but-academic
// topics like anatomy, war or toxicology) and only genuine porn / CSAM / hate /
// weapon-instructions / junk is blocked. Runs on the same blocks (image / pdf /
// text) as generation, so it sees the real content. Errs toward allowing, and
// fails open on any error so an infra hiccup never blocks a real learner.
export async function gateContent({ blocks, uiLangName }) {
  const prompt = `You gate uploads for a study app. A student wants to make a quiz from this material. Judge it and return ONLY JSON: {"decision":"allow"|"block","category":"ok"|"explicit"|"harmful"|"nonstudy","reason":"a few words"}.

ALLOW anything a person could genuinely learn from or be tested on, on ANY subject and in ANY format: textbooks, notes, transcripts, slides, articles, encyclopedia or Wikipedia pages, news, research papers or abstracts, documentation, study guides. Informational content counts fully; it does NOT need to be a textbook. A factual article about space, a medical study, or a Wikipedia page IS valid study material. Sensitive topics treated factually (anatomy, reproduction, medicine, drugs, mental health, war, toxicology, weapons in a historical or scientific context, religion, politics) are ALLOWED.

BLOCK only when it is clearly NOT for learning:
- "explicit": pornographic or erotic content meant for arousal, or ANY sexual content involving minors.
- "harmful": gratuitous gore, content promoting hatred or harassment of a group, or operational step-by-step instructions to build weapons or seriously harm people.
- "nonstudy": no learnable substance, e.g. spam, advertising, a private personal conversation, a shopping list, pure gibberish, or too little text to quiz on.

When unsure, choose "allow". A real student's material must never be blocked for being informational or for factually covering a hard topic. Only "block" when it clearly matches a block category.${uiLangName ? ` Write "reason" in ${uiLangName}.` : ""}`;
  try {
    const res = await fetch("/api/anthropic", {
      method:"POST", headers:{"Content-Type":"application/json", ...(await authHeader())},
      body: JSON.stringify({ model:AI_MODEL, max_tokens:120,
        system:"You are a precise, fair content classifier for an educational app. Return ONLY valid raw JSON.",
        messages:[{ role:"user", content:[...(blocks||[]),{type:"text",text:prompt}] }] }),
    });
    if (!res.ok) return { decision:"allow", category:"ok" }; // fail open
    const parsed = JSON.parse(stripFences(await readStream(res)));
    const category = ["ok","explicit","harmful","nonstudy"].includes(parsed.category) ? parsed.category : "ok";
    const decision = (parsed.decision === "block" && category !== "ok") ? "block" : "allow";
    return { decision, category, reason: String(parsed.reason || "").slice(0, 120) };
  } catch { return { decision:"allow", category:"ok" }; } // fail open on any error
}
// Map a gate block category to the localized message shown to the learner.
export const gateMessage = (category, t) =>
  category === "explicit" ? t.gateExplicit :
  category === "harmful"  ? t.gateHarmful  :
  t.gateNonstudy;
