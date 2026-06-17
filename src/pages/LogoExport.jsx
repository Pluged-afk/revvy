import { RevyyGlyph } from "../components/Logo.jsx";

// Standalone, unchromed page for exporting the Revyy app icon.
// Renders the brand mark (purple gradient tile + white glyph) on a dark-purple
// 1020×1020 canvas — screenshot the square for app directories / store listings.
export default function LogoExport() {
  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 18, background: "#0c0b17", padding: 24, fontFamily: "system-ui, -apple-system, sans-serif" }}>
      <style>{`.logo-export-glyph svg { width: 100%; height: 100%; display: block; }`}</style>

      {/* The exact 1020×1020 square to screenshot */}
      <div
        id="logo-canvas"
        style={{
          width: 1020,
          height: 1020,
          flexShrink: 0,
          background: "#1e1b4b",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div
          style={{
            width: 620,
            height: 620,
            borderRadius: 150,
            background: "linear-gradient(135deg, #6366f1, #4338ca)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            boxShadow: "0 50px 130px rgba(67,56,202,0.55)",
          }}
        >
          <div className="logo-export-glyph" style={{ width: 340, height: 340 }}>
            <RevyyGlyph strokeWidth={2.5} />
          </div>
        </div>
      </div>

      <p style={{ color: "#64748b", fontSize: 13 }}>1020 × 1020 — screenshot the square above at full size.</p>
    </div>
  );
}
