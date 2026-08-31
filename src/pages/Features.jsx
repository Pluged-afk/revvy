import { Link } from "react-router-dom";
import usePageMeta from "../lib/usePageMeta.js";
import AdSlot from "../components/AdSlot.jsx";
import Icon from "../components/Icon.jsx";
import { MOCK_EXAMS } from "../lib/mockExams.js";

// Real standardized-test roster, from the app itself (never a claim the product
// cannot back up).
const EXAM_ORDER = ["sat", "act", "psat", "gre", "gmat", "lsat", "mcat", "ucat"];
const EXAMS = EXAM_ORDER
  .map((id) => MOCK_EXAMS.find((e) => e.id === id))
  .filter(Boolean);

const FEATURES = [
  { icon: "list", title: "Multiple choice quizzes", desc: "Four-option questions graded the instant you answer, each with a short note on why the right answer is right. Free on every plan." },
  { icon: "layers", title: "Flashcards", desc: "Flip a card, test your recall, and mark what you knew. Best for definitions, dates and vocabulary." },
  { icon: "pencil", title: "Fill in the blank", desc: "Type the missing term instead of picking it, so you retrieve the fact rather than just recognising it." },
  { icon: "link", title: "Match terms", desc: "Pair terms with their definitions on a quick matching grid. A fast warm-up before a harder round." },
  { icon: "exam", title: "Custom exam mode", desc: "Turn your own notes into a timed paper with sections, multiple choice and written answers, then get a grade and a breakdown of where the marks went." },
  { icon: "trophy", title: "Standardized mock tests", desc: "Full mocks of the SAT, ACT, GRE and five other tests, with their real sections, timing and score scale. A Pro feature.", pro: true },
  { icon: "chat", title: "An explanation for every answer", desc: "A short, plain reason the correct answer is correct, so even a wrong guess teaches you something before you move on." },
  { icon: "target", title: "Difficulty that adapts", desc: "Practice quizzes read your recent results and shift the difficulty to match, so questions stay challenging without tipping into guesswork." },
  { icon: "repeat", title: "Spaced-repetition review", desc: "Every question you miss becomes a review card that comes back a day later, then a few days later, until it finally sticks." },
  { icon: "notes", title: "Fix your misses", desc: "After any quiz, re-drill only the questions you got wrong as a fresh mini-quiz. No new upload and it costs nothing against your daily limit." },
  { icon: "upload", title: "Upload almost anything", desc: "Lecture slides, a textbook PDF, handwritten notes, or a photo of a whiteboard. Revyy reads the text and quizzes you on it." },
  { icon: "play", title: "Lectures, audio and video", desc: "Upload a recording and Revyy transcribes it, then builds a quiz from what was actually said. A Pro feature.", pro: true },
  { icon: "layers", title: "Import from Quizlet", desc: "Bring an existing Quizlet set across without retyping: export it, paste it in, and study it as flashcards." },
  { icon: "globe", title: "20 languages", desc: "Generate and answer quizzes in your own language, from Spanish and French to Japanese, Hindi and Arabic." },
];

// Accurate side-by-side. `true`/`false` render a tick or a dash; strings show as-is.
const ROWS = [
  ["Questions per day", "50 (up to 70 with ads)", "250"],
  ["Multiple choice quizzes", true, true],
  ["Flashcards, fill-in and match", "With ads", true],
  ["Questions per quiz", "Up to 20", "Up to 100"],
  ["An explanation for every answer", true, true],
  ["Adaptive difficulty", true, true],
  ["Spaced-repetition review deck", true, true],
  ["Custom timed exams from your notes", "1 a day (with ads)", "Unlimited"],
  ["Standardized mock tests (SAT, ACT, GRE, and more)", false, "2 a day"],
  ["Upload PDFs, photos and text", true, true],
  ["File size limit", "5 MB (10 with ads)", "Unlimited"],
  ["Lecture audio and video, transcribed", false, true],
  ["Import from Quizlet", true, true],
  ["Quizzes in 20 languages", true, true],
  ["Ad-free", false, true],
];

function Cell({ v, pro }) {
  if (v === true) return <span className="yes"><Icon name="check" size={17} /></span>;
  if (v === false) return <span className="no" aria-label="Not included" style={{ display: "inline-block", width: 14, height: 2, background: "var(--faint)", borderRadius: 1, verticalAlign: "middle" }} />;
  return <span className={pro ? "pro-col" : ""}>{v}</span>;
}

export default function Features() {
  usePageMeta(
    "Revyy Features: Quiz Types, Exam Mode, Mock Tests and Uploads",
    "Four quiz types, custom timed exams, full mocks of the SAT, ACT, GRE and more, adaptive difficulty, spaced-repetition review, uploads from PDF, photo, audio or video, Quizlet import, and 20 languages."
  );
  return (
    <>
      <section className="hero" style={{ padding: "72px 0 32px" }}>
        <div className="container">
          <span className="eyebrow">Features</span>
          <h1>Everything you need to practise, in one place</h1>
          <p className="hero-sub">Four quiz types, custom timed exams, full standardized mock tests, and a review deck that keeps bringing back what you forget, all built from the material you upload.</p>
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

      {/* Real mock-test roster */}
      <section className="section section-soft">
        <div className="container">
          <div className="section-head">
            <div className="section-label">Standardized mocks</div>
            <h2>Eight real tests, built to spec</h2>
            <p>Each one matches the current paper: the right sections, question counts, timing and score scale. Every question is multiple choice, so a full mock marks itself and hands you a scaled score the moment you finish.</p>
          </div>
          <div className="exam-grid">
            {EXAMS.map((e) => (
              <div key={e.id} className="exam-card">
                <div className="exam-name">{e.name}</div>
                <div className="exam-blurb">{e.blurb}</div>
                <div className="exam-note">{e.note}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <AdSlot />

      <section className="section">
        <div className="container">
          <div className="section-head center">
            <div className="section-label">Compare plans</div>
            <h2>Free and Pro, side by side</h2>
            <p>Start free and stay free if that covers you. Move to Pro when you need more questions, unlimited exams, and the standardized mocks.</p>
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
