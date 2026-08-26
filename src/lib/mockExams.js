// Standardized mock exams matching the REAL current tests (Aug 2026): authentic
// section counts, per-section timing, answer-choice counts, question/passage
// formats, and scoring. Every question is multiple-choice so mocks auto-score
// with no AI grading.
//
// Section fields:
//   count, minutes, options   authentic length, time, and answer-choice count
//   format   "standalone" | "passage" | "english"  (how it is generated + shown)
//   passageSize   questions per passage (passage / english formats)
//   group, groupName   sections scored together as one measure (defaults to the section)
//   noComposite   scored + shown, but NOT part of the composite (e.g. ACT Science STEM)
//   band   scored as a band, not a scaled score (UCAT Situational Judgement)
//
// scoreMode, how the composite is formed from the per-measure scaled scores:
//   "average"      mean of the measure scaled scores (ACT)
//   "sum"          their sum (SAT / PSAT / GRE / UCAT / MCAT)
//   "scaledTotal"  overall performance mapped onto [totalMin,totalMax] (GMAT)
//   "rawTotal"     total raw across all scored sections mapped to [scaleMin,scaleMax] (LSAT)
// None of these tests has a pass/fail line; `goodScore` is a context target only.

export const MOCK_EXAMS = [
  {
    id: "act", name: "ACT", blurb: "English · Math · Reading · Science",
    note: "Enhanced ACT · 4 sections · scored 1-36", scoreMode: "average", scaleMin: 1, scaleMax: 36, goodScore: 24,
    sections: [
      { id: "english", name: "English", count: 50, minutes: 35, options: 4, format: "english", passageSize: 10,
        instr: "Enhanced ACT English. Provide ONE authentic passage (a short essay or narrative) with specific portions marked for revision by wrapping them in <u>...</u> tags, in natural reading order. Write EXACTLY {N} underlined portions and EXACTLY {N} questions IN THE SAME ORDER (question i is about the i-th underlined portion). Each question's first option is 'NO CHANGE' and the others revise the underlined portion, testing grammar, usage, punctuation, sentence structure, word choice, transitions, and rhetorical/organisation skills. Genuinely ACT-hard: subtle errors, close distractors, and several where 'NO CHANGE' is correct." },
      { id: "math", name: "Math", count: 45, minutes: 50, options: 4, format: "standalone",
        instr: "Enhanced ACT Math. Standalone multiple-choice questions with FOUR answer choices, covering pre-algebra, elementary and intermediate algebra, coordinate geometry, plane geometry, and trigonometry. Genuinely challenging ACT-level, multi-step problems (not trivial recall). Include an accurate inline <svg> figure whenever a question needs a diagram, coordinate graph, or number line." },
      { id: "reading", name: "Reading", count: 36, minutes: 40, options: 4, format: "passage", passageSize: 9,
        instr: "ACT Reading. Provide ONE authentic passage (~600-800 words: literary narrative / prose fiction, social science, humanities, or natural science) and {N} questions on it, covering main idea, specific detail, inference, vocabulary-in-context, author's purpose/voice, and comparison. Close distractors that require careful reading of THIS passage, not outside knowledge." },
      { id: "science", name: "Science", count: 40, minutes: 40, options: 4, format: "passage", passageSize: 8, noComposite: true,
        instr: "ACT Science. Provide ONE authentic science unit (a data-representation set, a research-summaries experiment, OR a conflicting-viewpoints set) AND an inline <svg> figure (graph, chart, table, or diagram) that the questions genuinely depend on. Then {N} questions on interpreting the figure/data, experimental design, and drawing conclusions." },
    ],
  },
  {
    id: "sat", name: "SAT", blurb: "Reading & Writing · Math",
    note: "Digital SAT · 2 sections · scored 400-1600", scoreMode: "sum", scaleMin: 200, scaleMax: 800, goodScore: 1200,
    sections: [
      { id: "rw", name: "Reading & Writing", count: 54, minutes: 64, options: 4, format: "standalone",
        instr: "Digital SAT Reading and Writing. Each question is self-contained: a SHORT passage (1-3 sentences, or a brief poem/notes excerpt) then ONE question testing central ideas and details, command of evidence (textual or quantitative), words in context, text structure and purpose, cross-text connections, or Standard English conventions (grammar, punctuation, sentence boundaries, agreement). FOUR choices. Span the full digital-SAT difficulty range." },
      { id: "math", name: "Math", count: 44, minutes: 70, options: 4, format: "standalone",
        instr: "Digital SAT Math. FOUR-choice questions covering Algebra, Advanced Math (quadratics, exponentials, functions), Problem-Solving and Data Analysis (ratios, rates, percentages, probability, statistics), and Geometry and Trigonometry. Self-contained and solvable by hand; include an inline <svg> when a figure is needed. Span the full difficulty range." },
    ],
  },
  {
    id: "psat", name: "PSAT/NMSQT", blurb: "Reading & Writing · Math",
    note: "Digital PSAT · 2 sections · scored 320-1520", scoreMode: "sum", scaleMin: 160, scaleMax: 760, goodScore: 1100,
    sections: [
      { id: "rw", name: "Reading & Writing", count: 54, minutes: 64, options: 4, format: "standalone",
        instr: "Digital PSAT/NMSQT Reading and Writing (same style as the digital SAT). Each question is self-contained: a SHORT passage (1-3 sentences) then ONE question on central ideas and details, command of evidence, words in context, text structure and purpose, or Standard English conventions. FOUR choices." },
      { id: "math", name: "Math", count: 44, minutes: 70, options: 4, format: "standalone",
        instr: "Digital PSAT/NMSQT Math (same style as the digital SAT). Algebra, functions and quadratics, ratios/percentages/statistics, and geometry/trigonometry. FOUR choices, self-contained, solvable by hand; inline <svg> when a figure is needed." },
    ],
  },
  {
    id: "gre", name: "GRE", blurb: "Verbal · Quantitative",
    note: "GRE General · 2 measures · scored 260-340", scoreMode: "sum", scaleMin: 130, scaleMax: 170, goodScore: 320,
    sections: [
      { id: "verbal", name: "Verbal Reasoning", count: 27, minutes: 41, options: 5, format: "standalone",
        instr: "GRE Verbal Reasoning. Mix reading comprehension (a short passage in the stem + a question on meaning, inference, or the author's purpose), single-blank text completion (a sentence with one blank, pick the best word), and questions on graduate-level vocabulary in context. FIVE choices with challenging, close distractors." },
      { id: "quant", name: "Quantitative Reasoning", count: 27, minutes: 47, options: 5, format: "standalone",
        instr: "GRE Quantitative Reasoning. Problem-solving and data interpretation across arithmetic, algebra, geometry, and statistics at an advanced level, plus some quantitative-comparison questions (compare Quantity A and Quantity B; options are 'A is greater / B is greater / equal / cannot be determined'). Include data-interpretation questions with an inline <svg> chart. FIVE choices." },
    ],
  },
  {
    id: "ucat", name: "UCAT", blurb: "VR · DM · QR · SJT",
    note: "UCAT · 4 sections · cognitive 900-2700 + SJT band", scoreMode: "sum", scaleMin: 300, scaleMax: 900, goodScore: 2500,
    sections: [
      { id: "vr", name: "Verbal Reasoning", count: 44, minutes: 22, options: 4, format: "passage", passageSize: 8,
        instr: "UCAT Verbal Reasoning. Provide ONE passage (~200-350 words) and {N} fast questions on it: some 'based on the passage, is this statement True / False / Can't tell' items and some direct comprehension questions. FOUR choices. Keep them tight, they are answered in about 28 seconds each." },
      { id: "dm", name: "Decision Making", count: 35, minutes: 37, options: 4, format: "standalone",
        instr: "UCAT Decision Making. Standalone logic puzzles: syllogisms, Venn/set reasoning, probabilistic reasoning, judging the strength of a short argument, recognising unstated assumptions, or interpreting a small data table (describe it in words or an inline <svg>). FOUR choices." },
      { id: "qr", name: "Quantitative Reasoning", count: 36, minutes: 26, options: 5, format: "standalone",
        instr: "UCAT Quantitative Reasoning. Numerical problem-solving from a described scenario, chart, or table (use an inline <svg> for charts): percentages, ratios, rates, averages, speed/distance, unit conversions. FIVE choices." },
      { id: "sjt", name: "Situational Judgement", count: 69, minutes: 26, options: 4, format: "standalone", noComposite: true, band: true,
        instr: "UCAT Situational Judgement. Present a realistic scenario a medical or dental student/trainee faces, then ask how APPROPRIATE (or how IMPORTANT) a given response or consideration is. Options are 'Very appropriate / Appropriate, but not ideal / Inappropriate, but not awful / Very inappropriate' (or the importance equivalent). FOUR choices. Judge professionalism, integrity, teamwork, and patient safety." },
    ],
  },
  {
    id: "lsat", name: "LSAT", blurb: "Logical Reasoning ×2 · Reading Comp",
    note: "LSAT · 3 scored sections · scored 120-180", scoreMode: "rawTotal", scaleMin: 120, scaleMax: 180, goodScore: 160,
    sections: [
      { id: "lr1", name: "Logical Reasoning I", count: 25, minutes: 35, options: 5, format: "standalone",
        instr: "LSAT Logical Reasoning. A short argument or scenario (2-4 sentences) in the stem, then a question: identify the necessary assumption, strengthen or weaken the argument, find the logical flaw, draw a supported conclusion, resolve a paradox, or identify the principle. FIVE choices with close, sophisticated distractors." },
      { id: "lr2", name: "Logical Reasoning II", count: 25, minutes: 35, options: 5, format: "standalone",
        instr: "LSAT Logical Reasoning. A short argument or scenario (2-4 sentences) then a question: assumption, strengthen/weaken, flaw, must-be-true, parallel reasoning, or method of reasoning. FIVE choices with subtle distractors. Vary the question types from the first Logical Reasoning section." },
      { id: "rc", name: "Reading Comprehension", count: 27, minutes: 35, options: 5, format: "passage", passageSize: 7,
        instr: "LSAT Reading Comprehension. Provide ONE dense, academic passage (~450-550 words: law, science, humanities, or social science) and {N} questions: main point, author's attitude/tone, a specific detail, an inference, the function of part of the passage, and application. FIVE choices." },
    ],
  },
  {
    id: "gmat", name: "GMAT", blurb: "Quant · Verbal · Data Insights",
    note: "GMAT Focus · 3 sections · scored 205-805", scoreMode: "scaledTotal", scaleMin: 60, scaleMax: 90, totalMin: 205, totalMax: 805, totalStep: 10, goodScore: 645,
    sections: [
      { id: "quant", name: "Quantitative Reasoning", count: 21, minutes: 45, options: 5, format: "standalone",
        instr: "GMAT Focus Quantitative Reasoning. Problem-solving in arithmetic, algebra, and word problems (no geometry). Self-contained, no calculator needed. FIVE choices with close numeric distractors." },
      { id: "verbal", name: "Verbal Reasoning", count: 23, minutes: 45, options: 5, format: "standalone",
        instr: "GMAT Focus Verbal Reasoning. Critical reasoning (evaluate, strengthen, or weaken a short argument) and reading comprehension (a short passage in the stem + a question). FIVE choices with close distractors." },
      { id: "di", name: "Data Insights", count: 20, minutes: 45, options: 5, format: "standalone",
        instr: "GMAT Focus Data Insights. Data interpretation from a described table or graph (use an inline <svg>), multi-source reasoning, two-part analysis, and data sufficiency. FIVE choices." },
    ],
  },
  {
    id: "mcat", name: "MCAT", blurb: "Chem/Phys · CARS · Bio · Psych/Soc",
    note: "MCAT · 4 sections · scored 472-528", scoreMode: "sum", scaleMin: 118, scaleMax: 132, goodScore: 511,
    sections: [
      { id: "cp", name: "Chem/Phys", count: 59, minutes: 95, options: 4, format: "passage", passageSize: 12,
        instr: "MCAT Chemical and Physical Foundations of Biological Systems. Provide ONE research/experiment passage (general chemistry, physics, organic chemistry, and biochemistry applied to living systems) with an inline <svg> figure or data table where relevant, then {N} questions that reason from the passage plus foundational science. FOUR choices." },
      { id: "cars", name: "CARS", count: 53, minutes: 90, options: 4, format: "passage", passageSize: 11,
        instr: "MCAT Critical Analysis and Reasoning Skills. Provide ONE dense humanities or social-science passage (~500-600 words) and {N} questions testing comprehension, reasoning within the text, and reasoning beyond the text. FOUR choices. No outside knowledge required, everything comes from the passage." },
      { id: "bb", name: "Bio/Biochem", count: 59, minutes: 95, options: 4, format: "passage", passageSize: 12,
        instr: "MCAT Biological and Biochemical Foundations of Living Systems. Provide ONE experiment/research passage (biology, biochemistry, and organic/general chemistry in a biological context) with an inline <svg> figure or data where relevant, then {N} questions reasoning from it plus foundational science. FOUR choices." },
      { id: "ps", name: "Psych/Soc", count: 59, minutes: 95, options: 4, format: "passage", passageSize: 12,
        instr: "MCAT Psychological, Social, and Biological Foundations of Behavior. Provide ONE study/passage (psychology, sociology, and the biology of behavior) with a data figure (inline <svg>) where relevant, then {N} questions reasoning from it plus foundational concepts. FOUR choices." },
    ],
  },
];

