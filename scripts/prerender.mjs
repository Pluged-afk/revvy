// Build-time pre-rendering. After `vite build` (client) and the SSR build,
// this renders every marketing/blog route to static HTML and writes it into
// dist/<route>/index.html — so crawlers (Google, AdSense) get real content
// instead of an empty <div id="root">. React still mounts and takes over on
// load. Vercel serves these static files before the SPA rewrite, so each URL
// resolves to its own prerendered page.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { render } from "../dist-ssr/entry-server.js";
import { POSTS } from "../src/data/posts.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "dist");
const SITE = "https://revyy.app";

const template = readFileSync(join(DIST, "index.html"), "utf8");

const esc = (s) => String(s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Marketing routes + metadata (mirrors each page's usePageMeta call).
const routes = [
  { path: "/",         title: "Revyy — AI Quiz Generator: Turn Notes & PDFs Into Study Quizzes", desc: "Free AI quiz generator for students. Upload a PDF, paste notes or snap a photo and turn any material into study quizzes, flashcards and practice exams in seconds." },
  { path: "/features", title: "Revyy Features — AI Quiz Maker, Flashcards & Exam Mode", desc: "Four quiz types, AI-graded exam simulation, PDF & image upload, and 20+ languages. See how Revyy turns your study material into quizzes." },
  { path: "/pricing",  title: "Revyy Pricing — Free AI Quiz Generator, or Pro €4.99/mo", desc: "Use Revyy's AI quiz generator free forever, or go Pro for €4.99/month for exam mode, all quiz types and no ads. Cancel anytime." },
  { path: "/about",    title: "About — Revyy", desc: "Revyy started as a personal tool to get ready for exams — built to test yourself before the real thing." },
  { path: "/contact",  title: "Contact — Revyy", desc: "Questions, feedback, or feature ideas? Get in touch with the Revyy team." },
  { path: "/blog",     title: "Study Guides & Revision Tips — Revyy Blog", desc: "Evidence-based study techniques, revision strategies and exam tips to help you learn more in less time." },
  { path: "/privacy",  title: "Privacy Policy — Revyy", desc: "How Revyy collects, uses, and protects your data." },
  { path: "/terms",    title: "Terms of Service — Revyy", desc: "The terms that govern your use of Revyy." },
];

// One route per blog post, with Article + Breadcrumb structured data.
for (const p of POSTS) {
  const url = `${SITE}/blog/${p.slug}`;
  const jsonld = {
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "BlogPosting", headline: p.title, description: p.description, url, mainEntityOfPage: url,
        datePublished: p.date, dateModified: p.date, image: `${SITE}/og-image.svg`,
        author: { "@type": "Organization", name: "Revyy", url: SITE },
        publisher: { "@type": "Organization", name: "Revyy", logo: { "@type": "ImageObject", url: `${SITE}/favicon.svg` } } },
      { "@type": "BreadcrumbList", itemListElement: [
        { "@type": "ListItem", position: 1, name: "Blog", item: `${SITE}/blog` },
        { "@type": "ListItem", position: 2, name: p.title, item: url } ] },
    ],
  };
  routes.push({
    path: `/blog/${p.slug}`, title: `${p.title} — Revyy`, desc: p.description,
    extraHead: `<script type="application/ld+json">${JSON.stringify(jsonld)}</script>`,
  });
}

function buildHtml({ path, title, desc, extraHead = "" }, appHtml) {
  const url = SITE + path;
  const setAttr = (re, value) => (m, a, b) => a + esc(value) + b;
  let html = template
    .replace("<!--ssr-outlet-->", () => appHtml)
    .replace(/<title>[\s\S]*?<\/title>/, () => `<title>${esc(title)}</title>`)
    .replace(/(<meta name="description" content=")[^"]*(")/, setAttr(null, desc))
    .replace(/(<link rel="canonical" href=")[^"]*(")/, setAttr(null, url))
    .replace(/(<meta property="og:title" content=")[^"]*(")/, setAttr(null, title))
    .replace(/(<meta property="og:description" content=")[^"]*(")/, setAttr(null, desc))
    .replace(/(<meta property="og:url" content=")[^"]*(")/, setAttr(null, url));
  if (extraHead) html = html.replace("</head>", () => `    ${extraHead}\n  </head>`);
  return html;
}

let ok = 0, failed = 0;
for (const r of routes) {
  try {
    const appHtml = render(r.path);
    const html = buildHtml(r, appHtml);
    const outPath = r.path === "/" ? join(DIST, "index.html") : join(DIST, r.path, "index.html");
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, html);
    ok++;
  } catch (e) {
    failed++;
    console.warn(`[prerender] skipped ${r.path}: ${e.message}`);
  }
}
console.log(`[prerender] wrote ${ok} pages${failed ? `, skipped ${failed}` : ""}.`);
