import { Link } from "react-router-dom";
import RevyyMark from "./Logo.jsx";

export default function Footer() {
  return (
    <footer className="footer">
      <div className="container">
        <div className="footer-top">
          <div className="footer-brand">
            <span className="nav-logo"><RevyyMark /> Revyy</span>
            <p>Revyy turns your own notes into quizzes and mock exams, then keeps bringing back whatever you get wrong until exam day.</p>
            <div className="footer-tagline">A small tool made to make revision less of a slog.</div>
          </div>

          <div className="footer-col">
            <h4>Product</h4>
            <Link to="/features">Features</Link>
            <Link to="/pricing">Pricing</Link>
            <Link to="/app">Try Revyy</Link>
          </div>

          <div className="footer-col">
            <h4>Company</h4>
            <Link to="/about">About</Link>
            <Link to="/blog">Blog</Link>
            <Link to="/contact">Contact</Link>
          </div>

          <div className="footer-col">
            <h4>Legal</h4>
            <Link to="/privacy">Privacy Policy</Link>
            <Link to="/terms">Terms of Service</Link>
          </div>
        </div>

        <div className="footer-bottom">
          <span>© {new Date().getFullYear()} Revyy. All rights reserved.</span>
          <div className="legal-links">
            <Link to="/privacy">Privacy Policy</Link>
            <Link to="/terms">Terms of Service</Link>
          </div>
        </div>
      </div>
    </footer>
  );
}