export function getMock(id) { return MOCK_EXAMS.find((m) => m.id === id) || null; }
export function mockTotalMinutes(mock) { return (mock?.sections || []).reduce((s, sec) => s + sec.minutes, 0); }
export function mockTotalQuestions(mock) { return (mock?.sections || []).reduce((s, sec) => s + sec.count, 0); }

// Approximate raw -> scaled conversion. Real tests use per-section lookup
// tables; a clamped linear map is a reasonable practice-grade estimate.
export function scaledScore(raw, count, min = 1, max = 36) {
  if (!count) return min;
  const s = min + (raw / count) * (max - min);
  return Math.max(min, Math.min(max, Math.round(s)));
}

// UCAT Situational Judgement band from a raw fraction (Band 1 best ... Band 4).
export function sjtBand(raw, count) {
  const p = count ? raw / count : 0;
  return p >= 0.76 ? 1 : p >= 0.55 ? 2 : p >= 0.4 ? 3 : 4;
}

function compositeFrom(rows, mock) {
  if (!rows.length) return 0;
  const mode = mock.scoreMode || "average";
  const scaleds = rows.map((r) => r.scaled);
  const sum = scaleds.reduce((s, x) => s + x, 0);
  if (mode === "sum") return sum;
  if (mode === "rawTotal") {
    const tr = rows.reduce((s, r) => s + r.raw, 0), tc = rows.reduce((s, r) => s + r.count, 0);
    return scaledScore(tr, tc, mock.scaleMin, mock.scaleMax);
  }
  if (mode === "scaledTotal") {
    const { scaleMin, scaleMax, totalMin, totalMax, totalStep = 1 } = mock;
    const frac = rows.reduce((s, r) => s + (r.scaled - scaleMin) / (scaleMax - scaleMin), 0) / rows.length;
    const raw = totalMin + frac * (totalMax - totalMin);
    if (totalStep === 10) return Math.round((raw - 5) / 10) * 10 + 5; // ends in 5 (GMAT)
    return Math.round(raw / totalStep) * totalStep;
  }
  return Math.round(sum / scaleds.length); // average
}

