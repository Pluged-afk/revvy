// Presentational leaf components extracted from StudyQuiz.jsx (avatars, badges,
// rank pill, streak flame). Pure, no hooks; imported back verbatim.
import Icon from "../components/Icon.jsx";
import { RANKS, BADGE_BY_ID } from "../lib/badges.js";

// Round initial-letter avatar used across friends + groups (no external image).
export function AvatarInitial({ name, size = 34 }) {
  return (
    <span style={{ width: size, height: size, borderRadius: "50%", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "var(--color-sel-tint)", color: "var(--color-accent)", fontSize: Math.round(size * 0.42), fontWeight: 700 }}>
      {String(name || "?").charAt(0).toUpperCase()}
    </span>
  );
}

// colored icon "medallion": a tinted circle with the icon in its accent color,
// so each home card gets its own identity instead of a row of flat line icons.
// two-tone gradient + faint same-hue ring, reads in both themes.
export function Medallion({ color = "#4338ca", size = 38, children }) {
  return (
    <span style={{ flexShrink: 0, width: size, height: size, borderRadius: 12, background: `linear-gradient(140deg, ${color}30, ${color}12)`, boxShadow: `inset 0 0 0 1px ${color}33`, color, display: "inline-flex", alignItems: "center", justifyContent: "center" }} aria-hidden="true">
      {children}
    </span>
  );
}

// A small red count bubble for unread notifications.
export function NotifBubble({ n, style }) {
  if (!n) return null;
  return <span style={{ minWidth: 18, height: 18, padding: "0 5px", borderRadius: 9, background: "#ef4444", color: "#fff", fontSize: 11, fontWeight: 800, display: "inline-flex", alignItems: "center", justifyContent: "center", lineHeight: 1, ...style }}>{n > 99 ? "99+" : n}</span>;
}

// A group's "pic": a colored rounded-square monogram, hue derived from the name
// so every group looks distinct without needing an uploaded image.
export function GroupAvatar({ name, size = 40 }) {
  const colors = ["#4338ca", "#0d9488", "#b45309", "#7c3aed", "#2563eb", "#0f9d5a", "#d4537e", "#d97706"];
  const s = String(name || "?"); let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  const c = colors[h % colors.length];
  return (
    <span aria-hidden="true" style={{ width: size, height: size, borderRadius: Math.round(size * 0.3), flexShrink: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", background: c + "22", color: c, fontWeight: 800, fontSize: Math.round(size * 0.42) }}>
      {s.charAt(0).toUpperCase()}
    </span>
  );
}

// A streak flame that gets HOTTER as the count grows: bigger glow, a warmer
// colour (amber -> orange -> red), and a livelier flicker. The number rides
// alongside so a glance reads both the streak and its intensity.
export function StreakFlame({ count = 0, size = 22, showZero = false }) {
  const n = Math.max(0, Math.round(count));
  if (!n && !showZero) return null;
  const heat = Math.min(1, n / 30);
  const glow = 3 + Math.round(heat * 15);
  const color = n >= 30 ? "#ef4444" : n >= 14 ? "#f97316" : n >= 7 ? "#fb923c" : "#f59e0b";
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
      <span aria-hidden="true" className={n >= 7 ? "rv-flame rv-flame-hot" : "rv-flame"} style={{ fontSize: size, lineHeight: 1, filter: `drop-shadow(0 0 ${glow}px ${color}${n >= 7 ? "cc" : "88"})` }}>🔥</span>
      <span style={{ fontWeight: 800, fontFamily: "monospace", color, fontSize: Math.round(size * 0.72) }}>{n}</span>
    </span>
  );
}

// A rank tier pill (the public "status"), self-contained so it reads on any
// background. Hidden for a missing/negative tier.
export function RankPill({ index, t, small = false }) {
  if (index == null || index < 0 || !RANKS[index]) return null;
  const r = RANKS[index];
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, background: r.color + "22", color: r.color, fontSize: small ? 10 : 11, fontWeight: 800, padding: small ? "1px 7px" : "2px 9px", borderRadius: 20, whiteSpace: "nowrap", lineHeight: 1.4 }}>
      <Icon name={r.icon} size={small ? 12 : 13} stroke={2.1} />{(t && t["rank_" + r.key]) || r.name}
    </span>
  );
}

// The equipped-badge glyph, with the badge's localized name as a tooltip.
export function BadgeGlyph({ id, size = 15, t }) {
  const b = BADGE_BY_ID[id]; if (!b) return null;
  return <span title={(t && t["badge_" + id]) || b.name} aria-hidden="true" style={{ fontSize: size, lineHeight: 1 }}>{b.emoji}</span>;
}

// Rank pill + equipped badge glyph, shown next to a public username.
export function Flair({ rank, badge, t, small }) {
  if ((rank == null || rank < 0) && !badge) return null;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
      <RankPill index={rank} t={t} small={small} />
      {badge && <BadgeGlyph id={badge} size={small ? 14 : 15} t={t} />}
    </span>
  );
}
