// A hand-written sampler quiz for signed-out visitors: a real, instant taste of
// the quiz loop with NO account and NO AI call (so it can never be abused for
// free generation, and it always loads instantly). Deliberately broad and
// beginner-friendly for a confident first win; the results screen then invites
// them to sign up and make quizzes from their own material. Kept factual,
// unambiguous, and free of em-dashes (house style). Correct answers sit at mixed
// indices so the set never reads as patterned.
export const DEMO_QUIZ = {
  title: "Quick Sample Quiz",
  subject: "General Knowledge",
  questions: [
    {
      question: "What is the main job of mitochondria inside a cell?",
      options: ["Storing genetic information", "Producing energy (ATP)", "Controlling what enters the cell", "Building proteins"],
      correct: 1,
      answer: "Producing energy (ATP)",
      explanation: "Mitochondria are the cell's powerhouses, producing ATP through cellular respiration.",
      topic: "Cell biology",
    },
    {
      question: "Which is the largest ocean on Earth?",
      options: ["Atlantic Ocean", "Indian Ocean", "Pacific Ocean", "Arctic Ocean"],
      correct: 2,
      answer: "Pacific Ocean",
      explanation: "The Pacific is the largest and deepest ocean, covering about a third of the planet's surface.",
      topic: "Geography",
    },
    {
      question: "In which year did World War II end?",
      options: ["1918", "1939", "1945", "1963"],
      correct: 2,
      answer: "1945",
      explanation: "World War II ended in 1945, after the surrender of Germany in May and Japan in September.",
      topic: "Modern history",
    },
    {
      question: "What is the chemical symbol for gold?",
      options: ["Au", "Gd", "Go", "Ag"],
      correct: 0,
      answer: "Au",
      explanation: "Gold's symbol Au comes from its Latin name, aurum. Ag is silver.",
      topic: "Chemistry",
    },
    {
      question: "Which planet is closest to the Sun?",
      options: ["Venus", "Earth", "Mars", "Mercury"],
      correct: 3,
      answer: "Mercury",
      explanation: "Mercury is the innermost planet, orbiting nearest to the Sun.",
      topic: "Astronomy",
    },
    {
      question: "Who wrote the play Romeo and Juliet?",
      options: ["Charles Dickens", "William Shakespeare", "Jane Austen", "Mark Twain"],
      correct: 1,
      answer: "William Shakespeare",
      explanation: "Shakespeare wrote Romeo and Juliet in the 1590s; it remains one of his best-known plays.",
      topic: "Literature",
    },
    {
      question: "What is 15% of 200?",
      options: ["15", "30", "45", "3"],
      correct: 1,
      answer: "30",
      explanation: "15% means 15 per 100, so 0.15 times 200 equals 30.",
      topic: "Percentages",
    },
  ],
};
