import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";
import usePageMeta from "../lib/usePageMeta.js";
import AdSlot from "../components/AdSlot.jsx";
import Icon from "../components/Icon.jsx";
import { MOCK_EXAMS } from "../lib/mockExams.js";

// The real standardized-test roster, straight from the app so the marketing page
// can never claim a test the product does not actually build.
const EXAM_ORDER = ["sat", "act", "psat", "gre", "gmat", "lsat", "mcat", "ucat"];
const EXAMS = EXAM_ORDER
  .map((id) => MOCK_EXAMS.find((e) => e.id === id))
  .filter(Boolean)
  .map((e) => ({ name: e.name, blurb: e.blurb, note: e.note }));

// A faithful, static replica of the app's real quiz screen: same topbar,
// progress bar, difficulty/type pills, Fraunces question, lettered options,
// green "correct" state and explanation box. Shown as a small horizontal
// carousel of real example questions so the hero looks like the actual product.
const LETTERS = ["A", "B", "C", "D", "E", "F"];
const QUIZ_EXAMPLES = [
  {
    subject: "Biology", progress: "Question 3 of 10", pct: 30, answered: true, correct: 1,
    pills: ["Medium", "Multiple choice"],
    q: "Which organelle is the main site of ATP synthesis?",
    options: ["Nucleus", "Mitochondrion", "Ribosome", "Golgi apparatus"],
    explanation: "The mitochondrion produces most of the cell's ATP through oxidative phosphorylation along its inner membrane.",
  },
  {
    subject: "Modern History", progress: "Question 5 of 12", pct: 42, answered: false, correct: 0,
    pills: ["Hard", "Multiple choice"],
    q: "Which treaty formally ended the First World War?",
    options: ["Treaty of Versailles", "Treaty of Tordesillas", "Congress of Vienna", "Treaty of Ghent"],
  },
  {
    // A missed answer, to show the correction: your pick marked wrong, the
    // right answer revealed, with an explanation of why.
    subject: "Chemistry", progress: "Question 8 of 10", pct: 80, answered: true, correct: 1, chosen: 2,
    pills: ["Easy", "Multiple choice"],
    q: "What is the pH of a neutral aqueous solution at 25 °C?",
    options: ["0", "7", "14", "1"],
    explanation: "A pH of 14 is strongly basic. A neutral solution has equal H+ and OH- concentrations, which at 25 °C gives a pH of exactly 7.",
  },
];

function QuizCarousel() {
  const scroller = useRef(null);
  const [active, setActive] = useState(0);
  const n = QUIZ_EXAMPLES.length;
  // Read the currently-centred card straight from the DOM, so navigation never
  // depends on React state that might not have flushed yet.
  const currentIndex = () => {
    const el = scroller.current;
    if (!el) return 0;
    const kids = [...el.children];
    let best = 0, bestDist = Infinity;
    kids.forEach((c, i) => {
      const d = Math.abs(c.offsetLeft - el.scrollLeft);
      if (d < bestDist) { bestDist = d; best = i; }
    });
    return best;
  };
  const onScroll = () => setActive(currentIndex());
  const go = (i) => {
    const el = scroller.current;
    if (el && el.children[i]) el.scrollTo({ left: el.children[i].offsetLeft, behavior: "smooth" });
  };
  // Wrap around both ways so it never dead-ends (last -> first, first -> last).
  const next = () => go((currentIndex() + 1) % n);
  const prev = () => go((currentIndex() - 1 + n) % n);
  return (
    <div className="qwrap">
      <div className="qscroll" ref={scroller} onScroll={onScroll}>
        {QUIZ_EXAMPLES.map((ex, i) => (
          <div className="qcard" key={i} aria-hidden={i !== active}>
            <div className="qcard-top">
              <span className="subj">{ex.subject}</span>
              <span className="cnt">{ex.progress}</span>
            </div>
            <div className="qcard-pbar"><i style={{ width: `${ex.pct}%` }} /></div>
            <div className="qcard-body">
              <div className="qpills">{ex.pills.map((p) => <span className="qpill" key={p}>{p}</span>)}</div>
              <h3 className="qq">{ex.q}</h3>
              {ex.options.map((opt, oi) => {
                let cls = "qopt", mark = null;
                if (ex.answered) {
                  if (oi === ex.correct) { cls += " correct"; mark = "✓"; }
                  else if (oi === ex.chosen) { cls += " wrong"; mark = "✗"; }
                  else cls += " faded";
                }
                return (
                  <div className={cls} key={oi}>
                    <span className="k">{LETTERS[oi]}</span>
                    <span className="lbl">{opt}</span>
                    {mark && <span className="tick">{mark}</span>}
                  </div>
                );
              })}
              {ex.answered && (() => {
                const missed = ex.chosen != null && ex.chosen !== ex.correct;
                return (
                  <div className={"qexpl" + (missed ? " wrong" : "")}>
                    <b>{missed ? "Not quite" : "Correct"}</b>
                    <p>{ex.explanation}</p>
                  </div>
                );
              })()}
              <div className={"qnext" + (ex.answered ? "" : " off")}>
                {ex.answered ? "Next question" : "Select an answer"}
              </div>
            </div>
          </div>
        ))}
      </div>
      <div className="qnav">
        <button className="qarrow" onClick={prev} aria-label="Previous example">
          <Icon name="chevron" size={17} style={{ transform: "rotate(180deg)" }} />
        </button>
        <div className="qdots">
          {QUIZ_EXAMPLES.map((ex, i) => (
            <button key={i} className={i === active ? "on" : ""} onClick={() => go(i)} aria-label={`Show ${ex.subject} example`} />
          ))}
        </div>
        <button className="qarrow" onClick={next} aria-label="Next example">
          <Icon name="chevron" size={17} />
        </button>
      </div>
      <p className="qcap">Real example questions, exactly as the app generates them.</p>
    </div>
  );
}

