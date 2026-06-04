// Revyy logo mark: a bold "R" whose leg sweeps up into a checkmark —
// a nod to landing on the right answer. Minimal, single purple accent (#4f46e5),
// rendered as a white glyph on the gradient tile.

export function RevyyGlyph({ stroke = "#fff", strokeWidth = 2.5 }) {
  return (
    <svg viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg">
      {/* R — stem + bowl */}
      <path
        d="M9.7 7.4 V20.6 M9.7 7.4 H14.6 A3.95 3.95 0 0 1 14.6 15.3 H9.7"
        stroke={stroke} strokeWidth={strokeWidth}
        strokeLinecap="round" strokeLinejoin="round"
      />
      {/* leg that becomes a checkmark */}
      <path
        d="M11 15.3 L14.9 20.6 L20.7 11"
        stroke={stroke} strokeWidth={strokeWidth}
        strokeLinecap="round" strokeLinejoin="round"
      />
    </svg>
  );
}

// Full mark: purple gradient tile (via .logo-mark CSS) + white glyph.
export default function RevyyMark() {
  return (
    <span className="logo-mark">
      <RevyyGlyph />
    </span>
  );
}
