import { Link, useParams, Navigate } from "react-router-dom";
import usePageMeta from "../lib/usePageMeta.js";
import AdSlot from "../components/AdSlot.jsx";
import Icon from "../components/Icon.jsx";
import { getMock, mockTotalMinutes, mockTotalQuestions } from "../lib/mockExams.js";
import { EXAM_SEO, EXAM_SEO_ORDER } from "../data/examSeo.js";

// A dedicated, prerendered landing page per standardized test, at /practice/:exam.
// It targets the searches people type when they want to SIT a practice test
// ("free SAT practice test", "GRE mock exam online"), then sends them into the
// app. All the test specifics are read live from lib/mockExams.js so the page
// can never claim a section count or score scale the product does not build.

// Minutes -> a human duration like "2 h 14 min" or "88 min".
function fmtDuration(mins) {
  if (mins < 90) return `${mins} min`;
  const h = Math.floor(mins / 60), m = mins % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

const STEPS = [
  { icon: "upload", title: "Add your material or pick the format", desc: "Paste your notes, upload a PDF or photo, or just start a practice set in the exam's own style." },
  { icon: "list", title: "Practise timed, with explanations", desc: "Answer questions across the real difficulty range and see why each answer is right the moment you respond." },
  { icon: "repeat", title: "Come back to what you miss", desc: "Every wrong answer becomes a review card that returns on a spaced schedule until it finally sticks." },
];

export default function ExamPage() {
  const { exam } = useParams();
  const seo = EXAM_SEO[exam];
  const mock = getMock(exam);

  // Called unconditionally (rules of hooks); no-ops when there is no match.
  usePageMeta(seo?.title, seo?.desc);

  // Unknown or non-landing exam id: send to the hub rather than a blank page.
  if (!seo || !mock) return <Navigate to="/practice" replace />;

  const totalQ = mockTotalQuestions(mock);
  const totalMin = mockTotalMinutes(mock);
  const others = EXAM_SEO_ORDER.filter((id) => id !== exam && EXAM_SEO[id] && getMock(id));

  return (
    <>
      <section className="hero" style={{ padding: "72px 0 28px" }}>
        <div className="container">
          <div style={{ maxWidth: 760 }}>
            <span className="eyebrow">Practice tests</span>
            <h1>{seo.h1}</h1>
            <p className="hero-sub">{seo.lede}</p>
            <div className="hero-btns">
              <Link to="/app" className="btn btn-primary btn-lg">
                Start practising free <Icon name="arrow" size={18} />
              </Link>
              <Link to={`/blog/${seo.guide}`} className="btn btn-ghost btn-lg">
                Read the study guide
              </Link>
            </div>
            <p className="hero-note">No credit card. Free to start, in {mock.name === "MCAT" ? "seconds" : "under a minute"}.</p>
          </div>
        </div>
      </section>

      {/* Real test structure, straight from the app's mock spec */}
      <section className="section section-tight">
        <div className="container">
          <div className="section-head">
            <div className="section-label">{mock.name} at a glance</div>
            <h2>What the {mock.name} looks like</h2>
            <p>{mock.note}. That is {totalQ} questions across {mock.sections.length} section{mock.sections.length > 1 ? "s" : ""} in about {fmtDuration(totalMin)}. Revyy builds practice in this exact shape.</p>
          </div>
          <table className="compare">
            <thead>
              <tr><th>Section</th><th>Questions</th><th>Time</th></tr>
            </thead>
            <tbody>
              {mock.sections.map((s) => (
                <tr key={s.id}>
                  <td>{s.name}</td>
                  <td>{s.count}</td>
                  <td>{s.minutes} min</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Exam-specific context */}
      <section className="section section-soft">
        <div className="container">
          <div className="section-head">
            <div className="section-label">Why practise here</div>
            <h2>Practice that matches the real {mock.name}</h2>
          </div>
          <div style={{ maxWidth: 760 }}>
            {seo.body.map((para, i) => (
              <p key={i} style={{ fontSize: 17, lineHeight: 1.7, color: "var(--ink-soft)", margin: i ? "16px 0 0" : 0 }}>{para}</p>
            ))}
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className="section section-tight">
        <div className="container">
          <div className="section-head">
            <div className="section-label">How it works</div>
            <h2>From a blank screen to a scored practice run</h2>
          </div>
          <div className="steps">
            {STEPS.map((s, i) => (
              <div key={s.title} className="step">
                <div className="step-num">{i + 1}</div>
                <h3>{s.title}</h3>
                <p>{s.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <AdSlot />

      {/* FAQ (mirrored as FAQPage structured data in the prerendered HTML) */}
      <section className="section">
        <div className="container">
          <div className="section-head">
            <div className="section-label">FAQ</div>
            <h2>{mock.name} practice, answered</h2>
          </div>
          <div className="faq" style={{ margin: "0 auto" }}>
            {seo.faqs.map((f) => (
              <div key={f.q} className="faq-item">
                <h3>{f.q}</h3>
                <p>{f.a}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Related exams: internal linking + lower bounce */}
      <section className="section section-soft section-tight">
        <div className="container">
          <div className="section-head">
            <div className="section-label">Other tests</div>
            <h2>Practise another exam</h2>
          </div>
          <div className="exam-grid">
            {others.map((id) => {
              const m = getMock(id);
              return (
                <Link key={id} to={`/practice/${id}`} className="exam-card" style={{ display: "block", textDecoration: "none", color: "inherit" }}>
                  <div className="exam-name">{m.name}</div>
                  <div className="exam-blurb">{m.blurb}</div>
                  <div className="exam-note">Free practice test</div>
                </Link>
              );
            })}
          </div>
        </div>
      </section>

      {/* Final CTA */}
      <section className="section">
        <div className="container">
          <div className="section-dark" style={{ borderRadius: 22, padding: "56px 44px" }}>
            <div className="cta-band">
              <h2>Start your {mock.name} practice now</h2>
              <p>Answer your first questions in under a minute, with an explanation on every one. No card, no commitment.</p>
              <Link to="/app" className="btn btn-light btn-lg">
                Start practising free <Icon name="arrow" size={18} />
              </Link>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