const FEATURES = [
  {
    icon: "notes",
    title: "Questions from your material, not the internet",
    desc: "Revyy reads exactly what you upload and asks about that. If a fact is not in your notes, it will not turn up in your quiz.",
  },
  {
    icon: "exam",
    title: "Real exam formats, not a generic quiz",
    desc: "Build a timed exam from your own notes, or sit a full mock of the SAT, ACT, GRE and five other tests with their real sections, timing and scoring.",
  },
  {
    icon: "repeat",
    title: "Weak spots come back on their own",
    desc: "Miss a question and Revyy schedules it to return a day later, then a few days later, until you stop missing it.",
  },
  {
    icon: "target",
    title: "Difficulty that tracks how you are doing",
    desc: "Practice quizzes read your recent results and nudge the difficulty up or down, so you are neither bored nor buried.",
  },
];

const STEPS = [
  {
    n: 1,
    title: "Add your material",
    desc: "Drop in a PDF, paste your notes, snap a page, import a Quizlet set, or upload a lecture recording. Text, images, audio and video all work.",
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

// How the app adapts to each student. All real, all shipped.
const ADAPTS = [
  {
    title: "It remembers your material",
    desc: "Upload the same subject again and Revyy builds on what it already made, so a topic you keep studying gets deeper, not repetitive.",
  },
  {
    title: "Fix your misses in one tap",
    desc: "After a quiz, drill only the questions you got wrong as a fresh mini-quiz. No new upload, no waiting.",
  },
  {
    title: "A review deck that schedules itself",
    desc: "Every miss becomes a review card that resurfaces on a spaced schedule, the method shown to beat rereading for long-term recall.",
  },
  {
    title: "Study in your own language",
    desc: "Generate and answer quizzes in any of 20 languages, from Spanish and French to Japanese, Hindi and Arabic.",
  },
];

const FREE_PERKS = [
  "50 questions a day",
  "Multiple choice, always free",
  "Flashcards, fill-in and match (with ads)",
  "One custom exam a day (with ads)",
  "Up to 20 questions per quiz",
  "Files up to 5 MB",
];
const PRO_PERKS = [
  "250 questions a day",
  "All four quiz types, no ads",
  "Unlimited custom exams from your notes",
  "Full mock tests: SAT, ACT, GRE and 5 more",
  "Up to 100 questions per quiz",
  "Unlimited uploads, plus lecture audio and video",
];

const TRUST = [
  { icon: "tag", label: "Free to start, no card" },
  { icon: "camera", label: "PDFs, notes, lectures, Quizlet" },
  { icon: "globe", label: "20 languages" },
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
                Upload a PDF, paste your notes, photograph a page, import a
                Quizlet set, or drop in a lecture recording. Revyy writes
                practice questions and full mock exams from your own material,
                then brings back whatever you get wrong until you know it.
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

            {/* Faithful replica of the app's quiz screen, as a carousel */}
            <QuizCarousel />
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

      {/* Standardized mock exams (the real roster, from MOCK_EXAMS) */}
      <section className="section">
        <div className="container">
          <div className="section-head">
            <div className="section-label">Sit the real thing first</div>
            <h2>Full mock exams for eight standardized tests</h2>
            <p>
              Each mock matches the real paper: the right sections, question
              counts, timing and score scale. Every question is multiple choice,
              so the whole paper is marked the moment you finish and you get a
              scaled score, not just a percentage.
            </p>
          </div>
          <div className="exam-grid">
            {EXAMS.map((e) => (
              <div key={e.name} className="exam-card">
                <div className="exam-name">{e.name}</div>
                <div className="exam-blurb">{e.blurb}</div>
                <div className="exam-note">{e.note}</div>
              </div>
            ))}
          </div>
          <p className="hero-note" style={{ marginTop: 22 }}>
            Mock tests are a Pro feature, up to two full papers a day. Timed exams
            built from your own notes are on every plan.
          </p>
        </div>
      </section>

      {/* How it adapts to each student */}
      <section className="section section-soft">
        <div className="container">
          <div className="section-head">
            <div className="section-label">Personal by design</div>
            <h2>It learns how you study, not just what you upload</h2>
            <p>
              Revyy keeps a private model of what you have practised and what you
              keep getting wrong, then aims your next session at exactly that.
            </p>
          </div>
          <div className="spec-list">
            {ADAPTS.map((a) => (
              <div key={a.title} className="spec-item">
                <h3>{a.title}</h3>
                <p>{a.desc}</p>
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
