import { useEffect } from "react";
import { useAuth } from "../context/AuthContext.jsx";
import { loadAdSense } from "../lib/adsense.js";

// Loads Google AdSense for everyone EXCEPT signed-in Pro users. We wait until
// auth has resolved (so a Pro user never briefly loads the ad script), then load
// only when they are not Pro. This makes Pro genuinely ad-free: no Auto Ads and
// no ad cookies, and Google's consent message never shows to them either.
export default function AdSenseLoader() {
  const { isPro, loading } = useAuth();
  useEffect(() => {
    if (loading) return;   // auth not resolved yet - don't load until we know
    if (isPro) return;     // Pro: never load the ad script
    loadAdSense();
  }, [isPro, loading]);
  return null;
}
