// Per-exam landing-page copy, the SINGLE source of truth shared by the
// /practice/:exam page (src/pages/ExamPage.jsx) and the build-time prerenderer
// (scripts/prerender.mjs). Because both read from here, the page's <title>,
// meta description, headings and FAQ can never drift from what a crawler sees
// in the prerendered HTML or in the structured data.
//
// Each entry targets the searches people actually type when they want to sit a
// practice test for that exam ("free SAT practice test", "GRE mock exam
// online", and so on), not just read about it. The specifics (sections, timing,
// scoring, question counts) are rendered live from lib/mockExams.js on the page
// itself, so nothing here needs to repeat a number that could fall out of date.
//
// House rules: no em dashes, no emoji, honest claims only. Full standardized
// mocks are a Pro feature across the whole site, so these pages say so.

// Order the roster is shown in (also the order MOCK_EXAMS is surfaced elsewhere).
export const EXAM_SEO_ORDER = ["sat", "act", "psat", "gre", "gmat", "lsat", "mcat", "ucat"];

export const EXAM_SEO = {
  sat: {
    guide: "how-to-study-for-the-sat",
    title: "Free Digital SAT Practice Test Online | Revyy",
    desc: "Sit a free, full-length digital SAT practice test online. Real Reading and Writing and Math sections, the 400 to 1600 scale, timed, with an explanation for every question.",
    h1: "Free digital SAT practice test",
    lede: "Practise the digital SAT the way it is actually sat: two adaptive sections, on a screen, against the clock, with a scaled score at the end instead of a raw percentage.",
    body: [
      "The digital SAT is section-adaptive, so a strong first module lifts the difficulty and the ceiling of your score in that section. That makes realistic, timed practice worth far more than loose review, because pacing and a steady start are half the test. Revyy builds SAT-style Reading and Writing and Math questions across the full difficulty range, marks them the moment you answer, and explains every one.",
      "You can also turn your own class notes into a timed paper, drill only the questions you got wrong as a fresh mini-quiz, and let every miss come back on a spaced schedule until it sticks. If you want the full experience, a complete SAT mock with the real sections and the 400 to 1600 scale is a Pro feature.",
    ],
    faqs: [
      { q: "Is this SAT practice test free?", a: "Yes. You can practise SAT-style Reading and Writing and Math questions and build timed papers for free, with an explanation on every question. A full-length standardized SAT mock with the scaled score is a Pro feature." },
      { q: "Does it match the digital SAT?", a: "It follows the current digital format: two sections, Reading and Writing and Math, four answer choices, and the 400 to 1600 score scale, with questions spanning the real difficulty range." },
      { q: "Can I practise SAT questions from my own notes?", a: "Yes. Upload a PDF, paste your notes or snap a photo of a page, and Revyy writes practice questions from your own material, which is useful for the content-heavy parts of your prep." },
      { q: "How should I use practice tests to raise my SAT score?", a: "Sit timed sections, review every wrong answer to find why you missed it, then re-test that exact idea a few days later. Revyy collects your misses and brings them back automatically. Our full SAT study guide walks through the plan." },
    ],
  },

  act: {
    guide: "how-to-study-for-the-act",
    title: "Free ACT Practice Test Online | Revyy",
    desc: "Take a free ACT practice test online: English, Math, Reading and Science, timed, scored 1 to 36, with an explanation for every question. Practise pacing before test day.",
    h1: "Free ACT practice test",
    lede: "The ACT is a speed test as much as a knowledge test. Practise the four sections under real timing so the clock stops being the thing that costs you marks.",
    body: [
      "English, Math, Reading and Science, each scored 1 to 36 and averaged into your composite, and the Science section is really about reading figures and experiments fast. Because the content rarely goes past what you have seen in school, most of the improvement comes from pacing and pattern recognition, which only timed practice builds. Revyy generates ACT-style questions for every section, marks them instantly and explains each answer.",
      "Practise from your own notes for free, re-drill the questions you missed as a quick mini-quiz, and let spaced review bring back your weak spots. A full ACT mock with all four sections and the 1 to 36 composite is a Pro feature.",
    ],
    faqs: [
      { q: "Is the ACT practice test free?", a: "Yes. Practising ACT-style questions and building timed papers from your own material is free, with an explanation on every question. A full standardized ACT mock with the composite score is a Pro feature." },
      { q: "Does it cover the ACT Science section?", a: "Yes. Revyy builds Science units around a figure, chart or experiment and asks you to interpret the data, which is exactly what the real section tests rather than recalled science facts." },
      { q: "How is the ACT scored here?", a: "The same way as the real test: each of English, Math, Reading and Science is scored 1 to 36 and your composite is their average." },
      { q: "How do I fix my ACT pacing?", a: "Practise full sections timed, learn to skip and come back rather than sinking time into one hard question, and review your misses. Our ACT study guide has the full pacing plan." },
    ],
  },

  psat: {
    guide: "how-to-study-for-the-psat",
    title: "Free PSAT/NMSQT Practice Test Online | Revyy",
    desc: "Practise the digital PSAT/NMSQT free: Reading and Writing and Math, timed, scored 320 to 1520. Doubles as digital SAT practice and National Merit prep.",
    h1: "Free PSAT/NMSQT practice test",
    lede: "The PSAT does two jobs: low-stakes practice for the digital SAT, and for juniors the qualifier for National Merit. Because it mirrors the SAT, practising for one prepares you for both.",
    body: [
      "The PSAT is now digital and looks and feels like the digital SAT: two section-adaptive sections, Reading and Writing and Math, scored 320 to 1520. If you are aiming at National Merit, your Selection Index from this test is what counts, so realistic timed practice is worth taking seriously. Revyy builds PSAT-style questions across the difficulty range, marks them instantly and explains each one.",
      "Practise from your own notes for free, re-drill your misses, and let spaced review keep your weak spots in rotation. Because the format is so close to the SAT, a full digital SAT mock, a Pro feature, maps almost directly onto the PSAT.",
    ],
    faqs: [
      { q: "Is the PSAT practice free?", a: "Yes. Practising PSAT-style Reading and Writing and Math questions and building timed papers is free, with an explanation on every question. A full standardized SAT-style mock with the scaled score is a Pro feature." },
      { q: "Does PSAT practice help with the SAT?", a: "Yes. The digital PSAT and digital SAT share the same sections, format and question style, so practice carries over almost completely between the two." },
      { q: "How is the PSAT scored?", a: "On a 320 to 1520 scale across two sections, a little below the SAT's ceiling. It is section-adaptive, like the SAT." },
      { q: "How do I prepare for National Merit?", a: "Sit timed sections, target the specific grammar rules and math topics you keep missing, and review your errors. Our PSAT study guide explains how to use the Selection Index to aim your prep." },
    ],
  },

  gre: {
    guide: "how-to-prepare-for-the-gre",
    title: "Free GRE Practice Test & Mock Exam Online | Revyy",
    desc: "Practise the GRE free online: Verbal and Quantitative Reasoning, timed, on the 130 to 170 scale, with an explanation for every question and vocabulary in context.",
    h1: "Free GRE practice test",
    lede: "The GRE tests reasoning more than curriculum, and rust is the usual enemy on quant. Practise both measures under timing so the format and the pace feel normal on the day.",
    body: [
      "Verbal Reasoning leans on vocabulary in context and reading dense passages efficiently, while Quantitative Reasoning covers arithmetic, algebra, geometry and data interpretation at a level most graduates last met years ago. Both are section-adaptive and timed, so the wording and the clock matter as much as the underlying maths. Revyy builds GRE-style Verbal and Quant questions, including data-interpretation items with a chart, and explains every answer.",
      "Treat vocabulary as daily spaced practice, rebuild your quant fundamentals with short targeted quizzes, and re-test every question you miss. A full GRE mock with both measures and the 130 to 170 scale is a Pro feature.",
    ],
    faqs: [
      { q: "Is the GRE practice test free?", a: "Yes. Practising GRE-style Verbal and Quantitative questions and building timed sets is free, with an explanation on every question. A full standardized GRE mock with the scaled score is a Pro feature." },
      { q: "Does it cover GRE vocabulary?", a: "Yes. Verbal practice includes graduate-level vocabulary in context and text completion, which is how the real test uses it, rather than isolated word lists." },
      { q: "How is the GRE scored here?", a: "Verbal and Quantitative Reasoning are each scored from 130 to 170, matching the real General Test." },
      { q: "How much can practice raise a GRE score?", a: "Targeted, timed practice moves GRE scores more than most people expect, because so much of the test is rust and pacing. Our GRE study guide lays out where to spend your hours." },
    ],
  },

  gmat: {
    guide: "how-to-study-for-the-gmat",
    title: "Free GMAT Focus Practice Test Online | Revyy",
    desc: "Practise the GMAT Focus Edition free: Quantitative, Verbal and Data Insights, timed, scored 205 to 805, with an explanation for every question. Drill Data Insights before test day.",
    h1: "Free GMAT Focus practice test",
    lede: "The GMAT Focus Edition rewards clear reasoning under time pressure. Practise all three sections, especially Data Insights, which is the one most people underestimate.",
    body: [
      "Three sections of 45 minutes each, Quantitative Reasoning, Verbal Reasoning and Data Insights, scored from 205 to 805, and every section is computer-adaptive. Data Insights, which now holds the old data sufficiency questions alongside table and graphics analysis, is where most people are underprepared. Revyy builds GMAT-style questions across all three sections, including data-interpretation items, and explains every answer.",
      "Drill the recurring quant and critical-reasoning patterns, give Data Insights a full share of your prep, and re-test every mistake. A full GMAT-style mock across the three sections is a Pro feature.",
    ],
    faqs: [
      { q: "Is the GMAT practice test free?", a: "Yes. Practising GMAT Focus-style Quant, Verbal and Data Insights questions is free, with an explanation on every question. A full standardized GMAT mock with the scaled score is a Pro feature." },
      { q: "Does it cover Data Insights?", a: "Yes. Revyy builds Data Insights questions: data sufficiency, table and graphics interpretation, two-part analysis and multi-source reasoning, which is the section most candidates neglect." },
      { q: "Is this the GMAT Focus Edition?", a: "Yes. It follows the current Focus Edition: three sections and the 205 to 805 scale, without the retired geometry and sentence-correction content." },
      { q: "How do I study for the GMAT efficiently?", a: "Learn the format cold, drill under timing, and turn every miss into a question you revisit later. Our GMAT study guide sets out a plan that fits around work or a course load." },
    ],
  },

  lsat: {
    guide: "how-to-study-for-the-lsat",
    title: "Free LSAT Practice Test Online | Revyy",
    desc: "Practise the LSAT free online: two Logical Reasoning sections and Reading Comprehension, timed, scored 120 to 180, with an explanation for every question. Logic Games are gone.",
    h1: "Free LSAT practice test",
    lede: "The LSAT is a reasoning test, not a knowledge test, and reasoning is a skill you can train. Now that Logic Games are gone, logical reasoning is where the marks are.",
    body: [
      "The scored test is two Logical Reasoning sections and one Reading Comprehension section, each 35 minutes, on the 120 to 180 scale. Every logical reasoning question asks you to do something precise with a short argument, find the assumption, the flaw, what strengthens or weakens it, so learning to name the question type on sight is most of the speed. Revyy builds LSAT-style logical reasoning and reading questions with close, sophisticated distractors, and explains every answer.",
      "Practise breaking arguments into conclusion and support, drill under timing, and review why each wrong answer drew you in. A full LSAT-style mock with both measures and the 120 to 180 scale is a Pro feature.",
    ],
    faqs: [
      { q: "Is the LSAT practice test free?", a: "Yes. Practising LSAT-style logical reasoning and reading comprehension questions is free, with an explanation on every question. A full standardized LSAT mock with the scaled score is a Pro feature." },
      { q: "Does the LSAT still have Logic Games?", a: "No. As of the August 2024 change the Analytical Reasoning section is gone. The scored test is now two Logical Reasoning sections and one Reading Comprehension section." },
      { q: "How is the LSAT scored?", a: "On the 120 to 180 scale, formed from your total raw score across the scored sections, matching the real test." },
      { q: "How do I improve at logical reasoning?", a: "Learn to recognise each question type instantly, practise timed, and study why the tempting wrong answers are wrong. Our LSAT study guide covers the full approach." },
    ],
  },

  mcat: {
    guide: "how-to-study-for-the-mcat",
    title: "Free MCAT Practice Test & Question Bank | Revyy",
    desc: "Practise the MCAT free: passage-based questions across all four sections including CARS, with an explanation for every answer. Build the reasoning and stamina the test rewards.",
    h1: "Free MCAT practice test",
    lede: "The MCAT is a marathon of applied reasoning, not recall. Practise passage-based questions across all four sections, and start CARS early, because there is no content to fall back on.",
    body: [
      "Four sections, Chemical and Physical Foundations, CARS, Biological and Biochemical Foundations, and Psychological, Social and Biological Foundations of Behavior, each scored 118 to 132 for a total from 472 to 528. Most questions hand you a passage and ask you to apply what you know, so content review alone is a trap. Revyy builds MCAT-style passage sets with figures and data across the sections, plus content-free CARS reading, and explains every answer.",
      "Mix practice passages into your content review from day one, keep a short daily dose of CARS, and re-test every miss on a spaced schedule so earlier subjects do not fade. Full-length MCAT-style practice is a Pro feature.",
    ],
    faqs: [
      { q: "Is the MCAT practice free?", a: "Yes. Practising MCAT-style passage questions across the sections is free, with an explanation on every answer. Full-length standardized practice is a Pro feature." },
      { q: "Does it include CARS practice?", a: "Yes. Revyy builds Critical Analysis and Reasoning Skills passages that use no outside content, exactly like the real section, so you can build the reading and reasoning it demands." },
      { q: "How is the MCAT scored?", a: "Each of the four sections is scored 118 to 132, combining into a total from 472 to 528, centred around 500, as on the real exam." },
      { q: "When should I start MCAT practice?", a: "Early, and alongside content review rather than after it, since the test rewards applying ideas to unfamiliar passages. Our MCAT study guide explains how to balance content and practice." },
    ],
  },

  ucat: {
    guide: "how-to-study-for-the-ucat",
    title: "Free UCAT Practice Test Online | Revyy",
    desc: "Practise the UCAT free online: Verbal Reasoning, Decision Making, Quantitative Reasoning and Situational Judgement, timed, with an explanation for every question. Speed is the whole game.",
    h1: "Free UCAT practice test",
    lede: "The UCAT tests aptitude under brutal time limits, seconds per question, not minutes. Practising against the clock, and learning when to guess and move on, is the whole game.",
    body: [
      "Five subtests: Verbal Reasoning, Decision Making, Quantitative Reasoning, Abstract Reasoning and Situational Judgement. The four cognitive subtests are each scored 300 to 900, and Situational Judgement is reported in bands. Almost nobody has enough time, so preparation is really about building speed and the discipline to flag a slow question and come back only if time allows. Revyy builds fast UCAT-style questions across the subtests and explains every answer.",
      "Drill under strict timing, learn the recurring logic and maths patterns until they are automatic, and review your pace as well as your accuracy. A timed UCAT-style practice set is a great way to train the flag-and-move habit the test rewards.",
    ],
    faqs: [
      { q: "Is the UCAT practice test free?", a: "Yes. Practising UCAT-style questions across the subtests is free, with an explanation on every question, so you can build speed without spending anything." },
      { q: "Which UCAT subtests does it cover?", a: "Verbal Reasoning, Decision Making, Quantitative Reasoning and Situational Judgement, in the fast, tightly timed style the real subtests use." },
      { q: "How is the UCAT scored?", a: "The four cognitive subtests are each scored 300 to 900, and Situational Judgement is reported in bands from 1 to 4, matching the real test." },
      { q: "How do I get faster at the UCAT?", a: "Practise everything timed, learn the on-screen tools cold, and drill the patterns that slow you down. Our UCAT study guide explains the flag-and-move approach in detail." },
    ],
  },
};
