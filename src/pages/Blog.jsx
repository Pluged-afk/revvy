import { Link } from "react-router-dom";
import usePageMeta from "../lib/usePageMeta.js";
import AdSlot from "../components/AdSlot.jsx";
import Icon from "../components/Icon.jsx";
import { POSTS, readTime } from "../data/posts.js";

const fmtDate = (iso) =>
  new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

export default function Blog() {
  usePageMeta(
    "Study Guides and Revision Tips: The Revyy Blog",
    "Practical, evidence-based study techniques, revision strategies and exam tips to help you learn more in less time."
  );
  return (
    <>
      <section className="hero" style={{ padding: "72px 0 28px" }}>
        <div className="container">
          <span className="eyebrow">The blog</span>
          <h1>Notes on studying that actually works</h1>
          <p className="hero-sub">
            Short, practical write-ups on the study methods with real evidence behind them, and how
            to fit them into a normal week of revision.
          </p>
        </div>
      </section>

      <section className="section section-tight">
        <div className="container">
          <div className="post-list">
            {POSTS.map((p) => (
              <Link key={p.slug} to={`/blog/${p.slug}`} className="post-row">
                <div className="meta">{fmtDate(p.date)} · {readTime(p)} min read</div>
                <h2>{p.title}</h2>
                <p>{p.description}</p>
                <span className="link-arrow">Read the article <Icon name="arrow" size={16} /></span>
              </Link>
            ))}
          </div>
        </div>
      </section>

      <AdSlot />

      <section className="section section-soft">
        <div className="container">
          <div className="section-head center">
            <h2>Reading about it is a start. Testing yourself is the point.</h2>
            <p>Turn a page of your own notes into a quiz and put any of these techniques to work.</p>
          </div>
          <div style={{ textAlign: "center" }}>
            <Link to="/app" className="btn btn-primary btn-lg">Make a quiz from your notes <Icon name="arrow" size={18} /></Link>
          </div>
        </div>
      </section>
    </>
  );
}