// The best-possible composite (for the "out of N" display).
export function compositeMax(mock) {
  if (!mock) return 0;
  const groups = new Set((mock.sections || []).filter((s) => !s.noComposite && !s.band).map((s) => s.group || s.id));
  if (mock.scoreMode === "sum") return mock.scaleMax * groups.size;
  if (mock.scoreMode === "scaledTotal") return mock.totalMax;
  return mock.scaleMax; // average, rawTotal
}

// Full scored result for a finished mock. `results` is aligned to mock.sections:
// each entry is { raw, count } (or null/undefined for a section not reached).
// Returns the per-measure rows, any non-composite extras (ACT Science STEM,
// UCAT SJT band), the composite, its max, and the context target.
export function scoreMock(mock, results) {
  const secs = mock?.sections || [];
  const byGroup = new Map();
  secs.forEach((sec, i) => {
    const r = results?.[i];
    if (!r || !r.count) return;
    const key = sec.group || sec.id;
    const g = byGroup.get(key) || { name: sec.groupName || sec.name, raw: 0, count: 0, noComposite: !!sec.noComposite, band: !!sec.band };
    g.raw += r.raw; g.count += r.count;
    byGroup.set(key, g);
  });
  const rows = [], extras = [];
  for (const g of byGroup.values()) {
    if (g.band) { extras.push({ name: g.name, raw: g.raw, count: g.count, band: sjtBand(g.raw, g.count) }); continue; }
    const scaled = scaledScore(g.raw, g.count, mock.scaleMin, mock.scaleMax);
    if (g.noComposite) extras.push({ name: g.name, raw: g.raw, count: g.count, scaled });
    else rows.push({ name: g.name, raw: g.raw, count: g.count, scaled });
  }
  return { rows, extras, composite: compositeFrom(rows, mock), compositeMax: compositeMax(mock), goodScore: mock.goodScore };
}
