/* eslint-disable react-refresh/only-export-components */
import { useDev } from "../context/DevContext.jsx";
import { useAuth } from "../context/AuthContext.jsx";

// Master switch for the built-in placeholder ad boxes. Kept OFF while pursuing
// AdSense approval, empty "Advertisement" boxes that aren't real ads clutter
// the site and hurt review. Real ads are served by AdSense Auto Ads via the
// loader in index.html once approved; flip this back to the env check (or add
// real <ins class="adsbygoogle"> units) after approval.
export const ADS_ENABLED = false; // was: import.meta.env.VITE_ADS_ENABLED === "true"

// Placeholder rewarded-ad function, stands in for a real ad SDK. Resolves
// after a short simulated "watch". Swap out when a real provider is wired in.
export function simulateAdWatch() {
  return new Promise((resolve) => setTimeout(resolve, 1200));
}

// Single source of truth for whether to show ANY ad (side banners, in-content
// slots, the slide-up popup). Pro users NEVER see ads. Dev mode can force ads
// on/off (DevWidget) so we can preview placements locally before approval.
export function useShowAds() {
  const dev = useDev();
  const { isPro } = useAuth();
  const adsOn = dev.devMode && dev.ads !== null ? dev.ads : ADS_ENABLED;
  return !isPro && adsOn;
}
