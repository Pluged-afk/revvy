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
  const { user, isPro, username } = useAuth();
  const accountName = username || user?.email?.split("@")[0] || "Account";
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
          {/* CTA lives inside the menu on mobile (hidden on desktop via CSS). */}
          <Link to="/app" className="nav-menu-cta" onClick={() => setOpen(false)}>
            {user ? "Open App →" : "Try Revyy Free"}
          </Link>
        </div>

        <div className="nav-right">
          {user ? (
            <Link to="/app" className="nav-account" title={accountName}>
              <span className="nav-avatar">
                {accountName.charAt(0).toUpperCase()}
                {user.image && <img src={user.image} alt="" onError={(e) => e.currentTarget.remove()} />}
              </span>
              <span className="nav-account-name">{accountName}</span>
            </Link>
          ) : (
            <Link to="/app" className="btn btn-primary">Try Revyy Free</Link>
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
