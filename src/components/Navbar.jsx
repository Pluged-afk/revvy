import { useState } from "react";
import { Link, NavLink } from "react-router-dom";
import RevyyMark from "./Logo.jsx";
import { DevBadge } from "../context/DevContext.jsx";
import { useAuth } from "../context/AuthContext.jsx";

const LINKS = [
  { to: "/", label: "Home", end: true },
  { to: "/features", label: "Features" },
  { to: "/pricing", label: "Pricing" },
  { to: "/blog", label: "Blog" },
  { to: "/about", label: "About" },
  { to: "/contact", label: "Contact" },
];

export default function Navbar() {
  const [open, setOpen] = useState(false);
  const { user, isPro } = useAuth();
  return (
    <nav className="nav">
      <div className="container nav-inner">
        <Link to="/" className="nav-logo" onClick={() => setOpen(false)}>
          <RevyyMark /> Revyy
          {isPro && <span className="nav-pro-badge">PRO</span>}
        </Link>
        <DevBadge />


        <div className={`nav-links ${open ? "open" : ""}`}>
          {LINKS.map((l) => (
            <NavLink
              key={l.to}
              to={l.to}
              end={l.end}
              onClick={() => setOpen(false)}
              className={({ isActive }) => (isActive ? "active" : "")}
            >
              {l.label}
            </NavLink>
          ))}
        </div>

        <div className="nav-right">
          {user ? (
            <Link to="/app" className="btn btn-primary">Open App →</Link>
          ) : (
            <Link to="/signup" className="btn btn-primary">Try Revyy Free</Link>
          )}
          <button
            className="nav-toggle"
            aria-label="Toggle menu"
            onClick={() => setOpen((o) => !o)}
          >
            {open ? "✕" : "☰"}
          </button>
        </div>
      </div>
    </nav>
  );
}
