/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useState } from "react";

// Master switch — ONLY active when explicitly "true". Anything else (false,
// undefined, missing) disables every dev bypass and hides all dev UI.
export const DEV_MODE = import.meta.env.VITE_DEV_MODE === "true";

const DevContext = createContext({
  devMode: false, pro: null, loggedIn: null, ads: null, adUnlocked: null, resetDailySignal: 0,
  setPro() {}, setLoggedIn() {}, setAds() {}, setAdUnlocked() {}, resetDaily() {},
});

export const useDev = () => useContext(DevContext);

// Overrides are plain in-memory state (null = "use the real value"), so they
// reset on refresh and are never persisted.
export function DevProvider({ children }) {
  const [pro, setPro] = useState(null);
  const [loggedIn, setLoggedIn] = useState(null);
  const [ads, setAds] = useState(null);
  const [adUnlocked, setAdUnlocked] = useState(null);
  const [resetDailySignal, setResetDailySignal] = useState(0);
  const resetDaily = () => setResetDailySignal((n) => n + 1);

  const value = {
    devMode: DEV_MODE, pro, loggedIn, ads, adUnlocked, resetDailySignal,
    setPro, setLoggedIn, setAds, setAdUnlocked, resetDaily,
  };
  return <DevContext.Provider value={value}>{children}</DevContext.Provider>;
}

// Small red badge for topbars (renders nothing in production).
export function DevBadge() {
  if (!DEV_MODE) return null;
  return (
    <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: 0.5, background: "#dc2626", color: "#fff", borderRadius: 6, padding: "2px 6px", whiteSpace: "nowrap" }}>
      DEV MODE
    </span>
  );
}
