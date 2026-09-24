import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { getConsent, setConsent, applyStoredConsent } from "../lib/consent.js";

// A small, keyboard-accessible cookie banner shown until the visitor chooses.
// Essential cookies always run; advertising (AdSense) loads only on "Accept".
export default function ConsentBanner() {
  const [show, setShow] = useState(false);

  // Client-only: the banner must never render in the prerendered HTML (it would
  // flash for visitors who already chose), so it is decided here, on mount.
  useEffect(() => {
    applyStoredConsent();            // returning "accepted" visitors: load ads now
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!getConsent()) setShow(true); // first visit / undecided: ask
  }, []);

  if (!show) return null;

  const choose = (granted) => { setConsent(granted); setShow(false); };

  return (
    <div role="dialog" aria-modal="false" aria-label="Cookie choices"
      style={{ position: "fixed", left: 12, right: 12, bottom: 12, zIndex: 2000, maxWidth: 720, margin: "0 auto",
        background: "var(--color-background-primary, #fff)", color: "var(--color-text-primary, #1a1a1a)",
        border: "1px solid var(--color-border-secondary, #d9d4ca)", borderRadius: 14,
        boxShadow: "0 12px 40px rgba(0,0,0,0.28)", padding: "16px 18px",
        display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12, fontFamily: "inherit" }}>
      <p style={{ flex: "1 1 280px", minWidth: 0, margin: 0, fontSize: 13.5, lineHeight: 1.5, color: "var(--color-text-secondary, #55504a)" }}>
        We use essential cookies to keep you signed in and remember your settings. With your permission we also use
        advertising cookies (Google AdSense) to support the free plan. See our{" "}
        <Link to="/privacy" style={{ color: "var(--color-accent, #4338ca)", fontWeight: 600 }}>Privacy Policy</Link>.
      </p>
      <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
        <button type="button" onClick={() => choose(false)}
          style={{ background: "var(--color-background-secondary, #f0ece4)", color: "var(--color-text-primary, #1a1a1a)",
            border: "1px solid var(--color-border-secondary, #d9d4ca)", borderRadius: 10, padding: "9px 15px",
            fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
          Reject non-essential
        </button>
        <button type="button" onClick={() => choose(true)}
          style={{ background: "var(--color-accent, #4338ca)", color: "#fff", border: "none", borderRadius: 10,
            padding: "9px 15px", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
          Accept all
        </button>
      </div>
    </div>
  );
}
