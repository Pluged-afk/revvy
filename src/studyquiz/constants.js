// Data + theme tokens for StudyQuiz, split out so the component file is logic.

// MCQ choice letters
export const LETTERS = ["A", "B", "C", "D", "E", "F"];

// default bindings for the opt-in MCQ keyboard controls
export const DEFAULT_KEYBINDS = { o1: "1", o2: "2", o3: "3", o4: "4", next: "Enter" };

// weekly league tiers (display only; mirrors the server's order)
export const LEAGUE_TIERS = [
  { key: "bronze",   name: "Bronze",   color: "#b45309" },
  { key: "silver",   name: "Silver",   color: "#9aa3ad" },
  { key: "gold",     name: "Gold",     color: "#c99a3b" },
  { key: "sapphire", name: "Sapphire", color: "#2f6fed" },
  { key: "ruby",     name: "Ruby",     color: "#c02749" },
  { key: "diamond",  name: "Diamond",  color: "#22b8c4" },
];

// Warm-editorial theme tokens, matched to the marketing site (src/site.css) so
// app and site read as one product. Light is paper/ink; dark is a neutral
// charcoal, kept un-tinted so it never reads warm/yellow (learned that the hard
// way). Injected via a <style> element in the theme effect. Elevation runs
// tertiary (page) < secondary (inset) < primary (cards); indigo #4338ca accent.
export const THEME_LIGHT = `
  :root,[data-theme="light"] {
    --color-background-primary:#fffdf9 !important;
    --color-background-secondary:#f6f1e8 !important;
    --color-background-tertiary:#f3ece0 !important;
    --color-background-success:#edf4ec !important;
    --color-background-danger:#f8ece7 !important;
    --color-text-primary:#231f1a !important;
    --color-text-secondary:#544e45 !important;
    --color-text-tertiary:#8a8478 !important;
    --color-text-success:#3b7a5e !important;
    --color-text-danger:#b23a26 !important;
    --color-border-danger:#ecccc2 !important;
    --color-border-primary:#d8cfbd !important;
    --color-border-secondary:#e6dfd2 !important;
    --color-border-tertiary:#efe8db !important;
    --color-border-success:#cbe3cf !important;
    --color-hover-tint:#f3ede1 !important;
    --color-sel-tint:#ece8f9 !important;
    --color-accent:#4338ca !important;
  }
`;
export const THEME_DARK = `
  :root,[data-theme="dark"] {
    --color-background-primary:#242424 !important;
    --color-background-secondary:#2e2e2e !important;
    --color-background-tertiary:#181818 !important;
    --color-background-success:#18291c !important;
    --color-background-danger:#2c1a15 !important;
    --color-text-primary:#ececec !important;
    --color-text-secondary:#a6a6a6 !important;
    --color-text-tertiary:#787878 !important;
    --color-text-success:#63cd91 !important;
    --color-text-danger:#ef9e8c !important;
    --color-border-danger:#472a20 !important;
    --color-border-primary:#3f3f3f !important;
    --color-border-secondary:#333333 !important;
    --color-border-tertiary:#262626 !important;
    --color-border-success:#2d4a37 !important;
    --color-hover-tint:#2e2e2e !important;
    --color-sel-tint:#302c58 !important;
    --color-accent:#a3a4f7 !important;
  }
`;

// AI model + difficulty rubric (shared by the generation layer and the app).
// Model for all generation/grading. Haiku 4.5: cheap + fast, plenty for
// question writing. ($0.80/1M in, $4/1M out vs Sonnet's $3/$15.)
export const AI_MODEL     = "claude-haiku-4-5-20251001";

// Difficulty rubric (index 0/1/2 = Easy/Normal/Hard). The label alone barely
// moves the model, the per-level guidance is what actually changes output.
// Calibrated from what students say they mean by each level: Easy = genuinely
// easy, Normal = the standard exam question they expect, Hard = deep and
// demanding but never tricky/gotcha/tedious. Difficulty comes from depth of
// reasoning and number of concepts connected, not from trap wording.
export const DIFFICULTY = [
  { name:"Easy",   guide:"Genuinely easy. One core fact or definition per question, tested directly, in plain everyday wording. Recall or simple recognition (Bloom: Remember or Understand). One step, no calculation chains, no traps. The correct answer is obvious to anyone who read the material, and the other options are clearly wrong. Never obscure." },
  { name:"Normal", guide:"A standard, fair exam question, the level most students expect by default. Test real understanding and straightforward application (Bloom: Understand or Apply): connect two related ideas, apply a concept to a clear example, or take one clear reasoning step. Distractors should be genuinely plausible and reflect common honest misconceptions, not word games. Solid but not punishing." },
  { name:"Hard",   guide:"Genuinely hard through DEPTH, not trickery. Require multi-step reasoning, connecting several concepts, applying ideas to a NEW or unfamiliar scenario, or analysing and evaluating relationships and trade-offs (Bloom: Apply, Analyze or Evaluate). Distractors are close and demand careful discrimination by someone who truly understands. The challenge must come from how much thinking and how many concepts are needed, NEVER from gotcha wording, deliberate ambiguity, obscure trivia, or tedious busywork. A well-prepared student should still get it by reasoning carefully." },
];

