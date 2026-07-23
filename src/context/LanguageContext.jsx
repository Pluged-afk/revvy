import { createContext, useContext, useState, useEffect, useCallback } from "react";
import { getTranslations } from "../i18n.js";

// Exported so the build-time prerenderer can supply an English mock value.
export const LangContext = createContext(null);

// eslint-disable-next-line react-refresh/only-export-components
export const useLang = () => useContext(LangContext);

const KEY = "revyy_lang";

// Holds the selected language, persists it to localStorage, and keeps it in
// sync across tabs. Provides `t` (the resolved translation set) to all pages.
export function LanguageProvider({ children }) {
  const [lang, setLangState] = useState(() => {
    try { return localStorage.getItem(KEY) || "en"; } catch { return "en"; }
  });

  const setLang = useCallback((l) => {
    setLangState(l);
    try { localStorage.setItem(KEY, l); } catch { /* ignore */ }
  }, []);

  // Sync language changes made in other tabs.
  useEffect(() => {
    const onStorage = (e) => { if (e.key === KEY && e.newValue) setLangState(e.newValue); };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // Reflect the language + text direction on <html> so RTL languages
  // (Arabic, Hebrew) flow right-to-left. Numbers stay LTR automatically.
  useEffect(() => {
    const RTL = ["ar", "he"];
    document.documentElement.lang = lang;
    document.documentElement.dir = RTL.includes(lang) ? "rtl" : "ltr";
  }, [lang]);

  const t = getTranslations(lang);
  return <LangContext.Provider value={{ lang, setLang, t }}>{children}</LangContext.Provider>;
}
