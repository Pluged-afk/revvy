import { useEffect } from "react";

// Sets the document <title> (and optional meta description) for a page,
// restoring nothing on unmount — the next page sets its own. Keeps the
// marketing site's per-page titles consistent without a router dependency.
export default function usePageMeta(title, description) {
  useEffect(() => {
    if (title) document.title = title;
    if (description) {
      let tag = document.querySelector('meta[name="description"]');
      if (!tag) {
        tag = document.createElement("meta");
        tag.setAttribute("name", "description");
        document.head.appendChild(tag);
      }
      tag.setAttribute("content", description);
    }
  }, [title, description]);
}
