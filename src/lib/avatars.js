// Curated avatar set. Users PICK one of these instead of uploading a photo, so
// there are no user-supplied images to moderate. Each avatar is an icon (from
// Icon.jsx) on a colored disc, rendered live as SVG, so there are no image files
// to host and it themes cleanly. The stored value is the avatar's `id`; a null /
// unknown id falls back to the colored first-letter avatar.
export const PRESET_AVATARS = [
  { id: "owl",       icon: "owl",       color: "#4338ca" },
  { id: "sprout",    icon: "sprout",    color: "#0f9d5a" },
  { id: "book",      icon: "book",      color: "#b45309" },
  { id: "gem",       icon: "gem",       color: "#7c3aed" },
  { id: "trophy",    icon: "trophy",    color: "#d97706" },
  { id: "flame",     icon: "flame",     color: "#e11d48" },
  { id: "bolt",      icon: "bolt",      color: "#2563eb" },
  { id: "cap",       icon: "cap",       color: "#0d9488" },
  { id: "compass",   icon: "compass",   color: "#0891b2" },
  { id: "target",    icon: "target",    color: "#dc2626" },
  { id: "globe",     icon: "globe",     color: "#0284c7" },
  { id: "sun",       icon: "sun",       color: "#f59e0b" },
  { id: "moon",      icon: "moon",      color: "#6366f1" },
  { id: "spark",     icon: "spark",     color: "#db2777" },
  { id: "chart",     icon: "chart",     color: "#9333ea" },
  { id: "bulb",      icon: "bulb",      color: "#ca8a04" },
  { id: "chat",      icon: "chat",      color: "#65a30d" },
  { id: "users",     icon: "users",     color: "#d4537e" },
  { id: "snowflake", icon: "snowflake", color: "#38bdf8" },
  { id: "card",      icon: "card",      color: "#14b8a6" },
];

const AVATAR_BY_ID = Object.fromEntries(PRESET_AVATARS.map((a) => [a.id, a]));

// Resolve a stored avatar value to a preset { icon, color }, or null if it isn't
// one (a URL or the letter fallback).
export function presetAvatar(id) {
  return (typeof id === "string" && AVATAR_BY_ID[id]) || null;
}