// Question-pack top-up options (shown in the packs modal + usage panel).
// One-time top-ups added to the bonus balance (never expire, used after the
// daily allowance). Shown from the "limit reached" message and from Settings.
export const QUESTION_PACKS = [
  { id:"A", q:"500",   price:"€1.99", blurbKey:"packBlurbA" },
  { id:"B", q:"1,500", price:"€4.99", blurbKey:"packBlurbB", best:true },
  { id:"C", q:"3,000", price:"€8.99", blurbKey:"packBlurbC" },
];

// Side 160x600 banners on desktop (where there's empty margin), a 320x50
// bottom banner on mobile. Visibility is controlled by CSS media queries.
// Placeholder ad boxes are OFF while pursuing AdSense approval (see lib/ads.jsx).
// Real ads come from AdSense Auto Ads via the loader in index.html once approved.
export const ADS_ENABLED = false; // was: import.meta.env.VITE_ADS_ENABLED === "true"

// Starter library: ready-made warm-ups a brand-new user (no material of their
// own yet) can quiz on in one tap, so they feel the core "make a quiz" magic
// before uploading anything. Grouped by GOAL: the eight exams Revyy has mocks
// for (so a serious prepper sees THEIR test, not generic trivia) and a few
// broad subjects. Each summary is rich enough for the AI to build a solid
// 10-question set; questions are generated in the user's UI language.
export const STARTER_EXAMS = [
  { id: "starter_sat", emoji: "📝", title: "SAT", subject: "SAT",
    summary: "A warm-up mixing the digital SAT's core skills: standard English grammar and punctuation (subject-verb agreement, commas, transitions, concision), reading a short passage for its main idea and evidence, and the most common math topics, linear equations, ratios and percentages, and basic functions." },
  { id: "starter_act", emoji: "📘", title: "ACT", subject: "ACT",
    summary: "A warm-up covering the ACT's core skills: English grammar and punctuation, reading for main idea and detail, core algebra and geometry (equations, ratios, area and angles), and interpreting a simple data table or graph the way the science section expects." },
  { id: "starter_psat", emoji: "✏️", title: "PSAT", subject: "PSAT/NMSQT",
    summary: "A warm-up mirroring the digital PSAT and SAT: standard English grammar and punctuation, reading a short passage for its main idea, and common math topics, linear equations, ratios and percentages, and basic functions." },
  { id: "starter_gre", emoji: "🎓", title: "GRE", subject: "GRE",
    summary: "A warm-up on the GRE's core skills: high-frequency academic vocabulary used in context, reading comprehension and inference, and quantitative reasoning basics, arithmetic, ratios and percentages, algebra, and simple data interpretation." },
  { id: "starter_gmat", emoji: "📊", title: "GMAT", subject: "GMAT",
    summary: "A warm-up on GMAT Focus skills: critical reasoning (spotting an argument's assumption and what strengthens or weakens it), quantitative problem solving (algebra, ratios, word problems), and reading a short table or chart to reach a decision." },
  { id: "starter_lsat", emoji: "⚖️", title: "LSAT", subject: "LSAT",
    summary: "A warm-up on LSAT logical reasoning: identifying an argument's conclusion and its support, naming the assumption, spotting a flaw, and choosing what would most strengthen or weaken a short argument, plus careful reading for a passage's main point." },
  { id: "starter_mcat", emoji: "🧪", title: "MCAT", subject: "MCAT",
    summary: "A warm-up on MCAT foundations: cell biology and biochemistry basics (macromolecules, enzymes, metabolism), general and organic chemistry fundamentals (bonding, acids and bases, functional groups), and a touch of introductory psychology and sociology terms." },
  { id: "starter_ucat", emoji: "🩺", title: "UCAT", subject: "UCAT",
    summary: "A warm-up on UCAT-style reasoning: reading a short passage to judge whether a statement follows, quantitative reasoning from a table or chart, spotting the pattern in an abstract set, and a simple logical decision-making puzzle." },
];

