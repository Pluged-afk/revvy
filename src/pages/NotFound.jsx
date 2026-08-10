import { Link } from "react-router-dom";
import usePageMeta from "../lib/usePageMeta.js";

export default function NotFound() {
  usePageMeta("Page not found · Revyy", "The page you are looking for does not exist.");
  return (
    <section className="section">
      <div className="container" style={{ textAlign: "center", maxWidth: 560, paddingTop: 40, paddingBottom: 40 }}>
        <div style={{ fontSize: 72, fontWeight: 700, fontFamily: "'Fraunces', Georgia, serif", color: "var(--clay)", lineHeight: 1 }}>404</div>
        <h1 style={{ marginTop: 16 }}>Page not found</h1>
        <p style={{ fontSize: 17, color: "var(--muted)", lineHeight: 1.6, margin: "12px auto 28px" }}>
          The page you are looking for does not exist, or it may have moved.
        </p>
        <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
          <Link to="/" className="btn btn-primary btn-lg">Back to home</Link>
          <Link to="/contact" className="btn btn-ghost btn-lg">Contact support</Link>
        </div>
      </div>
    </section>
  );
}
