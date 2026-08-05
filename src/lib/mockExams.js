// Standardized mock exams — authentic structure + timing for real tests.
// Every section is multiple-choice, so mocks auto-score with no AI grading.
// Add an entry to MOCK_EXAMS to add a test.
//
//   scoreMode:
//     "average"     — composite is the mean of the section scaled scores (ACT, LSAT)
//     "sum"         — composite is their sum (SAT/PSAT/GRE/MCAT/UCAT)
//     "scaledTotal" — composite maps overall performance onto [totalMin,totalMax]
//                     (GMAT — its total isn't a simple sum of section scores)
//   scaleMin/scaleMax: the scaled-score range for EACH section.

export const MOCK_EXAMS = [
  {
    id: "act", name: "ACT", blurb: "English · Math · Reading · Science",
    note: "4 sections · ~2h 55m · scored 1–36",
    scoreMode: "average", scaleMin: 1, scaleMax: 36,
    sections: [
      { id: "english", name: "English", count: 75, minutes: 45, options: 4,
        instr: "ACT English section. Test grammar, usage, punctuation, sentence structure, and rhetorical/organisation skills. Each question shows a short sentence or two with ONE clearly marked portion in [brackets]; the choices either fix or keep that portion. Include \"NO CHANGE\" as one option where appropriate. Embed the needed context in the stem." },
      { id: "math", name: "Math", count: 60, minutes: 60, options: 5,
        instr: "ACT Math section. Cover pre-algebra, elementary and intermediate algebra, coordinate geometry, plane geometry, and basic trigonometry. Each question has FIVE answer choices. Keep problems self-contained and solvable without a calculator's advanced functions." },
      { id: "reading", name: "Reading", count: 40, minutes: 35, options: 4,
        instr: "ACT Reading section. Reading comprehension. Put a SHORT passage (4–8 sentences) inside each question stem, then ask about main idea, a specific detail, an inference, or the meaning of a word in context. Four choices." },
      { id: "science", name: "Science", count: 40, minutes: 35, options: 4,
        instr: "ACT Science section. Scientific reasoning. In the stem, present a brief experiment description, a small data table, or two conflicting hypotheses, then ask the student to interpret data, draw a conclusion, or compare viewpoints. Four choices. Describe any figure/table in words since images aren't shown." },
    ],
  },
  {
    id: "sat", name: "SAT", blurb: "Reading & Writing · Math",
    note: "2 sections · ~2h 14m · scored 400–1600",
    scoreMode: "sum", scaleMin: 200, scaleMax: 800,
    sections: [
      { id: "rw", name: "Reading & Writing", count: 54, minutes: 64, options: 4,
        instr: "Digital SAT Reading and Writing. Each question presents a SHORT passage (1–3 sentences) in the stem, then asks ONE question testing: central ideas and details, command of evidence, words in context, text structure and purpose, cross-text connections, or Standard English conventions (grammar, punctuation, sentence boundaries, subject-verb agreement). Four choices." },
      { id: "math", name: "Math", count: 44, minutes: 70, options: 4,
        instr: "Digital SAT Math. Cover Algebra (linear equations, inequalities, systems), Advanced Math (quadratics, exponentials, functions), Problem-Solving and Data Analysis (ratios, rates, percentages, probability, statistics), and Geometry and Trigonometry. Four choices. Self-contained and solvable by hand." },
    ],
  },
  {
    id: "psat", name: "PSAT/NMSQT", blurb: "Reading & Writing · Math",
    note: "2 sections · ~2h 14m · scored 320–1520",
    scoreMode: "sum", scaleMin: 160, scaleMax: 760,
    sections: [
      { id: "rw", name: "Reading & Writing", count: 54, minutes: 64, options: 4,
        instr: "PSAT/NMSQT Reading and Writing (same style as the digital SAT). Each question presents a SHORT passage (1–3 sentences) in the stem, then asks ONE question on central ideas and details, command of evidence, words in context, text structure and purpose, or Standard English conventions (grammar, punctuation, agreement). Four choices." },
      { id: "math", name: "Math", count: 44, minutes: 70, options: 4,
        instr: "PSAT/NMSQT Math (same style as the digital SAT). Cover linear algebra, functions and quadratics, ratios/percentages/statistics, and basic geometry. Four choices. Self-contained and solvable by hand." },
    ],
  },
  {
    id: "gre", name: "GRE", blurb: "Verbal · Quantitative",
    note: "2 sections · ~1h 28m · scored 260–340",
    scoreMode: "sum", scaleMin: 130, scaleMax: 170,
    sections: [
      { id: "verbal", name: "Verbal Reasoning", count: 27, minutes: 41, options: 4,
        instr: "GRE Verbal Reasoning. Mix reading comprehension (a short passage in the stem plus a question on meaning, inference, or the author's purpose), single-blank text completion (a sentence with ONE blank — pick the best word), and questions on graduate-level vocabulary in context. Four choices, with challenging and close distractors." },
      { id: "quant", name: "Quantitative Reasoning", count: 27, minutes: 47, options: 5,
        instr: "GRE Quantitative Reasoning. Problem-solving and data interpretation covering arithmetic, algebra, geometry, and statistics at an advanced level. Include some data-interpretation questions that describe a chart or table in words. Five choices." },
    ],
  },
  {
    id: "ucat", name: "UCAT", blurb: "Verbal · Decision Making · Quantitative",
    note: "3 timed sections · ~1h 24m · scored 900–2700",
    scoreMode: "sum", scaleMin: 300, scaleMax: 900,
    sections: [
      { id: "vr", name: "Verbal Reasoning", count: 44, minutes: 21, options: 4,
        instr: "UCAT Verbal Reasoning. Present a SHORT passage (3–5 sentences) in the stem, then either a \"based on the passage, is this statement True, False, or Can't tell\" question or a comprehension question about the passage. Four choices. These are answered very fast (~28 seconds each), so keep them tight." },
      { id: "dm", name: "Decision Making", count: 36, minutes: 37, options: 4,
        instr: "UCAT Decision Making. Logical puzzles: syllogisms, Venn-diagram/set reasoning, probabilistic reasoning, judging the strength of a short argument, recognising unstated assumptions, or interpreting a small data table. Describe any diagram or table in words. Four choices." },
      { id: "qr", name: "Quantitative Reasoning", count: 36, minutes: 26, options: 5,
        instr: "UCAT Quantitative Reasoning. Numerical problem-solving from a described chart, table, or scenario — percentages, ratios, rates, averages, speed/distance, and unit conversions. Describe any table or figure in words. Five choices." },
    ],
  },
  {
    id: "lsat", name: "LSAT", blurb: "Logical Reasoning ×2 · Reading Comp",
    note: "3 sections · ~1h 45m · scored 120–180",
    scoreMode: "average", scaleMin: 120, scaleMax: 180,
    sections: [
      { id: "lr1", name: "Logical Reasoning I", count: 25, minutes: 35, options: 5,
        instr: "LSAT Logical Reasoning. A short argument or scenario (2–4 sentences) in the stem, then a question: identify the necessary assumption, strengthen or weaken the argument, find the logical flaw, draw a supported conclusion, or identify the principle at work. Five choices with close, sophisticated distractors." },
      { id: "lr2", name: "Logical Reasoning II", count: 25, minutes: 35, options: 5,
        instr: "LSAT Logical Reasoning. A short argument or scenario (2–4 sentences) in the stem, then a question: identify the assumption, strengthen/weaken, find the flaw, infer what must be true, or match the reasoning pattern. Five choices with subtle distractors. Vary the question types from the first Logical Reasoning section." },
      { id: "rc", name: "Reading Comprehension", count: 27, minutes: 35, options: 5,
        instr: "LSAT Reading Comprehension. Present a dense academic passage (6–10 sentences) in the stem, then a question about the main point, the author's attitude, a specific detail, an inference, or the function of part of the passage. Five choices." },
    ],
  },
  {
    id: "gmat", name: "GMAT", blurb: "Quant · Verbal · Data Insights",
    note: "3 sections · ~2h 15m · scored 205–805",
    scoreMode: "scaledTotal", scaleMin: 60, scaleMax: 90, totalMin: 205, totalMax: 805, totalStep: 10,
    sections: [
      { id: "quant", name: "Quantitative Reasoning", count: 21, minutes: 45, options: 5,
        instr: "GMAT Focus Quantitative Reasoning. Problem-solving in arithmetic, algebra, and word problems (no geometry). Self-contained, no calculator needed. Five choices." },
      { id: "verbal", name: "Verbal Reasoning", count: 23, minutes: 45, options: 5,
        instr: "GMAT Focus Verbal Reasoning. Critical reasoning (evaluate, strengthen, or weaken a short argument) and reading comprehension (a short passage plus a question). Five choices with close distractors." },
      { id: "di", name: "Data Insights", count: 20, minutes: 45, options: 5,
        instr: "GMAT Focus Data Insights. Data interpretation from a described table or graph, multi-source reasoning, and two-part analysis. Describe any table or graph fully in words. Five choices." },
    ],
  },
  {
    id: "mcat", name: "MCAT", blurb: "Chem/Phys · CARS · Bio · Psych/Soc",
    note: "4 sections · ~6h 15m · scored 472–528",
    scoreMode: "sum", scaleMin: 118, scaleMax: 132,
    sections: [
      { id: "cp", name: "Chem/Phys Foundations", count: 59, minutes: 95, options: 4,
        instr: "MCAT Chemical and Physical Foundations of Biological Systems. General chemistry, physics, organic chemistry, and biochemistry as applied to living systems. Include a short experiment or passage context described in words where relevant. Four choices." },
      { id: "cars", name: "CARS", count: 53, minutes: 90, options: 4,
        instr: "MCAT Critical Analysis and Reasoning Skills. Present a dense humanities or social-science passage (6–10 sentences) in the stem, then a question testing comprehension, reasoning within the text, or reasoning beyond the text. Four choices. No outside knowledge required." },
      { id: "bb", name: "Bio/Biochem Foundations", count: 59, minutes: 95, options: 4,
        instr: "MCAT Biological and Biochemical Foundations of Living Systems. Biology, biochemistry, and organic/general chemistry in a biological context, often with a short passage or experiment described in words. Four choices." },
      { id: "ps", name: "Psych/Soc Foundations", count: 59, minutes: 95, options: 4,
        instr: "MCAT Psychological, Social, and Biological Foundations of Behavior. Psychology, sociology, and the biology of behavior, often passage-based (described in words). Four choices." },
    ],
  },
];

