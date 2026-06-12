/* eslint-disable react-refresh/only-export-components */
import { useDev } from "../context/DevContext.jsx";
import { useAuth } from "../context/AuthContext.jsx";

// Master switch — ads only render once AdSense is approved and this env var is
// set to "true" (in Vercel). Until then nothing ad-related shows in production.
export const ADS_ENABLED = import.meta.env.VITE_ADS_ENABLED === "true";

// Single source of truth for whether to show ANY ad (side banners, in-content
// slots, the slide-up popup). Pro users NEVER see ads. Dev mode can force ads
// on/off (DevWidget) so we can preview placements locally before approval.
export function useShowAds() {
  const dev = useDev();
  const { isPro } = useAuth();
  const adsOn = dev.devMode && dev.ads !== null ? dev.ads : ADS_ENABLED;
  return !isPro && adsOn;
}
