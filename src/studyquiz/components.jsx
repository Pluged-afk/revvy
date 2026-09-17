// Presentational leaf components extracted from StudyQuiz.jsx (avatars, badges,
// rank pill, streak flame). Pure, no hooks; imported back verbatim.
import Icon from "../components/Icon.jsx";
import { RANKS, BADGE_BY_ID, streakTier } from "../lib/badges.js";

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
// The streak flame. A line-drawn SVG flame (not emoji) that grows bigger and
// more aggressive the longer the streak: it scales up in size, deepens from
// amber through orange to red, thickens its outline and throws a hotter glow.
// The day count sits next to it in a small monospace label. `showCount={false}`
// draws just the flame (for callers that render their own number/label after).
export function StreakFlame({ count = 0, size = 22, showZero = false, showCount = true }) {
  const n = Math.max(0, Math.round(count));
  if (!n && !showZero) return null;
  const tier = streakTier(n);                             // icon + heat colour + effect level
  const heat = Math.min(1, n / 90);                       // ramps to full over ~3 months
  const flameSize = Math.round(size * (1 + heat * 0.6));   // up to ~1.6x bigger
  const stroke = 1.5 + heat;                              // bolder outline as it heats
  const color = tier.color;
  const fx = tier.fx || 0;                                // 0 = calm, 1..3 = animated glow
  // Animated tiers get their pulsing glow from CSS (via --fc / --fgmax); calm
  // tiers keep a soft static glow (none at all on a 0-day, unlit flame).
  const flameStyle = fx
    ? { display: "inline-flex", color, "--fc": color, "--fgmax": fx >= 3 ? "18px" : fx === 2 ? "13px" : "9px" }
    : { display: "inline-flex", color, filter: n ? `drop-shadow(0 0 ${2 + Math.round(heat * 12)}px ${color}${n >= 14 ? "cc" : "88"})` : "none" };
  const animClass = fx >= 3 ? "rv-flame-anim lvl3" : fx === 2 ? "rv-flame-anim lvl2" : fx === 1 ? "rv-flame-anim" : undefined;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
      <span aria-hidden="true" className={animClass} style={flameStyle}>
        <Icon name={tier.icon} size={flameSize} stroke={stroke} />
      </span>
      {showCount && <span style={{ fontWeight: 800, fontFamily: "monospace", color, fontSize: Math.round(size * 0.66) }}>{n}</span>}
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

export function Logo({ size=28 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg" style={{flexShrink:0}}>
      <rect width="28" height="28" rx="8" fill="url(#lg)"/>
      <defs>
        <linearGradient id="lg" x1="0" y1="0" x2="28" y2="28" gradientUnits="userSpaceOnUse">
          <stop stopColor="#6366f1"/>
          <stop offset="1" stopColor="#4338ca"/>
        </linearGradient>
      </defs>
      <path d="M9.7 7.4 V20.6 M9.7 7.4 H14.6 A3.95 3.95 0 0 1 14.6 15.3 H9.7" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M11 15.3 L14.9 20.6 L20.7 11" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

export function PBar({ v, max }) {
  return <div style={{height:4,background:"var(--color-border-tertiary)",borderRadius:2}}><div style={{height:"100%",borderRadius:2,background:"#4338ca",width:`${(v/max)*100}%`,transition:"width 0.35s"}}/></div>;
}

export function Chip({ label, active, onClick, locked, small, hideBadge, rec }) {
  return (
    <button onClick={onClick} style={{
      padding:small?"4px 10px":"6px 14px", borderRadius:20,
      fontSize:small?11:12, fontWeight:600, cursor:"pointer", fontFamily:"inherit",
      border:locked?"1.5px solid #f59e0b":"1px solid",
      transition:"all 0.15s",
      background:active?"#4338ca":"transparent",
      color:active?"#fff":locked?"#92400e":"var(--color-text-secondary)",
      borderColor:active?"#4338ca":locked?"#f59e0b":"var(--color-border-secondary)",
      boxShadow:locked?"0 0 0 1px #f59e0b33, inset 0 0 0 1px #f59e0b22":undefined,
    }}>
      {label}
      {rec && !active && <span style={{marginLeft:5,display:"inline-block",width:6,height:6,borderRadius:"50%",background:"var(--color-accent)",verticalAlign:"middle"}}/>}
      {locked && !hideBadge && <span style={{marginLeft:4,fontSize:7,background:"#f59e0b",color:"#fff",borderRadius:8,padding:"1px 4px",fontWeight:700,verticalAlign:"middle"}}>PRO</span>}
    </button>
  );
}

// A clean segmented control: one connected track, the selected option raised as a
// card. `options` = [{value,label,icon?,locked?,rec?}]. onChange gets the option
// so callers can route a locked pick to an unlock flow.
export function Segmented({ options, value, onChange, size }) {
  const sm = size==="sm";
  return (
    <div style={{display:"flex",width:"100%",background:"var(--color-background-secondary)",border:"1px solid var(--color-border-secondary)",borderRadius:11,padding:3,gap:2}}>
      {options.map((o)=>{
        const active=o.value===value;
        return (
          <button key={o.value} onClick={()=>onChange(o)} title={o.title||o.label} style={{
            flex:1,minWidth:0,display:"inline-flex",alignItems:"center",justifyContent:"center",gap:5,
            padding:sm?"7px 6px":"9px 8px",border:"none",borderRadius:8,cursor:"pointer",fontFamily:"inherit",
            fontSize:sm?11.5:13,fontWeight:active?700:600,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",
            background:active?"var(--color-background-primary)":"transparent",
            color:active?"var(--color-text-primary)":"var(--color-text-secondary)",
            boxShadow:active?"0 1px 3px rgba(35,31,26,0.12)":"none",
            transition:"background .15s, color .15s, box-shadow .15s",
          }}>
            {o.icon && <Icon name={o.icon} size={sm?13:15} style={{flexShrink:0}}/>}
            <span style={{overflow:"hidden",textOverflow:"ellipsis"}}>{o.label}</span>
            {o.rec && !active && <span style={{width:6,height:6,borderRadius:"50%",background:"var(--color-accent)",flexShrink:0}}/>}
            {o.locked && <Icon name="lock" size={11} style={{opacity:0.65,flexShrink:0}}/>}
          </button>
        );
      })}
    </div>
  );
}

export function Toggle({ on, onChange, disabled }) {
  return (
    <div onClick={()=>!disabled&&onChange(!on)} style={{
      width:44,height:24,borderRadius:12,cursor:disabled?"not-allowed":"pointer",
      background:on?"#4338ca":"var(--color-border-secondary)",
      position:"relative",transition:"background 0.2s",opacity:disabled?0.45:1,
    }}>
      <div style={{position:"absolute",top:2,left:on?22:2,width:20,height:20,
        borderRadius:"50%",background:"#fff",transition:"left 0.18s",
        boxShadow:"0 1px 4px rgba(0,0,0,0.25)"}}/>
    </div>
  );
}
