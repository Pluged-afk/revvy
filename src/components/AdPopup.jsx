import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { useShowAds } from "../lib/ads.jsx";

// Pages that must never show ads.
const NO_AD_PATHS = ["/contact", "/terms", "/privacy"];
const DISMISS_KEY = "revyy_adpopup_dismissed";

// A dismissible advertisement that slides up from the bottom when you enter the
// site and stays until the user closes it (✕). Shown once per browser session.
export default function AdPopup() {
  const show = useShowAds();
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState(() => {
    try { return sessionStorage.getItem(DISMISS_KEY) === "1"; } catch { return false; }
  });

  // Slide in shortly after landing (once per session).
  useEffect(() => {
    if (!show || dismissed) return;
    const id = setTimeout(() => setOpen(true), 1200);
    return () => clearTimeout(id);
  }, [show, dismissed]);

  if (!show || dismissed) return null;
  if (NO_AD_PATHS.includes(pathname)) return null;

  const close = () => {
    setOpen(false);
    setDismissed(true);
    try { sessionStorage.setItem(DISMISS_KEY, "1"); } catch { /* ignore */ }
  };

  return (
    <div className={"rv-adpopup" + (open ? " open" : "")} role="complementary" aria-label="Advertisement">
      <button className="rv-adpopup-close" onClick={close} aria-label="Close ad">✕</button>
      <div className="rv-adpopup-inner">
        <span className="rv-adslot-label">Advertisement</span>
      </div>
    </div>
  );
}
