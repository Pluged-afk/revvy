import { Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";
import usePageMeta from "../lib/usePageMeta.js";

const FEATURES = [
  { icon: "🤖", title: "AI-Powered Questions", desc: "AI reads your material and writes accurate, exam-quality questions in seconds." },
  { icon: "🎯", title: "4 Quiz Types", desc: "Multiple choice, flashcards, fill-in-the-blank, and match terms — pick what fits." },
  { icon: "🎓", title: "Exam Mode", desc: "Simulate real exam conditions with AI-graded written and multiple-choice papers." },
  { icon: "📱", title: "Works on Any Device", desc: "Phone, tablet, or laptop — Revyy is fully responsive and needs no install." },
];

const STEPS = [
  { n: 1, title: "Upload your material", desc: "Drop a PDF, paste your notes, or snap a photo of your textbook." },
  { n: 2, title: "Revyy generates your quiz", desc: "Our AI identifies the key concepts and writes a tailored quiz in seconds." },
  { n: 3, title: "Study and track progress", desc: "Answer, get instant explanations, and see your score climb every session." },
];

const FREE_PERKS = ["3 quizzes per day", "Multiple choice quizzes", "Up to 20 questions", "Files up to 5MB"];
const PRO_PERKS = ["Unlimited quizzes", "All 4 quiz types", "Up to 100 questions", "Exam Mode (AI-graded)", "No ads"];

export default function Home() {
  const { user, isPro } = useAuth();
  usePageMeta(
    "Revyy — Turn Any Material Into a Quiz",
    "Upload a PDF, paste notes or take a photo. Revyy builds your perfect study quiz in seconds using AI."
  );

  return (
    <>
      {/* Hero */}
      <section className="hero">
        <div className="container">
          <span className="eyebrow">AI Study Companion</span>
          <h1>Turn Any Material Into a Quiz — Instantly</h1>
          <p className="hero-sub">
            Upload a PDF, paste notes, or take a photo. Revyy builds your perfect
            study quiz in seconds using AI.
          </p>
          <div className="hero-btns">
            {user ? (
              <Link to="/app" className="btn btn-light btn-lg">Start a Quiz →</Link>
            ) : (
              <Link to="/signup" className="btn btn-light btn-lg">Start Studying Free →</Link>
            )}
            <a href="#how-it-works" className="btn btn-ghost-light btn-lg">See How It Works</a>
          </div>
        </div>
      </section>

      {/* Feature highlights */}
      <section className="section">
        <div className="container">
          <div className="section-head">
            <div className="section-label">Why Revyy</div>
            <h2>Study tools that actually work</h2>
            <p>Everything you need to turn passive reading into active recall.</p>
          </div>
          <div className="grid grid-4">
            {FEATURES.map((f) => (
              <div key={f.title} className="card">
                <div className="card-icon">{f.icon}</div>
                <h3>{f.title}</h3>
                <p>{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* How it works */}
      <section id="how-it-works" className="section section-soft">
        <div className="container">
          <div className="section-head">
            <div className="section-label">How it works</div>
            <h2>From material to mastery in 3 steps</h2>
          </div>
          <div className="steps">
            {STEPS.map((s) => (
              <div key={s.n} className="step">
                <div className="step-num">{s.n}</div>
                <h3>{s.title}</h3>
                <p>{s.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Plans */}
      <section className="section">
        <div className="container">
          <div className="section-head">
            <div className="section-label">Plans</div>
            <h2>Simple pricing, no surprises</h2>
            <p>Start free. Upgrade whenever you need the full toolkit.</p>
          </div>
          <div className="pricing-grid">
            {/* Free */}
            <div className="price-card">
              <div className="price-name">Free</div>
              <div className="price-amount">€0<span> /forever</span></div>
              <ul className="price-list">
                {FREE_PERKS.map((p) => <li key={p}>{p}</li>)}
              </ul>
              {user ? (
                <Link to="/app" className="btn btn-ghost btn-block">Open App →</Link>
              ) : (
                <Link to="/signup" className="btn btn-ghost btn-block">Start Free</Link>
              )}
            </div>

            {/* Pro */}
            <div className="price-card pro">
              <span className="price-badge">MOST POPULAR</span>
              <div className="price-name">Pro</div>
              <div className="price-amount">€4.99<span> /month</span></div>
              <ul className="price-list">
                {PRO_PERKS.map((p) => <li key={p}>{p}</li>)}
              </ul>
              {isPro ? (
                <div className="pro-active-badge" aria-disabled="true">✓ You're Pro</div>
              ) : (
                <Link to="/pricing" className="btn btn-amber btn-block">Upgrade →</Link>
              )}
              <p className="price-trial">{isPro ? "Your subscription is active" : "Cancel anytime"}</p>
            </div>
          </div>
          <div style={{ textAlign: "center", marginTop: 32 }}>
            <Link to="/pricing" className="btn btn-ghost">Compare all plans →</Link>
          </div>
        </div>
      </section>

      {/* Final CTA */}
      <section className="section">
        <div className="container">
          <div className="section-dark cta-band" style={{ borderRadius: 24, padding: "64px 24px" }}>
            <h2>Ready to study smarter?</h2>
            <p>Create your first quiz in under a minute. No credit card required.</p>
            {user ? (
              <Link to="/app" className="btn btn-light btn-lg">Start a Quiz →</Link>
            ) : (
              <Link to="/signup" className="btn btn-light btn-lg">Sign Up Free →</Link>
            )}
          </div>
        </div>
      </section>
    </>
  );
}
