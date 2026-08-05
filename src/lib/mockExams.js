// Standardized mock exams — authentic structure + timing for real tests.
// ACT first; the shape (sections with real counts, per-section minutes, and a
// generation instruction) is extensible to SAT / GCSE / AP / IB later.
// Every section is multiple-choice, so mocks auto-score with no AI grading.

export const MOCK_EXAMS = [
  {
    id: "act",
    name: "ACT",
    blurb: "English · Math · Reading · Science",
    scaleMin: 1,
    scaleMax: 36,
    note: "Full practice test · ~2h 55m · scored 1–36",
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

// Approximate raw → scaled conversion. Real ACT uses per-section lookup tables;
// a clamped linear map is a reasonable practice-grade estimate.
export function scaledScore(raw, count, min = 1, max = 36) {
  if (!count) return min;
  const s = min + (raw / count) * (max - min);
  return Math.max(min, Math.min(max, Math.round(s)));
}

// Composite = rounded average of the section scaled scores (how the ACT works).
export function compositeScore(scaledList) {
  if (!scaledList || !scaledList.length) return 0;
  return Math.round(scaledList.reduce((s, x) => s + x, 0) / scaledList.length);
}
