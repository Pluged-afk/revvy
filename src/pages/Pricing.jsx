import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";
import { useLang } from "../context/LanguageContext.jsx";
import usePageMeta from "../lib/usePageMeta.js";
import AdSlot from "../components/AdSlot.jsx";
import Icon from "../components/Icon.jsx";

const MONTHLY_PRICE = import.meta.env.VITE_STRIPE_MONTHLY_PRICE;
const YEARLY_PRICE = import.meta.env.VITE_STRIPE_YEARLY_PRICE;

const FREE = [
  "50 questions a day (up to 70 with ads)",
  "Multiple choice, always free",
  "Flashcards, fill-in and match (with ads)",
  "One custom exam a day (with ads)",
  "Up to 20 questions per quiz",
  "Adaptive difficulty and spaced-repetition review",
  "Files up to 5 MB",
];

const PRO_MONTHLY = [
  "250 questions a day",
  "All four quiz types, no ads",
  "Unlimited custom exams from your notes",
  "Full mock tests: SAT, ACT, GRE and 5 more",
  "Up to 100 questions per quiz",
  "Unlimited uploads, plus lecture audio and video",
  "Cancel anytime",
];

const PRO_YEARLY = [
  "Everything in Monthly",
  "Save 33% versus monthly",
  "Works out to €3.33 a month",
  "The best value if you study year round",
];

const FAQ = [
  { q: "What can I upload?", a: "PDFs, photos of a page or whiteboard, and typed or pasted notes on any plan. Pro also reads lecture audio and video by transcribing it, and you can import an existing Quizlet set as flashcards." },
  { q: "Which exams can I mock?", a: "The SAT, ACT, PSAT/NMSQT, GRE, GMAT, LSAT, MCAT and UCAT. Each mock uses the real sections, question counts, timing and score scale, and marks itself the moment you finish. Standardized mocks are a Pro feature." },
  { q: "How accurate are the questions?", a: "Every quiz is built from the material you give it, so it asks about what is actually in your notes, and each answer comes with a short explanation. If a question ever looks wrong, you can flag it and Revyy replaces it." },
  { q: "What languages does it support?", a: "Twenty, including Spanish, French, German, Portuguese, Japanese, Hindi and Arabic. You can generate and answer quizzes in your own language." },
  { q: "Can I cancel anytime?", a: "Yes. You can manage or cancel your subscription whenever you like from the billing portal. You keep Pro until the end of the period you already paid for, with no cancellation fee." },
  { q: "When am I charged?", a: "You are charged when you upgrade, then automatically each period (monthly or yearly) until you cancel." },
  { q: "What payment methods do you accept?", a: "All major credit and debit cards, handled securely by Stripe. We never see or store your card details." },
  { q: "Is my data safe?", a: "We do not keep your uploaded files. They are used to build your quiz and then discarded. Our Privacy Policy has the full detail." },
];

export default function Pricing() {
  const { user, isPro, startCheckout, loading } = useAuth();
  const { t } = useLang();
  const navigate = useNavigate();
  usePageMeta(
    "Revyy Pricing: Free Quiz Generator, or Pro at €4.99 a Month",
    "Use Revyy free forever, or go Pro for €4.99 a month for exam mode, all four quiz types and no ads. Cancel anytime."
  );
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");

  const upgrade = async (priceId, which) => {
    setErr("");
    if (loading) return;                       // auth still resolving, wait rather than bounce
    if (!user) { navigate("/signup"); return; } // only send genuinely-logged-out users to signup
    setBusy(which);
    const { error } = await startCheckout(priceId);
    if (error) { setBusy(""); setErr(error); }
  };

  const ProActive = () => (
    <div className="pro-active-badge" aria-disabled="true"><Icon name="check" size={17} /> You are on Pro</div>
  );

  return (
    <>
      <section className="hero" style={{ padding: "72px 0 32px" }}>
        <div className="container">
          <span className="eyebrow">Pricing</span>
          <h1>Simple, honest pricing</h1>
          <p className="hero-sub">Free forever if that is all you need. Pro when you want more, and you can cancel anytime.</p>
        </div>
      </section>

      <section className="section section-tight">
        <div className="container">
          {err && <div className="auth-error" style={{ maxWidth: 600, margin: "0 auto 24px" }}>{err}</div>}
          <div className="pricing-grid pricing-grid-3">
            {/* Free */}
            <div className="price-card">
              <div className="price-name">Free</div>
              <div className="price-amount">€0<span> forever</span></div>
              <ul className="price-list">
                {FREE.map((f) => <li key={f}>{f}</li>)}
              </ul>
              <Link to="/app" className="btn btn-ghost btn-block">Start free</Link>
            </div>

            {/* Pro Monthly */}
            <div className="price-card pro">
              <span className="price-badge">Most popular</span>
              <div className="price-name">Pro Monthly</div>
              <div className="price-amount">€4.99<span> / month</span></div>
              <ul className="price-list">
                {PRO_MONTHLY.map((f) => <li key={f}>{f}</li>)}
              </ul>
              {isPro ? <ProActive /> : (
                <button className="btn btn-amber btn-block" disabled={busy === "monthly" || loading}
                  onClick={() => upgrade(MONTHLY_PRICE, "monthly")}>
                  {busy === "monthly" ? "Starting…" : t.upgradeToPro}
                </button>
              )}
              <p className="price-trial">{isPro ? "Your subscription is active" : t.cancelAnytime}</p>
            </div>

            {/* Pro Yearly */}
            <div className="price-card pro featured">
              <span className="price-badge best">Best value</span>
              <div className="price-name">Pro Yearly</div>
              <div className="price-amount">€39.99<span> / year</span></div>
              <ul className="price-list">
                {PRO_YEARLY.map((f) => <li key={f}>{f}</li>)}
              </ul>
              {isPro ? <ProActive /> : (
                <button className="btn btn-amber btn-block" disabled={busy === "yearly" || loading}
                  onClick={() => upgrade(YEARLY_PRICE, "yearly")}>
                  {busy === "yearly" ? "Starting…" : t.upgradeToPro}
                </button>
              )}
              <p className="price-trial">{isPro ? "Your subscription is active" : t.cancelAnytime}</p>
            </div>
          </div>
        </div>
      </section>

      <AdSlot />

      <section className="section section-soft">
        <div className="container">
          <div className="section-head center">
            <div className="section-label">FAQ</div>
            <h2>Questions, answered</h2>
          </div>
          <div className="faq" style={{ margin: "0 auto" }}>
            {FAQ.map((item) => (
              <div key={item.q} className="faq-item">
                <h3>{item.q}</h3>
                <p>{item.a}</p>
              </div>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}
