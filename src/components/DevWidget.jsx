import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useDev, DEV_MODE } from "../context/DevContext.jsx";
import { useAuth } from "../context/AuthContext.jsx";

// One tri-state row: Auto (use real) / On / Off.
function Tri({ label, sub, value, onSet }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "7px 0", borderBottom: "1px solid #2a2a3a" }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "#e2e8f0" }}>{label}</div>
        {sub && <div style={{ fontSize: 10, color: "#94a3b8" }}>{sub}</div>}
      </div>
      <div style={{ display: "flex", gap: 3, flexShrink: 0 }}>
        {[["Auto", null], ["On", true], ["Off", false]].map(([t, v]) => (
          <button key={t} onClick={() => onSet(v)}
            style={{ fontSize: 10, fontWeight: 700, padding: "4px 7px", borderRadius: 6, border: "none", cursor: "pointer",
              background: value === v ? (v === true ? "#16a34a" : v === false ? "#dc2626" : "#4f46e5") : "#2a2a3a",
              color: "#fff", opacity: value === v ? 1 : 0.55 }}>{t}</button>
        ))}
      </div>
    </div>
  );
}

// Floating dev-tools panel. Rendered only when VITE_DEV_MODE=true.
export default function DevWidget() {
  const dev = useDev();
  const { isPro, user } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  if (!DEV_MODE) return null;

  return (
    <>
      <button onClick={() => setOpen((o) => !o)}
        style={{ position: "fixed", bottom: 16, left: 16, zIndex: 99999, background: "#dc2626", color: "#fff", border: "none", borderRadius: 10, padding: "8px 13px", fontSize: 12, fontWeight: 800, letterSpacing: 0.5, cursor: "pointer", boxShadow: "0 4px 14px rgba(0,0,0,0.4)", fontFamily: "system-ui, sans-serif" }}>
        {open ? "✕ DEV" : "🛠 DEV"}
      </button>

      {open && (
        <div style={{ position: "fixed", bottom: 60, left: 16, zIndex: 99999, width: 270, maxWidth: "calc(100vw - 32px)", background: "#16161f", border: "1px solid #2a2a3a", borderRadius: 14, padding: "14px 16px", boxShadow: "0 14px 40px rgba(0,0,0,0.55)", fontFamily: "system-ui, sans-serif", color: "#e2e8f0" }}>
          <div style={{ fontSize: 13, fontWeight: 800, color: "#fff", marginBottom: 2 }}>🛠 Dev Mode</div>
          <div style={{ fontSize: 10, color: "#94a3b8", marginBottom: 10 }}>Local only · not saved · resets on refresh</div>

          <Tri label="isPro" sub={`bypass payment · now: ${isPro ? "Pro ✅" : "Free"}`} value={dev.pro} onSet={dev.setPro} />
          <Tri label="isLoggedIn" sub={`bypass auth · now: ${user ? "signed in ✅" : "signed out"}`} value={dev.loggedIn} onSet={dev.setLoggedIn} />
          <Tri label="adsEnabled" sub="toggle ad banners" value={dev.ads} onSet={dev.setAds} />
          <Tri label="adUnlocked" sub="bypass ad watching" value={dev.adUnlocked} onSet={dev.setAdUnlocked} />

          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "9px 0", borderBottom: "1px solid #2a2a3a" }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "#e2e8f0" }}>dailyUsed</div>
            <button onClick={dev.resetDaily} style={{ fontSize: 10, fontWeight: 700, padding: "5px 10px", borderRadius: 6, border: "none", cursor: "pointer", background: "#4f46e5", color: "#fff" }}>Reset to 0</button>
          </div>

          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button onClick={() => { dev.setLoggedIn(true); navigate("/app"); }}
              style={{ flex: 1, fontSize: 11, fontWeight: 700, padding: "9px", borderRadius: 8, border: "none", cursor: "pointer", background: "#16a34a", color: "#fff" }}>
              Skip login
            </button>
            <button onClick={() => { try { localStorage.clear(); sessionStorage.clear(); } catch { /* ignore */ } window.location.reload(); }}
              style={{ flex: 1, fontSize: 11, fontWeight: 700, padding: "9px", borderRadius: 8, border: "none", cursor: "pointer", background: "#dc2626", color: "#fff" }}>
              Reset all
            </button>
          </div>
        </div>
      )}
    </>
  );
}
