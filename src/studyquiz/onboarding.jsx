// One-time signup onboarding. Shown ONLY to brand-new accounts and ONLY once:
// the completion flag lives in the account study-blob (StudyContext.onboarding),
// so once finished it syncs and never re-shows on this or any other device.
// Collects a study purpose, a couple of preferences, the Arena opt-in, and
// Terms/Privacy acceptance, then hands the choices back for the app to apply and
// persist. Terms acceptance is required; the other steps can be skipped.
import { useState } from "react";
import Icon from "../components/Icon.jsx";
import { Sb } from "./styles.js";

const heading = { fontFamily: "'Fraunces',Georgia,serif", fontSize: 22, fontWeight: 800, color: "var(--color-text-primary)", margin: "0 0 6px", textAlign: "center" };
const sub = { fontSize: 13.5, color: "var(--color-text-secondary)", textAlign: "center", lineHeight: 1.5, margin: "0 0 18px" };
const secLabel = { fontSize: 12, fontWeight: 700, color: "var(--color-text-tertiary)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 10 };
const optRow = { display: "flex", alignItems: "flex-start", gap: 10, padding: "12px 14px", borderRadius: 12, background: "var(--color-background-secondary)", cursor: "pointer" };

export function Onboarding({ t, initial = {}, langs = {}, onFinish }) {
  const [step, setStep] = useState(0);
  const [purpose, setPurpose] = useState("");
  const [theme, setTheme] = useState(initial.theme || "system");
  const [lang, setLang] = useState(initial.lang || "en");
  const [shareArena, setShareArena] = useState(initial.shareArena ?? false);
  const [reminders, setReminders] = useState(false);
  const [agree, setAgree] = useState(false);

  const PURPOSES = [
    ["standardized", t.obPurpStd || "Standardized tests (SAT, ACT, GRE...)"],
    ["school", t.obPurpSchool || "School or university"],
    ["professional", t.obPurpPro || "Professional or licensing exams"],
    ["general", t.obPurpGeneral || "General learning"],
    ["other", t.obPurpOther || "Something else"],
  ];
  const THEMES = [
    ["light", t.obThemeLight || "Light", "sun"],
    ["dark", t.obThemeDark || "Dark", "moon"],
    ["system", t.obThemeSystem || "System", "gear"],
  ];

  const finish = () => { if (agree) onFinish({ purpose, theme, lang, shareArena, reminders, tos: true }); };
  const dot = (i) => <span key={i} aria-hidden="true" style={{ width: i === step ? 18 : 7, height: 7, borderRadius: 4, background: i === step ? "var(--color-accent)" : "var(--color-border-secondary)", transition: "all .2s" }} />;

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 2000, background: "rgba(0,0,0,0.72)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div style={{ background: "var(--color-background-primary)", borderRadius: 20, padding: "24px 22px 20px", maxWidth: 440, width: "100%", maxHeight: "92vh", overflowY: "auto", boxShadow: "0 24px 60px rgba(0,0,0,0.5)" }}>
        <div style={{ display: "flex", gap: 6, justifyContent: "center", marginBottom: 18 }}>{[0, 1, 2].map(dot)}</div>

        {step === 0 && (<>
          <h2 style={heading}>{t.obWelcomeTitle || "Welcome to Revyy"}</h2>
          <p style={sub}>{t.obWelcomeSub || "A couple of quick questions to set things up. This only happens once."}</p>
          <div style={secLabel}>{t.obPurposeQ || "What will you use Revyy for?"}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {PURPOSES.map(([id, label]) => (
              <button key={id} onClick={() => setPurpose(id)} style={{ textAlign: "left", padding: "12px 14px", borderRadius: 12, border: "1px solid " + (purpose === id ? "var(--color-accent)" : "var(--color-border-secondary)"), background: purpose === id ? "var(--color-sel-tint)" : "var(--color-background-secondary)", color: purpose === id ? "var(--color-accent)" : "var(--color-text-primary)", fontSize: 14, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>{label}</button>
            ))}
          </div>
        </>)}

        {step === 1 && (<>
          <h2 style={heading}>{t.obMakeYours || "Make it yours"}</h2>
          <p style={sub}>{t.obMakeYoursSub || "You can change any of this later in Settings."}</p>
          <div style={secLabel}>{t.obTheme || "Appearance"}</div>
          <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
            {THEMES.map(([id, label, icon]) => (
              <button key={id} onClick={() => setTheme(id)} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 5, padding: "11px 4px", borderRadius: 12, border: "1px solid " + (theme === id ? "var(--color-accent)" : "var(--color-border-secondary)"), background: theme === id ? "var(--color-sel-tint)" : "var(--color-background-secondary)", color: theme === id ? "var(--color-accent)" : "var(--color-text-secondary)", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}><Icon name={icon} size={18} />{label}</button>
            ))}
          </div>
          <div style={secLabel}>{t.obLanguage || "Language"}</div>
          <select value={lang} onChange={(e) => setLang(e.target.value)} style={{ width: "100%", padding: "11px 12px", borderRadius: 12, border: "1px solid var(--color-border-secondary)", background: "var(--color-background-secondary)", color: "var(--color-text-primary)", fontSize: 14, fontFamily: "inherit", marginBottom: 16 }}>
            {Object.entries(langs).map(([code, l]) => <option key={code} value={code}>{l.flag} {l.name}</option>)}
          </select>
          <label style={{ ...optRow, border: "1px solid " + (shareArena ? "var(--color-accent)" : "var(--color-border-secondary)") }}>
            <input type="checkbox" checked={shareArena} onChange={(e) => setShareArena(e.target.checked)} style={{ marginTop: 2, width: 16, height: 16, accentColor: "var(--color-accent)", flexShrink: 0 }} />
            <span style={{ minWidth: 0 }}><span style={{ fontSize: 13.5, fontWeight: 700, color: "var(--color-text-primary)", display: "block" }}>{t.obShareArena || "Share my questions to the Arena"}</span><span style={{ fontSize: 11.5, color: "var(--color-text-tertiary)", lineHeight: 1.45 }}>{t.obShareArenaSub || "Well-formed general-knowledge questions may join the community pool. Off by default, and nothing tied to you or your notes is ever shared."}</span></span>
          </label>
          <label style={{ ...optRow, marginTop: 8, border: "1px solid " + (reminders ? "var(--color-accent)" : "var(--color-border-secondary)") }}>
            <input type="checkbox" checked={reminders} onChange={(e) => setReminders(e.target.checked)} style={{ marginTop: 2, width: 16, height: 16, accentColor: "var(--color-accent)", flexShrink: 0 }} />
            <span style={{ minWidth: 0 }}><span style={{ fontSize: 13.5, fontWeight: 700, color: "var(--color-text-primary)", display: "block" }}>{t.obReminders || "Send me study reminders"}</span><span style={{ fontSize: 11.5, color: "var(--color-text-tertiary)", lineHeight: 1.45 }}>{t.obRemindersSub || "A gentle nudge to keep your streak and review what is due."}</span></span>
          </label>
        </>)}

        {step === 2 && (<>
          <h2 style={heading}>{t.obAlmostTitle || "One last thing"}</h2>
          <p style={sub}>{t.obAlmostSub || "Please review and accept to start studying."}</p>
          <label style={{ display: "flex", alignItems: "flex-start", gap: 11, padding: 14, borderRadius: 12, background: "var(--color-background-secondary)", border: "1px solid " + (agree ? "var(--color-accent)" : "var(--color-border-secondary)"), cursor: "pointer" }}>
            <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} style={{ marginTop: 2, width: 17, height: 17, accentColor: "var(--color-accent)", flexShrink: 0 }} />
            <span style={{ fontSize: 13.5, color: "var(--color-text-primary)", lineHeight: 1.55 }}>{t.obAgreePre || "I agree to Revyy's"} <a href="/terms" target="_blank" rel="noopener noreferrer" style={{ color: "var(--color-accent)", fontWeight: 700 }}>{t.obTos || "Terms of Service"}</a> {t.obAnd || "and"} <a href="/privacy" target="_blank" rel="noopener noreferrer" style={{ color: "var(--color-accent)", fontWeight: 700 }}>{t.obPrivacy || "Privacy Policy"}</a>.</span>
          </label>
          <p style={{ fontSize: 11, color: "var(--color-text-tertiary)", marginTop: 12, lineHeight: 1.5 }}>{t.obDataNote || "You can change your preferences or delete your account any time in Settings."}</p>
        </>)}

        <div style={{ display: "flex", gap: 10, marginTop: 22, alignItems: "center" }}>
          {step > 0 ? <button onClick={() => setStep((s) => s - 1)} style={{ ...Sb.btnGhost, padding: "11px 16px" }}>{t.backWord || "Back"}</button> : <span />}
          <div style={{ flex: 1 }} />
          {step < 2 && <button onClick={() => setStep(2)} style={{ background: "none", border: "none", color: "var(--color-text-tertiary)", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>{t.obSkip || "Skip"}</button>}
          {step < 2
            ? <button onClick={() => setStep((s) => s + 1)} style={{ ...Sb.btnPrimary, padding: "11px 22px" }}>{t.continueWord || "Continue"}</button>
            : <button onClick={finish} disabled={!agree} style={{ ...Sb.btnPrimary, padding: "11px 22px", opacity: agree ? 1 : 0.45, cursor: agree ? "pointer" : "not-allowed" }}>{t.obGetStarted || "Get started"}</button>}
        </div>
      </div>
    </div>
  );
}
