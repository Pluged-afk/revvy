import { Link } from "react-router-dom";
import usePageMeta from "../lib/usePageMeta.js";

const FEATURES = [
  { icon: "📝", title: "Multiple Choice Quizzes", desc: "Classic 4-option questions, auto-graded with a clear explanation for every answer." },
  { icon: "🃏", title: "Flashcards", desc: "Flip cards to test recall and mark what you know — perfect for memorisation." },
  { icon: "✏️", title: "Fill in the Blank", desc: "Type the missing term to actively retrieve key facts instead of just recognising them." },
  { icon: "🔗", title: "Match Terms", desc: "Pair terms with their definitions in a fast, interactive matching grid." },
  { icon: "🎓", title: "Exam Mode", pro: true, desc: "Full mock exams with MCQ and written questions, graded by AI with feedback." },
  { icon: "💡", title: "AI Explanations", desc: "Every question comes with a concise reason why the correct answer is correct." },
  { icon: "📄", title: "PDF & Image Upload", desc: "Lecture slides, textbooks, handwritten notes or whiteboard photos — all supported." },
  { icon: "🌍", title: "Works in 20+ Languages", desc: "Generate and take quizzes in your language, from Spanish to Japanese to Arabic." },
];

const ROWS = [
  ["Daily quizzes", "3 / day", "Unlimited"],
  ["Multiple choice", true, true],
  ["Flashcards · Fill-in · Match", false, true],
  ["Questions per quiz", "Up to 20", "Up to 100"],
  ["File upload size", "5 MB", "Unlimited"],
  ["Exam Mode (AI-graded)", false, true],
  ["Ad-free experience", false, true],
  ["Multi-language quizzes", true, true],
];

function Cell({ v, pro }) {
  if (v === true) return <span className="yes">✓</span>;
  if (v === false) return <span className="no">—</span>;
  return <span className={pro ? "pro-col" : ""}>{v}</span>;
}

export default function Features() {
  usePageMeta("Features — Revyy", "Four quiz types, full exam simulation, and AI that understands your study material.");
  return (
    <>
      <section className="hero" style={{ padding: "84px 0 90px" }}>
        <div className="container">
          <span className="eyebrow">Features</span>
          <h1>Everything you need to study smarter</h1>
          <p className="hero-sub">Four quiz types, full exam simulation, and AI that understands your material.</p>
        </div>
      </section>

      <section className="section">
        <div className="container">
          <div className="grid grid-4">
            {FEATURES.map((f) => (
              <div key={f.title} className="card">
                <div className="card-icon">{f.icon}</div>
                <h3>
                  {f.title}
                  {f.pro && <span className="pro-tag">PRO</span>}
                </h3>
                <p>{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="section section-soft">
        <div className="container">
          <div className="section-head">
            <div className="section-label">Compare plans</div>
            <h2>Free vs Pro</h2>
            <p>Start free, upgrade when you need the full toolkit.</p>
          </div>
          <table className="compare">
            <thead>
              <tr><th>Feature</th><th>Free</th><th className="pro-col">Pro</th></tr>
            </thead>
            <tbody>
              {ROWS.map(([label, free, pro]) => (
                <tr key={label}>
                  <td>{label}</td>
                  <td><Cell v={free} /></td>
                  <td><Cell v={pro} pro /></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ textAlign: "center", marginTop: 36 }}>
            <Link to="/pricing" className="btn btn-primary btn-lg">See pricing →</Link>
          </div>
        </div>
      </section>
    </>
  );
}
