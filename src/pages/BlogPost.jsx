import { useEffect } from "react";
import { Link, useParams } from "react-router-dom";
import usePageMeta from "../lib/usePageMeta.js";
import AdSlot from "../components/AdSlot.jsx";
import { getPost, POSTS } from "../data/posts.js";

const SITE = "https://revyy.app";

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
          "image": `${SITE}/og-image.svg`,
          "author": { "@type": "Organization", "name": "Revyy", "url": SITE },
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
    post ? `${post.title} — Revyy` : "Article not found — Revyy",
    post ? post.description : "The article you're looking for could not be found."
  );
  useArticleJsonLd(post);

  if (!post) {
    return (
      <section className="section">
        <div className="container prose" style={{ textAlign: "center" }}>
          <h1>Article not found</h1>
          <p>We couldn't find that article. It may have moved or been removed.</p>
          <Link to="/blog" className="btn btn-primary">← Back to the blog</Link>
        </div>
      </section>
    );
  }

  // Suggest a few other articles to read next.
  const more = POSTS.filter((p) => p.slug !== post.slug).slice(0, 3);

  return (
    <>
      <article className="section">
        <div className="container prose">
          <div style={{ marginBottom: 18 }}>
            <Link to="/blog" className="link-arrow">← All articles</Link>
          </div>
          <div className="section-label" style={{ marginBottom: 12 }}>
            {fmtDate(post.date)} · {post.readMins} min read
          </div>
          <h1>{post.title}</h1>
          <p className="lead">{post.description}</p>

          {post.body.map((block, i) => (
            <Block key={i} block={block} />
          ))}

          <div style={{ marginTop: 44, textAlign: "center" }}>
            <Link to="/app" className="btn btn-primary btn-lg">Turn your notes into a quiz →</Link>
          </div>
        </div>
      </article>

      <AdSlot />

      <section className="section section-soft">
        <div className="container">
          <div className="section-head">
            <h2>Keep reading</h2>
          </div>
          <div className="grid grid-3">
            {more.map((p) => (
              <Link key={p.slug} to={`/blog/${p.slug}`} className="card" style={{ textDecoration: "none" }}>
                <div className="section-label" style={{ marginBottom: 10 }}>{p.readMins} min read</div>
                <h3>{p.title}</h3>
                <p>{p.description}</p>
                <span className="link-arrow" style={{ marginTop: "auto" }}>Read more →</span>
              </Link>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}
