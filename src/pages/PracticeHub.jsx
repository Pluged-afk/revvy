import { Link } from "react-router-dom";
import usePageMeta from "../lib/usePageMeta.js";
import AdSlot from "../components/AdSlot.jsx";
import Icon from "../components/Icon.jsx";
import { getMock, mockTotalQuestions } from "../lib/mockExams.js";
import { EXAM_SEO, EXAM_SEO_ORDER } from "../data/examSeo.js";

// The /practice hub: one card per standardized test, each linking to its own
// prerendered landing page. Gives the exam pages an internal parent and gives
// visitors a single place to find "practice test for <my exam>".

const EXAMS = EXAM_SEO_ORDER
  .map((id) => ({ id, mock: getMock(id) }))
  .filter((e) => e.mock && EXAM_SEO[e.id]);

export default function PracticeHub() {
  usePageMeta(
    "Free Practice Tests: SAT, ACT, GRE, GMAT, LSAT, MCAT and More | Revyy",
    "Free online practice tests for eight standardized exams: SAT, ACT, PSAT, GRE, GMAT, LSAT, MCAT and UCAT. Real sections and scoring, timed, with an explanation for every question."
  );
  return (
    <>
      <section className="hero" style={{ padding: "72px 0 32px" }}>
        <div className="container">
          <span className="eyebrow">Practice tests</span>
          <h1>Free practice tests for the exams that matter</h1>
          <p className="hero-sub">Pick your test and practise in its real shape: the right sections, timing and score scale, every question marked instantly with a short explanation. Start free, no card.</p>
        </div>
      </section>

      <section className="section section-tight">
        <div className="container">
          <div className="exam-grid">
            {EXAMS.map(({ id, mock }) => (
              <Link key={id} to={`/practice/${id}`} className="exam-card" style={{ display: "block", textDecoration: "none", color: "inherit" }}>
                <div className="exam-name">{mock.name}</div>
                <div className="exam-blurb">{mock.blurb}</div>
                <div className="exam-note">{mockTotalQuestions(mock)} questions · {mock.note.split("·").pop().trim()}</div>
              </Link>
            ))}
          </div>
        </div>
      </section>

      <AdSlot />

      <section className="section">
        <div className="container">
          <div className="section-dark" style={{ borderRadius: 22, padding: "56px 44px" }}>
            <div className="cta-band">
              <h2>Not sitting a standardized test?</h2>
              <p>Revyy turns your own notes into practice quizzes and timed exams too, for any subject you are studying. Upload a page and see your first quiz in under a minute.</p>
              <Link to="/app" className="btn btn-light btn-lg">
                Make your first quiz <Icon name="arrow" size={18} />
              </Link>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