export const STARTER_SUBJECTS = [
  { id: "starter_bio", emoji: "🧬", title: "Biology Basics", subject: "Biology",
    summary: "Cells are the basic unit of life. Prokaryotic cells (bacteria) have no nucleus, while eukaryotic cells (plants, animals, fungi) keep their DNA inside a membrane-bound nucleus. Key organelles: mitochondria produce ATP energy through cellular respiration; chloroplasts in plant cells carry out photosynthesis, converting carbon dioxide and water into glucose and oxygen using sunlight; ribosomes build proteins; the cell membrane controls what enters and leaves. DNA is made of four bases (A, T, C, G) and carries genetic instructions; it is copied during replication and read to make proteins via transcription and translation. Mitosis produces two identical cells for growth; meiosis produces four genetically varied sex cells. Osmosis is the movement of water across a membrane from low to high solute concentration." },
  { id: "starter_world", emoji: "🌍", title: "World History", subject: "History",
    summary: "Ancient civilizations arose along rivers: Mesopotamia between the Tigris and Euphrates, Egypt along the Nile, the Indus Valley, and China's Yellow River. The Roman Empire fell in 476 CE. The Middle Ages followed in Europe, then the Renaissance (roughly 1400 to 1600) revived art and learning. The printing press was invented by Gutenberg around 1440. The Industrial Revolution began in Britain in the late 1700s, shifting economies to factories and steam power. World War I ran from 1914 to 1918; World War II from 1939 to 1945, ending after the atomic bombings of Hiroshima and Nagasaki. The Cold War was a rivalry between the United States and the Soviet Union. The Berlin Wall fell in 1989." },
  { id: "starter_chem", emoji: "⚗️", title: "Chemistry Essentials", subject: "Chemistry",
    summary: "Atoms consist of protons and neutrons in a nucleus, with electrons around it. The atomic number is the number of protons and defines the element. The periodic table arranges elements by atomic number; columns are groups and rows are periods. Chemical bonds: ionic bonds transfer electrons (metal plus nonmetal, like sodium chloride), while covalent bonds share electrons (nonmetals, like water H2O). A mole is 6.022 times 10 to the 23 particles (Avogadro's number). pH measures acidity: below 7 is acidic, 7 is neutral, above 7 is basic. In a chemical equation, reactants form products, and mass is conserved so equations must be balanced. Exothermic reactions release heat; endothermic reactions absorb it." },
  { id: "starter_psych", emoji: "🧠", title: "Psychology 101", subject: "Psychology",
    summary: "Classical conditioning, shown by Pavlov's dogs, pairs a neutral stimulus with one that triggers a response until the neutral one alone triggers it. Operant conditioning, studied by B. F. Skinner, shapes behavior through reinforcement (which increases behavior) and punishment (which decreases it). Maslow's hierarchy of needs rises from physiological needs to safety, belonging, esteem, and self-actualization. Long-term memory differs from short-term (working) memory, which holds about seven items. The brain's regions include the amygdala (emotion and fear), the hippocampus (forming memories), and the prefrontal cortex (planning and decisions). Confirmation bias is favoring information that supports existing beliefs. The nature versus nurture debate weighs genetics against environment in shaping behavior." },
  { id: "starter_geo", emoji: "🗺️", title: "World Geography", subject: "Geography",
    summary: "Earth has seven continents: Asia, Africa, North America, South America, Antarctica, Europe, and Australia. The largest ocean is the Pacific. The longest river is the Nile (though the Amazon carries the most water); the highest mountain is Everest. Capitals to know: France is Paris, Japan is Tokyo, Australia is Canberra (not Sydney), Canada is Ottawa, Brazil is Brasilia, Egypt is Cairo. The equator divides the Northern and Southern Hemispheres; the Prime Meridian sets zero longitude. The Sahara is the largest hot desert. Russia is the largest country by area; China and India are the most populous. Latitude lines run east to west; longitude lines run north to south." },
  { id: "starter_gk", emoji: "💡", title: "General Knowledge", subject: "Trivia",
    summary: "A varied mix of common knowledge. Water is made of two hydrogen atoms and one oxygen atom. There are eight planets in the solar system; Jupiter is the largest and Mercury is closest to the Sun. Light travels faster than sound, which is why lightning is seen before thunder. The human body has 206 bones and the heart has four chambers. Shakespeare wrote Romeo and Juliet and Hamlet. The Mona Lisa was painted by Leonardo da Vinci. A triangle's angles add up to 180 degrees. The freezing point of water is 0 degrees Celsius and boiling is 100. The speed of light is about 300,000 kilometres per second. Photosynthesis produces the oxygen we breathe." },
];

// Stripe price ids (env-driven), shared by the settings panel + checkout.
export const STRIPE_MONTHLY_PRICE = import.meta.env.VITE_STRIPE_MONTHLY_PRICE;
export const STRIPE_YEARLY_PRICE  = import.meta.env.VITE_STRIPE_YEARLY_PRICE;

// Free daily question allowance (shown in the settings plan lists).
export const FREE_DAILY = 50;
