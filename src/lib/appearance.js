// Applies the user's appearance settings (theme + font scale + reduced motion) to
// the WHOLE document, so they hold across the marketing site AND the app, not
// just inside /app. It reads the same `revyy_settings` the app persists, so a
// change made in the settings panel takes effect everywhere. Language is handled
// separately by LanguageContext, which is already global.
import { THEME_LIGHT, THEME_DARK } from "../studyquiz/constants.js";

const KEY = "revyy_settings";

export function readAppearance() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(KEY) || "{}") || {}; } catch { /* ignore */ }
  return {
    theme: s.theme === "light" || s.theme === "dark" ? s.theme : "system",
    fontSize: s.fontSize === "small" || s.fontSize === "large" ? s.fontSize : "medium",
    animations: s.animations !== false,
  };
}

// "system" resolves to the OS preference so a colour is always defined.
export function resolveTheme(theme) {
  if (theme === "dark") return "dark";
  if (theme === "light") return "light";
  try { return (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) ? "dark" : "light"; }
  catch { return "light"; }
}

export function applyAppearance() {
  if (typeof document === "undefined") return;
  const { theme, fontSize, animations } = readAppearance();
  const resolved = resolveTheme(theme);
  // data-theme drives the marketing site (site.css) + the app's [data-theme] rules.
  document.documentElement.setAttribute("data-theme", resolved);
  // Inject the app's colour variables to match (surfaces that use var(--color-*)).
  let el = document.getElementById("revyy-theme");
  if (!el) { el = document.createElement("style"); el.id = "revyy-theme"; document.head.appendChild(el); }
  el.textContent = resolved === "dark" ? THEME_DARK : THEME_LIGHT;
  // Font scale: `zoom` scales inline px too (most UI uses inline sizes) and keeps
  // fixed overlays put, unlike transform:scale.
  const z = fontSize === "small" ? "0.9" : fontSize === "large" ? "1.12" : "1";
  try { if (document.body) document.body.style.zoom = z; } catch { /* ignore */ }
  if (document.body) document.body.classList.toggle("no-anim", !animations);
  // Match the browser chrome (address bar) to the theme.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", resolved === "dark" ? "#181818" : "#fbf9f4");
}
