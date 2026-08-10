import { Link } from "react-router-dom";
import usePageMeta from "../lib/usePageMeta.js";
import AdSlot from "../components/AdSlot.jsx";
import Icon from "../components/Icon.jsx";

const FEATURES = [
  { icon: "list", title: "Multiple choice quizzes", desc: "Classic four-option questions, graded instantly, each with a short note on why the answer is right." },
  { icon: "layers", title: "Flashcards", desc: "Flip a card, test your recall, and mark what you knew. Good for definitions and vocabulary." },
  { icon: "pencil", title: "Fill in the blank", desc: "Type the missing term so you actually retrieve the fact instead of just recognising it." },
  { icon: "link", title: "Match terms", desc: "Pair terms with their definitions on a quick matching grid." },
  { icon: "exam", title: "Exam mode", desc: "Full mock exams with multiple choice and written questions, graded for you. One free exam a day, or unlimited custom papers on Pro." },
  { icon: "chat", title: "Explanations for every answer", desc: "A short reason the correct answer is correct, so even a wrong guess teaches you something." },
  { icon: "upload", title: "PDF and photo upload", desc: "Lecture slides, textbook pages, handwritten notes, or a photo of a whiteboard. Revyy reads them all." },
  { icon: "globe", title: "Works in 20+ languages", desc: "Generate and take quizzes in your own language, from Spanish to Japanese to Arabic." },
];

const ROWS = [
  ["Daily questions", "50 a day", "250 a day"],
  ["Multiple choice quizzes", true, true],
  ["Flashcards, fill-in and match", "With ads", true],
  ["Questions per quiz", "20 (50 with an ad)", "Up to 100"],
  ["Mock exams, graded", "1 a day (ad)", "Unlimited and custom"],
  ["File uploads", "5 MB (10 MB with an ad)", "Unlimited"],
  ["Ad-free", false, true],
  ["Quizzes in 20+ languages", true, true],
];

function Cell({ v, pro }) {
  if (v === true) return <span className="yes"><Icon name="check" size={17} /></span>;
  if (v === false) return <span className="no" aria-label="Not included" style={{ display: "inline-block", width: 14, height: 2, background: "var(--faint)", borderRadius: 1, verticalAlign: "middle" }} />;
  return <span className={pro ? "pro-col" : ""}>{v}</span>;
}

export default function Features() {
  usePageMeta(
    "Revyy Features: Quiz Types, Exam Mode and Uploads",
    "Four quiz types, mock exam simulation, PDF and photo upload, and 20+ languages. See how Revyy turns your own study material into practice."
  );
  return (
    <>
      <section className="hero" style={{ padding: "72px 0 32px" }}>
        <div className="container">
          <span className="eyebrow">Features</span>
          <h1>Four ways to practise, one place to do it</h1>
          <p className="hero-sub">Quizzes, flashcards, and full mock exams, all built from the material you upload.</p>
        </div>
      </section>

      <section className="section section-tight">
        <div className="container">
          <div className="grid grid-4">
            {FEATURES.map((f) => (
              <div key={f.title} className="card">
                <div className="card-icon"><Icon name={f.icon} size={26} stroke={1.5} /></div>
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

      <AdSlot />

      <section className="section section-soft">
        <div className="container">
          <div className="section-head center">
            <div className="section-label">Compare plans</div>
            <h2>Free and Pro, side by side</h2>
            <p>Start free. Move to Pro when you need more questions and unlimited exams.</p>
          </div>
          <table className="compare">
            <thead>
              <tr><th>What you get</th><th>Free</th><th className="pro-col">Pro</th></tr>
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
          <div style={{ textAlign: "center", marginTop: 34 }}>
            <Link to="/pricing" className="btn btn-primary btn-lg">See pricing <Icon name="arrow" size={18} /></Link>
          </div>
        </div>
      </section>
    </>
  );
}
