import { Link } from "react-router-dom";
import usePageMeta from "../lib/usePageMeta.js";
import AdSlot from "../components/AdSlot.jsx";
import { POSTS } from "../data/posts.js";

const fmtDate = (iso) =>
  new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

export default function Blog() {
  usePageMeta(
    "Study Guides & Revision Tips — Revyy Blog",
    "Evidence-based study techniques, revision strategies and exam tips to help you learn more in less time."
  );
  return (
    <>
      <section className="hero" style={{ padding: "84px 0 70px" }}>
        <div className="container">
          <span className="eyebrow">Blog</span>
          <h1>Study smarter, not longer</h1>
          <p className="hero-sub">
            Evidence-based study techniques, revision strategies and exam tips — written to help
            you learn more in less time.
          </p>
        </div>
      </section>

      <section className="section">
        <div className="container">
          <div className="grid grid-3">
            {POSTS.map((p) => (
              <Link key={p.slug} to={`/blog/${p.slug}`} className="card" style={{ textDecoration: "none" }}>
                <div className="section-label" style={{ marginBottom: 10 }}>
                  {fmtDate(p.date)} · {p.readMins} min read
                </div>
                <h3>{p.title}</h3>
                <p>{p.description}</p>
                <span className="link-arrow" style={{ marginTop: "auto" }}>Read more →</span>
              </Link>
            ))}
          </div>
        </div>
      </section>

      <AdSlot />

      <section className="section section-soft">
        <div className="container">
          <div className="section-head">
            <h2>Put these techniques into practice</h2>
            <p>Turn your own notes into active-recall quizzes in seconds with Revyy.</p>
          </div>
          <div style={{ textAlign: "center" }}>
            <Link to="/app" className="btn btn-primary btn-lg">Try Revyy Free →</Link>
          </div>
        </div>
      </section>
    </>
  );
}
