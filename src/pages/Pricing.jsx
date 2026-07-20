import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";
import { useLang } from "../context/LanguageContext.jsx";
import usePageMeta from "../lib/usePageMeta.js";
import AdSlot from "../components/AdSlot.jsx";

const MONTHLY_PRICE = import.meta.env.VITE_STRIPE_MONTHLY_PRICE;
const YEARLY_PRICE = import.meta.env.VITE_STRIPE_YEARLY_PRICE;

const FREE = [
  "50 questions per day",
  "Multiple choice only",
  "Up to 20 per quiz",
  "Files up to 5MB",
  "Ads displayed",
];

const PRO_MONTHLY = [
  "250 questions per day",
  "All 4 quiz types",
  "Up to 100 per quiz",
  "No ads",
  "Unlimited files",
  "Exam Mode with AI grading",
  "Cancel anytime",
];

const PRO_YEARLY = [
  "Everything in Monthly",
  "Save 33% vs monthly",
  "€3.33/month billed yearly",
  "Best value ⭐",
];

const FAQ = [
  { q: "Can I cancel anytime?", a: "Yes. Manage or cancel your subscription anytime from the billing portal — you'll keep Pro until the end of your billing period, with no cancellation fees." },
  { q: "When am I charged?", a: "You're charged immediately when you upgrade, then automatically each billing period (monthly or yearly) until you cancel." },
  { q: "What payment methods do you accept?", a: "All major credit and debit cards, processed securely by Stripe. We never see or store your card details." },
  { q: "Is my data safe?", a: "Yes. We don't store your uploaded files — they're used only to generate your quiz and then discarded. See our Privacy Policy for full details." },
];

export default function Pricing() {
  const { user, isPro, startCheckout, loading } = useAuth();
  const { t } = useLang();
  const navigate = useNavigate();
  usePageMeta("Revyy Pricing — Free AI Quiz Generator, or Pro €4.99/mo", "Use Revyy's AI quiz generator free forever, or go Pro for €4.99/month for exam mode, all quiz types and no ads. Cancel anytime.");
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");

  const upgrade = async (priceId, which) => {
    setErr("");
    if (loading) return;                       // auth still resolving — wait, don't bounce
    if (!user) { navigate("/signup"); return; } // only send genuinely-logged-out users to signup
    // Logged-in: go straight to Stripe checkout with their existing session.
    setBusy(which);
    const { error } = await startCheckout(priceId);
    if (error) { setBusy(""); setErr(error); }
  };

  return (
    <>
      <section className="hero" style={{ padding: "84px 0 90px" }}>
        <div className="container">
          <span className="eyebrow">Pricing</span>
          <h1>Simple, honest pricing</h1>
          <p className="hero-sub">Start free forever, or go Pro — cancel anytime.</p>
        </div>
      </section>

      <section className="section">
        <div className="container">
          {err && <div className="auth-error" style={{ maxWidth: 600, margin: "0 auto 24px" }}>{err}</div>}
          <div className="pricing-grid pricing-grid-3">
            {/* Free */}
            <div className="price-card">
              <div className="price-name">Free</div>
              <div className="price-amount">€0<span> /forever</span></div>
              <ul className="price-list">
                {FREE.map((f) => <li key={f}>{f}</li>)}
              </ul>
              <Link to="/app" className="btn btn-ghost btn-block">Get Started Free</Link>
            </div>

            {/* Pro Monthly */}
            <div className="price-card pro">
              <span className="price-badge">MOST POPULAR</span>
              <div className="price-name">Pro Monthly</div>
              <div className="price-amount">€4.99<span> /month</span></div>
              <ul className="price-list">
                {PRO_MONTHLY.map((f) => <li key={f}>{f}</li>)}
              </ul>
              {isPro ? (
                <div className="pro-active-badge" aria-disabled="true">✓ You're Pro</div>
              ) : (
                <button className="btn btn-amber btn-block" disabled={busy === "monthly" || loading}
                  onClick={() => upgrade(MONTHLY_PRICE, "monthly")}>
                  {busy === "monthly" ? "Starting…" : t.upgradeToPro}
                </button>
              )}
              <p className="price-trial">{isPro ? "Your subscription is active" : t.cancelAnytime}</p>
            </div>

            {/* Pro Yearly */}
            <div className="price-card pro featured">
              <span className="price-badge best">⭐ BEST VALUE</span>
              <div className="price-name">Pro Yearly</div>
              <div className="price-amount">€39.99<span> /year</span></div>
              <ul className="price-list">
                {PRO_YEARLY.map((f) => <li key={f}>{f}</li>)}
              </ul>
              {isPro ? (
                <div className="pro-active-badge" aria-disabled="true">✓ You're Pro</div>
              ) : (
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
          <div className="section-head">
            <div className="section-label">FAQ</div>
            <h2>Questions, answered</h2>
          </div>
          <div className="faq">
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
