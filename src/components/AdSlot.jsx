import { useShowAds } from "../lib/ads.jsx";

// In-content advertisement placeholder for the marketing site. Renders nothing
// for Pro users or until ads are enabled. Swap the inner placeholder for a real
// ad-network unit when one is integrated.
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
