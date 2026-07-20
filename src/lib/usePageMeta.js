import { useEffect } from "react";

const SITE = "https://revyy.app";

// Upsert a <meta> tag by its name or property attribute.
function setMeta(attr, key, content) {
  if (!content) return;
  let tag = document.head.querySelector(`meta[${attr}="${key}"]`);
  if (!tag) {
    tag = document.createElement("meta");
    tag.setAttribute(attr, key);
    document.head.appendChild(tag);
  }
  tag.setAttribute("content", content);
}

// Sets the document <title>, meta description, canonical URL and the social
// (Open Graph / Twitter) tags for the current page. Because the site is a
// client-rendered SPA, this keeps per-route metadata correct for crawlers that
// execute JavaScript and for links shared to social platforms.
export default function usePageMeta(title, description, image) {
  useEffect(() => {
    const url = SITE + window.location.pathname;
    const img = image || `${SITE}/og-image.svg`;

    if (title) document.title = title;
    if (description) setMeta("name", "description", description);

    // Canonical URL for this route.
    let canonical = document.head.querySelector('link[rel="canonical"]');
    if (!canonical) {
      canonical = document.createElement("link");
      canonical.setAttribute("rel", "canonical");
      document.head.appendChild(canonical);
    }
    canonical.setAttribute("href", url);

    // Open Graph
    setMeta("property", "og:title", title);
    setMeta("property", "og:description", description);
    setMeta("property", "og:url", url);
    setMeta("property", "og:image", img);

    // Twitter
    setMeta("name", "twitter:title", title);
    setMeta("name", "twitter:description", description);
    setMeta("name", "twitter:image", img);
  }, [title, description, image]);
}
