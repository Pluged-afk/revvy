// Loads Google AdSense on demand. Kept out of index.html so we can decide, once
// Clerk has resolved the account, whether to load it at all: signed-in Pro users
// never get it (truly ad-free, no Auto Ads and no ad cookies), while free and
// signed-out visitors do. Idempotent and SSR-safe.

const SRC = "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-7771463873865547";

export function loadAdSense() {
  if (typeof document === "undefined") return;            // SSR / prerender
  if (document.querySelector("script[data-adsense]")) return; // already loaded
  const s = document.createElement("script");
  s.async = true;
  s.src = SRC;
  s.crossOrigin = "anonymous";
  s.setAttribute("data-adsense", "1");
  document.head.appendChild(s);
}