export function getMock(id) {
  return MOCK_EXAMS.find((m) => m.id === id) || null;
}
export function mockTotalMinutes(mock) {
  return (mock?.sections || []).reduce((s, sec) => s + sec.minutes, 0);
}
export function mockTotalQuestions(mock) {
  return (mock?.sections || []).reduce((s, sec) => s + sec.count, 0);
}

// Approximate raw → scaled conversion. Real tests use per-section lookup
// tables; a clamped linear map is a reasonable practice-grade estimate.
export function scaledScore(raw, count, min = 1, max = 36) {
  if (!count) return min;
  const s = min + (raw / count) * (max - min);
  return Math.max(min, Math.min(max, Math.round(s)));
}

// Composite from the section scaled scores, per the exam's scoring mode.
export function compositeScore(scaledList, mock) {
  if (!scaledList || !scaledList.length) return 0;
  const mode = mock?.scoreMode || "average";
  const sum = scaledList.reduce((s, x) => s + x, 0);
  if (mode === "sum") return sum;
  if (mode === "scaledTotal") {
    const { scaleMin, scaleMax, totalMin, totalMax, totalStep = 1 } = mock;
    const frac = scaledList.reduce((s, x) => s + (x - scaleMin) / (scaleMax - scaleMin), 0) / scaledList.length;
    const raw = totalMin + frac * (totalMax - totalMin);
    if (totalStep === 10) return Math.round((raw - 5) / 10) * 10 + 5; // ends in 5 (GMAT)
    return Math.round(raw / totalStep) * totalStep;
  }
  return Math.round(sum / scaledList.length); // average
}

// The best-possible composite (for the "out of N" display).
export function compositeMax(mock) {
  if (!mock) return 0;
  if (mock.scoreMode === "sum") return mock.scaleMax * mock.sections.length;
  if (mock.scoreMode === "scaledTotal") return mock.totalMax;
  return mock.scaleMax; // average
}
