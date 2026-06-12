import { useShowAds } from "../lib/ads.jsx";

// In-content advertisement placeholder for the marketing site. Renders nothing
// for Pro users or until ads are enabled. Once AdSense assigns slot IDs, swap
// the inner placeholder for a real <ins class="adsbygoogle" data-ad-slot="…">.
export default function AdSlot({ label = "Advertisement", compact = false }) {
  if (!useShowAds()) return null;
  return (
    <div className="rv-adslot-wrap">
      <div className={"rv-adslot" + (compact ? " compact" : "")}>
        <span className="rv-adslot-label">{label}</span>
      </div>
    </div>
  );
}
