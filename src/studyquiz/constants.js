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
