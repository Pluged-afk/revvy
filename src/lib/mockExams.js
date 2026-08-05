// Standardized mock exams — authentic structure + timing for real tests.
// Every section is multiple-choice, so mocks auto-score with no AI grading.
// The shape (sections with real counts, per-section minutes, and a generation
// instruction) is extensible — add an entry to MOCK_EXAMS to add a test.
//
//   scoreMode: "average" (ACT — composite is the mean of section scaled scores)
//              "sum"     (SAT/GRE — composite is the sum, e.g. 400–1600)
//   scaleMin/scaleMax: the scaled-score range for EACH section.

export const MOCK_EXAMS = [
  {
    id: "act",
    name: "ACT",
    blurb: "English · Math · Reading · Science",
    note: "4 sections · ~2h 55m · scored 1–36",
    scoreMode: "average",
    scaleMin: 1,
    scaleMax: 36,
    sections: [
      {
        id: "english", name: "English", count: 75, minutes: 45, options: 4,
        instr: "ACT English section. Test grammar, usage, punctuation, sentence structure, and rhetorical/organisation skills. Each question shows a short sentence or two with ONE clearly marked portion in [brackets]; the choices either fix or keep that portion. Include \"NO CHANGE\" as one option where appropriate. Embed the needed context in the stem.",
      },
      {
        id: "math", name: "Math", count: 60, minutes: 60, options: 5,
        instr: "ACT Math section. Cover pre-algebra, elementary and intermediate algebra, coordinate geometry, plane geometry, and basic trigonometry. Each question has FIVE answer choices. Keep problems self-contained and solvable without a calculator's advanced functions.",
      },
      {
        id: "reading", name: "Reading", count: 40, minutes: 35, options: 4,
        instr: "ACT Reading section. Reading comprehension. Put a SHORT passage (4–8 sentences) inside each question stem, then ask about main idea, a specific detail, an inference, or the meaning of a word in context. Four choices.",
      },
      {
        id: "science", name: "Science", count: 40, minutes: 35, options: 4,
        instr: "ACT Science section. Scientific reasoning. In the stem, present a brief experiment description, a small data table, or two conflicting hypotheses, then ask the student to interpret data, draw a conclusion, or compare viewpoints. Four choices. Describe any figure/table in words since images aren't shown.",
      },
    ],
  },
  {
    id: "sat",
    name: "SAT",
    blurb: "Reading & Writing · Math",
    note: "2 sections · ~2h 14m · scored 400–1600",
    scoreMode: "sum",
    scaleMin: 200,
    scaleMax: 800,
    sections: [
      {
        id: "rw", name: "Reading & Writing", count: 54, minutes: 64, options: 4,
        instr: "Digital SAT Reading and Writing. Each question presents a SHORT passage (1–3 sentences) in the stem, then asks ONE question testing: central ideas and details, command of evidence, words in context, text structure and purpose, cross-text connections, or Standard English conventions (grammar, punctuation, sentence boundaries, subject-verb agreement). Four choices.",
      },
      {
        id: "math", name: "Math", count: 44, minutes: 70, options: 4,
        instr: "Digital SAT Math. Cover Algebra (linear equations, inequalities, systems), Advanced Math (quadratics, exponentials, functions), Problem-Solving and Data Analysis (ratios, rates, percentages, probability, statistics), and Geometry and Trigonometry. Four choices. Self-contained and solvable by hand.",
      },
    ],
  },
  {
    id: "psat",
    name: "PSAT/NMSQT",
    blurb: "Reading & Writing · Math",
    note: "2 sections · ~2h 14m · scored 320–1520",
    scoreMode: "sum",
    scaleMin: 160,
    scaleMax: 760,
    sections: [
      {
        id: "rw", name: "Reading & Writing", count: 54, minutes: 64, options: 4,
        instr: "PSAT/NMSQT Reading and Writing (same style as the digital SAT). Each question presents a SHORT passage (1–3 sentences) in the stem, then asks ONE question on central ideas and details, command of evidence, words in context, text structure and purpose, or Standard English conventions (grammar, punctuation, agreement). Four choices.",
      },
      {
        id: "math", name: "Math", count: 44, minutes: 70, options: 4,
        instr: "PSAT/NMSQT Math (same style as the digital SAT). Cover linear algebra, functions and quadratics, ratios/percentages/statistics, and basic geometry. Four choices. Self-contained and solvable by hand.",
      },
    ],
  },
  {
    id: "gre",
    name: "GRE",
    blurb: "Verbal · Quantitative",
    note: "2 sections · ~1h 28m · scored 260–340",
    scoreMode: "sum",
    scaleMin: 130,
    scaleMax: 170,
    sections: [
      {
        id: "verbal", name: "Verbal Reasoning", count: 27, minutes: 41, options: 4,
        instr: "GRE Verbal Reasoning. Mix reading comprehension (a short passage in the stem plus a question on meaning, inference, or the author's purpose), single-blank text completion (a sentence with ONE blank — pick the best word), and questions on graduate-level vocabulary in context. Four choices, with challenging and close distractors.",
      },
      {
        id: "quant", name: "Quantitative Reasoning", count: 27, minutes: 47, options: 5,
        instr: "GRE Quantitative Reasoning. Problem-solving and data interpretation covering arithmetic, algebra, geometry, and statistics at an advanced level. Include some data-interpretation questions that describe a chart or table in words. Five choices.",
      },
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
export function compositeScore(scaledList, mode = "average") {
  if (!scaledList || !scaledList.length) return 0;
  const sum = scaledList.reduce((s, x) => s + x, 0);
  return mode === "sum" ? sum : Math.round(sum / scaledList.length);
}

// The best-possible composite (for the "out of N" display).
export function compositeMax(mock) {
  if (!mock) return 0;
  return mock.scoreMode === "sum" ? mock.scaleMax * mock.sections.length : mock.scaleMax;
}
