import { Link } from "react-router-dom";

const FEATURES = [
  { icon: "🤖", title: "AI-Powered Questions", desc: "Claude reads your material and writes accurate, exam-quality questions in seconds." },
  { icon: "🎯", title: "4 Quiz Types", desc: "Multiple choice, flashcards, fill-in-the-blank, and match terms — pick what fits." },
  { icon: "🎓", title: "Exam Mode", desc: "Simulate real exam conditions with AI-graded written and multiple-choice papers." },
  { icon: "📱", title: "Works on Any Device", desc: "Phone, tablet, or laptop — Revyy is fully responsive and needs no install." },
];

const STEPS = [
  { n: 1, title: "Upload your material", desc: "Drop a PDF, paste your notes, add a link, or snap a photo of your textbook." },
  { n: 2, title: "Revyy generates your quiz", desc: "Our AI identifies the key concepts and writes a tailored quiz in seconds." },
  { n: 3, title: "Study and track progress", desc: "Answer, get instant explanations, and see your score climb every session." },
];

export default function Home() {
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
            <Link to="/signup" className="btn btn-light btn-lg">Start Studying Free →</Link>
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

      {/* Social proof */}
      <section className="section section-dark">
        <div className="container proof">
          <h2>Join thousands of students studying smarter</h2>
          <div className="proof-stats">
            <div className="proof-stat"><div className="num">12k+</div><div className="label">Quizzes generated</div></div>
            <div className="proof-stat"><div className="num">20+</div><div className="label">Languages supported</div></div>
            <div className="proof-stat"><div className="num">4.8★</div><div className="label">Average rating</div></div>
          </div>
        </div>
      </section>

      {/* Final CTA */}
      <section className="section">
        <div className="container">
          <div className="section-dark cta-band" style={{ borderRadius: 24, padding: "64px 24px" }}>
            <h2>Ready to study smarter?</h2>
            <p>Create your first quiz in under a minute. No credit card required.</p>
            <Link to="/signup" className="btn btn-light btn-lg">Sign Up Free →</Link>
          </div>
        </div>
      </section>
    </>
  );
}
