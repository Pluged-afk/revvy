import { createContext, useContext, useEffect, useState, useCallback, useMemo } from "react";
import { useUser, useAuth as useClerkAuth } from "@clerk/clerk-react";
import { useDev } from "./DevContext.jsx";

const AuthContext = createContext(null);

// eslint-disable-next-line react-refresh/only-export-components
export const useAuth = () => useContext(AuthContext);

export function AuthProvider({ children }) {
  const { isLoaded, isSignedIn, user: clerkUser } = useUser();
  const { signOut: clerkSignOut, getToken } = useClerkAuth();
  const dev = useDev();

  const [isPro, setIsPro] = useState(false);
  const [subStatus, setSubStatus] = useState(null);
  const [subPlan, setSubPlan] = useState(null);
  const [periodEnd, setPeriodEnd] = useState(null);
  const [cancelAtPeriodEnd, setCancelAtPeriodEnd] = useState(false);
  const [loading, setLoading] = useState(true);

  // Normalized user object the rest of the app expects ({ id, email }).
  const user = useMemo(() => {
    if (!isSignedIn || !clerkUser) return null;
    return {
      id: clerkUser.id,
      email: clerkUser.primaryEmailAddress?.emailAddress || "",
      // Clerk handles re-auth itself, so no email/password identity is exposed
      // (this makes account-deletion skip the password re-prompt).
      identities: [],
    };
  }, [isSignedIn, clerkUser]);

  // Read the profile FRESH from Neon via the serverless API (token-verified
  // server-side). Never cached in localStorage. Returns is_pro (bool) or null
  // if the read failed (lets pollers keep trying).
  const loadProfile = useCallback(async () => {
    try {
      const token = await getToken();
      if (!token) {
        setIsPro(false); setSubStatus(null); setSubPlan(null); setPeriodEnd(null); setCancelAtPeriodEnd(false);
        return false;
      }
      const res = await fetch("/api/get-profile", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return null;
      const p = await res.json();
      setIsPro(p.is_pro === true);
      setSubStatus(p.subscription_status || null);
      setSubPlan(p.subscription_plan || null);
      setPeriodEnd(p.current_period_end || null);
      setCancelAtPeriodEnd(!!p.cancel_at_period_end);
      return p.is_pro === true;
    } catch {
      return null;
    }
  }, [getToken]);

  // On sign-in: ensure a profile row exists, then load it.
  useEffect(() => {
    if (!isLoaded) return;
    let cancelled = false;
    (async () => {
      if (!isSignedIn || !clerkUser) {
        if (!cancelled) { setIsPro(false); setLoading(false); }
        return;
      }
      const email = clerkUser.primaryEmailAddress?.emailAddress || "";
      try {
        await fetch("/api/create-profile", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId: clerkUser.id, email }),
        });
      } catch { /* non-fatal */ }
      await loadProfile();
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [isLoaded, isSignedIn, clerkUser, loadProfile]);

  const signOut = useCallback(() => clerkSignOut(), [clerkSignOut]);

  // Re-read the profile (e.g. after returning from Stripe checkout).
  const refreshProfile = useCallback(async () => {
    if (!clerkUser?.id) return false;
    return await loadProfile();
  }, [clerkUser, loadProfile]);

  // Local-only optimistic toggle (dev / immediate UI); the webhook is the
  // source of truth in Neon.
  const setProStatus = useCallback((value) => setIsPro(!!value), []);

  // Clerk handles re-auth; deletion needs no password re-prompt.
  const reauthenticate = useCallback(async () => ({ error: null }), []);

  // Delete: remove the Neon row, then delete the Clerk user (self-only).
  const deleteAccount = useCallback(async () => {
    if (!clerkUser) return { error: "You are not signed in." };
    try {
      await fetch("/api/delete-account", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: clerkUser.id }),
      });
      await clerkUser.delete();   // ends the session
      return {};
    } catch (e) {
      return { error: e.message || "Could not delete account." };
    }
  }, [clerkUser]);

  const startCheckout = useCallback(async (priceId) => {
    if (!user) return { error: "Please sign in first." };
    try {
      const res = await fetch("/api/create-checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ priceId, userId: user.id, userEmail: user.email }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.url) return { error: data.error || "Could not start checkout." };
      window.location.href = data.url;
      return {};
    } catch (e) {
      return { error: e.message || "Network error." };
    }
  }, [user]);

  const openPortal = useCallback(async (flow) => {
    if (!user) return { error: "Please sign in first." };
    try {
      const res = await fetch("/api/create-portal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.id, flow }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.url) return { error: data.error || "Could not open billing portal." };
      window.location.href = data.url;
      return {};
    } catch (e) {
      return { error: e.message || "Network error." };
    }
  }, [user]);

  // Dev-mode Pro override (local only — dev.devMode is false in production).
  const effIsPro = dev.devMode && dev.pro !== null ? dev.pro : isPro;

  const value = {
    user, isPro: effIsPro, loading: loading || !isLoaded,
    subStatus, subPlan, periodEnd, cancelAtPeriodEnd, getToken,
    signOut, deleteAccount, reauthenticate, setProStatus, refreshProfile, startCheckout, openPortal,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
