import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";

const MONTHLY_PRICE = import.meta.env.VITE_STRIPE_MONTHLY_PRICE;
const YEARLY_PRICE = import.meta.env.VITE_STRIPE_YEARLY_PRICE;

const FREE = [
  "3 quizzes per day",
  "Multiple choice only",
  "Up to 20 questions",
  "Files up to 5MB",
];

const PRO = [
  "Unlimited quizzes",
  "All 4 quiz types",
  "Up to 100 questions",
  "Unlimited file size",
  "Exam Mode with AI grading",
  "No ads",
];

const FAQ = [
  { q: "Can I cancel anytime?", a: "Yes. Manage or cancel your subscription anytime from the billing portal — you'll keep Pro until the end of your billing period, with no cancellation fees." },
  { q: "Is there a free trial?", a: "Yes — every Pro plan starts with a 7-day free trial. You won't be charged until the trial ends, and you can cancel before then for free." },
  { q: "What payment methods do you accept?", a: "All major credit and debit cards, processed securely by Stripe. We never see or store your card details." },
  { q: "Is my data safe?", a: "Yes. We don't store your uploaded files — they're used only to generate your quiz and then discarded. See our Privacy Policy for full details." },
];

export default function Pricing() {
  const { user, startCheckout } = useAuth();
  const navigate = useNavigate();
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");

  const upgrade = async (priceId, which) => {
    setErr("");
    if (!user) { navigate("/signup"); return; }
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
          <p className="hero-sub">Start free forever, or go Pro with a 7-day free trial — cancel anytime.</p>
        </div>
      </section>

      <section className="section">
        <div className="container">
          {err && <div className="auth-error" style={{ maxWidth: 600, margin: "0 auto 24px" }}>{err}</div>}
          <div className="pricing-grid pricing-grid-3">
            {/* Free */}
            <div className="price-card">
              <div className="price-name">Free</div>
              <div className="price-amount">€0<span> /month</span></div>
              <ul className="price-list">
                {FREE.map((f) => <li key={f}>{f}</li>)}
              </ul>
              <Link to="/signup" className="btn btn-ghost btn-block">Get Started Free</Link>
            </div>

            {/* Pro Monthly */}
            <div className="price-card pro">
              <span className="price-badge">MOST POPULAR</span>
              <div className="price-name">Pro Monthly</div>
              <div className="price-amount">€4.99<span> /month</span></div>
              <ul className="price-list">
                {PRO.map((f) => <li key={f}>{f}</li>)}
              </ul>
              <button className="btn btn-amber btn-block" disabled={busy === "monthly"}
                onClick={() => upgrade(MONTHLY_PRICE, "monthly")}>
                {busy === "monthly" ? "Starting…" : "Try Free for 7 Days"}
              </button>
              <p className="price-trial">7 day free trial · Cancel anytime</p>
            </div>

            {/* Pro Yearly */}
            <div className="price-card pro">
              <span className="price-badge">BEST VALUE</span>
              <div className="price-name">Pro Yearly</div>
              <div className="price-amount">€39.99<span> /year</span></div>
              <ul className="price-list">
                {PRO.map((f) => <li key={f}>{f}</li>)}
              </ul>
              <button className="btn btn-amber btn-block" disabled={busy === "yearly"}
                onClick={() => upgrade(YEARLY_PRICE, "yearly")}>
                {busy === "yearly" ? "Starting…" : "Try Free for 7 Days"}
              </button>
              <p className="price-trial">7 day free trial · Cancel anytime</p>
            </div>
          </div>
        </div>
      </section>

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
