import { useEffect } from "react";
import { Link, useParams } from "react-router-dom";
import usePageMeta from "../lib/usePageMeta.js";
import AdSlot from "../components/AdSlot.jsx";
import Icon from "../components/Icon.jsx";
import { getPost, readTime, POSTS } from "../data/posts.js";
import { EXAM_SEO } from "../data/examSeo.js";
import { getMock } from "../lib/mockExams.js";

const SITE = "https://revyy.app";

// Blog slug -> exam id, so an exam study guide can point readers straight to its
// matching practice test (and Google sees the two pages cross-linked).
const GUIDE_TO_EXAM = Object.fromEntries(
  Object.entries(EXAM_SEO).map(([id, s]) => [s.guide, id])
);

// Inject (and keep updated) Article + Breadcrumb structured data for the post
// so Google can show it as a rich result. Removed when leaving the page.
function useArticleJsonLd(post) {
  useEffect(() => {
    if (!post) return;
    const url = `${SITE}/blog/${post.slug}`;
    const data = {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "BlogPosting",
          "headline": post.title,
          "description": post.description,
          "url": url,
          "mainEntityOfPage": url,
          "datePublished": post.date,
          "dateModified": post.date,
          "image": `${SITE}/og-image.png`,
          "author": { "@type": "Person", "name": "Plug", "url": `${SITE}/about` },
          "publisher": {
            "@type": "Organization",
            "name": "Revyy",
            "logo": { "@type": "ImageObject", "url": `${SITE}/favicon.svg` },
          },
        },
        {
          "@type": "BreadcrumbList",
          "itemListElement": [
            { "@type": "ListItem", "position": 1, "name": "Blog", "item": `${SITE}/blog` },
            { "@type": "ListItem", "position": 2, "name": post.title, "item": url },
          ],
        },
      ],
    };
    let tag = document.getElementById("article-jsonld");
    if (!tag) {
      tag = document.createElement("script");
      tag.type = "application/ld+json";
      tag.id = "article-jsonld";
      document.head.appendChild(tag);
    }
    tag.textContent = JSON.stringify(data);
    return () => { document.getElementById("article-jsonld")?.remove(); };
  }, [post]);
}

const fmtDate = (iso) =>
  new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

function Block({ block }) {
  if (block.t === "h2") return <h2>{block.c}</h2>;
  if (block.t === "ul")
    return (
      <ul>
        {block.items.map((it, i) => (
          <li key={i}>{it}</li>
        ))}
      </ul>
    );
  return <p>{block.c}</p>;
}

export default function BlogPost() {
  const { slug } = useParams();
  const post = getPost(slug);

  usePageMeta(
    post ? `${post.title} · Revyy` : "Article not found · Revyy",
    post ? post.description : "The article you are looking for could not be found."
  );
  useArticleJsonLd(post);

  if (!post) {
    return (
      <section className="section">
        <div className="container prose" style={{ textAlign: "center" }}>
          <h1>Article not found</h1>
          <p>We could not find that article. It may have moved or been removed.</p>
          <Link to="/blog" className="btn btn-primary">Back to the blog</Link>
        </div>
      </section>
    );
  }

  // Suggest a few other articles to read next.
  const more = POSTS.filter((p) => p.slug !== post.slug).slice(0, 3);

  // If this is an exam study guide, offer its matching practice test.
  const examId = GUIDE_TO_EXAM[post.slug];
  const examMock = examId ? getMock(examId) : null;

  return (
    <>
      <article className="section section-tight">
        <div className="container article">
          <div style={{ marginBottom: 20 }}>
            <Link to="/blog" className="link-arrow" style={{ color: "var(--muted)" }}>All articles</Link>
          </div>
          <div className="article-meta">
            <span>{fmtDate(post.date)}</span>
            <span aria-hidden="true">·</span>
            <span>{readTime(post)} min read</span>
            <span aria-hidden="true">·</span>
            <span className="byline">by Plug</span>
          </div>
          <h1>{post.title}</h1>
          <p className="lead">{post.description}</p>
          <hr className="divider" />

          {post.body.map((block, i) => (
            <Block key={i} block={block} />
          ))}

          {examMock && (
            <div style={{ marginTop: 32, padding: "22px 24px", background: "var(--paper-2)", border: "1px solid var(--line)", borderRadius: "var(--radius)" }}>
              <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: ".4px", textTransform: "uppercase", color: "var(--indigo)", marginBottom: 6 }}>Ready to practise?</div>
              <p style={{ margin: "0 0 14px", fontSize: 15.5, color: "var(--ink-soft)", lineHeight: 1.6 }}>
                Put this into practice with a free {examMock.name} practice test, built to the real format with an explanation on every question.
              </p>
              <Link to={`/practice/${examId}`} className="btn btn-primary">
                Try the {examMock.name} practice test <Icon name="arrow" size={17} />
              </Link>
            </div>
          )}

          <div style={{ marginTop: 40 }}>
            <Link to="/app" className="btn btn-primary btn-lg">Turn your notes into a quiz <Icon name="arrow" size={18} /></Link>
          </div>
        </div>
      </article>

      <AdSlot />

      <section className="section section-soft">
        <div className="container">
          <div className="section-head">
            <div className="section-label">Read next</div>
            <h2>More on studying well</h2>
          </div>
          <div className="more-grid">
            {more.map((p) => (
              <Link key={p.slug} to={`/blog/${p.slug}`} className="card" style={{ textDecoration: "none", display: "flex", flexDirection: "column" }}>
                <div className="meta" style={{ fontSize: 13, color: "var(--muted)", marginBottom: 10 }}>{readTime(p)} min read</div>
                <h3>{p.title}</h3>
                <p style={{ marginBottom: 12 }}>{p.description}</p>
                <span className="link-arrow" style={{ marginTop: "auto" }}>Read the article <Icon name="arrow" size={16} /></span>
              </Link>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}
