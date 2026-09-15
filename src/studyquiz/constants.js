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
