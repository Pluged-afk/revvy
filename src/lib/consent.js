// Cookie / tracking consent. Essential cookies (sign-in session, saved
// settings, local study cache) always run - they are needed for the app to
// work. Advertising cookies (Google AdSense) run ONLY after the visitor accepts
// them here, so nothing tracks an EU/UK visitor without consent. The AdSense
// loader is injected on accept rather than in index.html, and Google Consent
// Mode (set to "denied" by default in index.html) is updated to match.

const KEY = "revyy_consent"; // "granted" | "denied" | null (undecided)
const ADSENSE_SRC = "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-7771463873865547";

export function getConsent() {
  try { return localStorage.getItem(KEY); } catch { return null; }
}

// Inject the AdSense script once (no-op if already present or off-DOM).
export function loadAdSense() {
  if (typeof document === "undefined") return;
  if (document.querySelector("script[data-adsense]")) return;
  const s = document.createElement("script");
  s.async = true;
  s.src = ADSENSE_SRC;
  s.crossOrigin = "anonymous";
  s.setAttribute("data-adsense", "1");
  document.head.appendChild(s);
}

function tellGoogle(granted) {
  if (typeof window === "undefined" || typeof window.gtag !== "function") return;
  const v = granted ? "granted" : "denied";
  window.gtag("consent", "update", { ad_storage: v, ad_user_data: v, ad_personalization: v, analytics_storage: v });
}

// Record the visitor's choice, update Consent Mode, and load ads if accepted.
export function setConsent(granted) {
  try { localStorage.setItem(KEY, granted ? "granted" : "denied"); } catch { /* private mode: honoured for this session only */ }
  tellGoogle(granted);
  if (granted) loadAdSense();
}

// On every load: a returning visitor who already accepted gets ads loaded now.
// Undecided or rejected visitors load nothing until they choose.
export function applyStoredConsent() {
  if (getConsent() === "granted") loadAdSense();
}
