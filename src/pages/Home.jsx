import { Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";
import usePageMeta from "../lib/usePageMeta.js";
import AdSlot from "../components/AdSlot.jsx";
import Icon from "../components/Icon.jsx";

const FEATURES = [
  {
    icon: "notes",
    title: "Questions from your material, not the internet",
    desc: "Revyy reads exactly what you upload and asks about that. If a fact is not in your notes, it will not turn up in your quiz.",
  },
  {
    icon: "exam",
    title: "Mock exams that feel like the real paper",
    desc: "Timed papers with sections, written answers and marks. You get a grade and a breakdown of where the points went.",
  },
  {
    icon: "repeat",
    title: "Weak spots come back on their own",
    desc: "Miss a question and Revyy schedules it to return a day later, then a few days later, until you stop missing it.",
  },
  {
    icon: "layers",
    title: "Four ways to practise",
    desc: "Multiple choice, flashcards, fill in the blank, and match terms. Switch based on the subject and how close the exam is.",
  },
];

const STEPS = [
  {
    n: 1,
    title: "Add your material",
    desc: "Drop in a PDF, paste your notes, or photograph a textbook page. A few hundred pages is fine.",
  },
  {
    n: 2,
    title: "Practise",
    desc: "Revyy builds a quiz or a full mock exam in a few seconds, with a worked explanation for anything you get wrong.",
  },
  {
    n: 3,
    title: "Come back until it sticks",
    desc: "Missed questions return on a spaced schedule, so your last revision is the exact material you keep forgetting.",
  },
];

const FREE_PERKS = [
  "50 questions a day",
  "Multiple choice, always free",
  "Flashcards, match and one exam a day with ads",
  "Up to 20 questions per quiz",
  "Files up to 5 MB",
];
const PRO_PERKS = [
  "250 questions a day",
  "All four quiz types",
  "Unlimited and custom exam papers",
  "Up to 100 questions per quiz",
  "Unlimited file uploads",
  "No ads, anywhere",
];

const TRUST = [
  { icon: "tag", label: "Free to start, no card" },
  { icon: "camera", label: "PDFs, photos or pasted text" },
  { icon: "globe", label: "Works in 20+ languages" },
  { icon: "lock", label: "Your notes stay private" },
];

export default function Home() {
  const { user, isPro } = useAuth();
  usePageMeta(
    "Revyy: Practice Quizzes & Mock Exams From Your Own Notes",
    "Free study tool for students. Upload a PDF or paste your notes and get practice quizzes and graded mock exams built from your own material, then review your weak spots until exam day."
  );

  return (
    <>
      {/* Hero */}
      <section className="hero">
        <div className="container">
          <div className="hero-grid">
            <div>
              <span className="eyebrow">Study from your own material</span>
              <h1>
                Turn your notes into exam practice that{" "}
                <span className="mark">sticks</span>.
              </h1>
              <p className="hero-sub">
                Upload a PDF, paste your notes, or photograph a page. Revyy
                writes practice questions and full mock exams from your own
                material, then brings back whatever you get wrong until you
                know it.
              </p>
              <div className="hero-btns">
                <Link to="/app" className="btn btn-primary btn-lg">
                  {user ? "Start a quiz" : "Start studying free"}
                  <Icon name="arrow" size={18} />
                </Link>
                <a href="#how-it-works" className="btn btn-ghost btn-lg">
                  See how it works
                </a>
              </div>
              <p className="hero-note">
                No credit card. Your first quiz takes about a minute.
              </p>
            </div>

            {/* Honest product preview */}
            <div className="preview" aria-hidden="true">
              <div className="preview-bar">
                <span className="preview-dot" />
                <span className="preview-dot" />
                <span className="preview-dot" />
                <span style={{ marginLeft: "auto", fontSize: 12.5, color: "var(--muted)" }}>
                  Biology · Question 3 of 10
                </span>
              </div>
              <div className="preview-q">
                Which organelle is the main site of ATP synthesis?
              </div>
              <div className="preview-opt">
                <span className="k">A</span> Nucleus
              </div>
              <div className="preview-opt right">
                <span className="k">B</span> Mitochondrion
              </div>
              <div className="preview-opt">
                <span className="k">C</span> Ribosome
              </div>
              <div className="preview-opt">
                <span className="k">D</span> Golgi apparatus
              </div>
              <p className="preview-cap">
                Every question is written from the pages you upload.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Trust strip */}
      <div className="trust">
        <div className="container">
          <div className="trust-inner">
            {TRUST.map((t) => (
              <span key={t.label} className="trust-item">
                <Icon name={t.icon} size={19} className="ico" />
                {t.label}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* Features */}
      <section className="section">
        <div className="container">
          <div className="section-head">
            <div className="section-label">Why students use it</div>
            <h2>Practice built around what you actually need to learn</h2>
            <p>
              Most revision is passive rereading. Revyy makes you retrieve the
              material instead, which is the part that moves it into memory.
            </p>
          </div>
          <div className="feature-list">
            {FEATURES.map((f) => (
              <div key={f.title} className="feature-item">
                <span className="ico">
                  <Icon name={f.icon} size={30} stroke={1.5} />
                </span>
                <div>
                  <h3>{f.title}</h3>
                  <p>{f.desc}</p>
                </div>
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
            <h2>From a page of notes to a graded exam</h2>
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

      <AdSlot />

      {/* Plans */}
      <section className="section">
        <div className="container">
          <div className="section-head center">
            <div className="section-label">Plans</div>
            <h2>Start free. Upgrade only if you outgrow it.</h2>
            <p>No trials that quietly charge you, and you can cancel Pro whenever you like.</p>
          </div>
          <div className="pricing-grid">
            <div className="price-card">
              <div className="price-name">Free</div>
              <div className="price-amount">
                €0<span> forever</span>
              </div>
              <ul className="price-list">
                {FREE_PERKS.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
              <Link to="/app" className="btn btn-ghost btn-block">
                {user ? "Open the app" : "Start free"}
              </Link>
            </div>

            <div className="price-card pro">
              <span className="price-badge">Most popular</span>
              <div className="price-name">Pro</div>
              <div className="price-amount">
                €4.99<span> / month</span>
              </div>
              <ul className="price-list">
                {PRO_PERKS.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
              {isPro ? (
                <div className="pro-active-badge" aria-disabled="true">
                  <Icon name="check" size={17} /> You are on Pro
                </div>
              ) : (
                <Link to="/pricing" className="btn btn-amber btn-block">
                  Go Pro
                </Link>
              )}
              <p className="price-trial">
                {isPro ? "Your subscription is active" : "Cancel anytime"}
              </p>
            </div>
          </div>
          <div style={{ textAlign: "center", marginTop: 30 }}>
            <Link to="/pricing" className="btn btn-ghost">
              Compare the plans in detail
            </Link>
          </div>
        </div>
      </section>

      {/* Final CTA */}
      <section className="section">
        <div className="container">
          <div className="section-dark" style={{ borderRadius: 22, padding: "56px 44px" }}>
            <div className="cta-band">
              <h2>Start with one page of notes</h2>
              <p>
                Paste something you need to learn this week and see your first
                quiz in under a minute. No card, no commitment.
              </p>
              <Link to="/app" className="btn btn-light btn-lg">
                Make your first quiz
                <Icon name="arrow" size={18} />
              </Link>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
