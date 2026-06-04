import { createContext, useContext, useEffect, useState, useCallback } from "react";
import { supabase } from "../lib/supabase.js";

const AuthContext = createContext(null);

// eslint-disable-next-line react-refresh/only-export-components
export const useAuth = () => useContext(AuthContext);

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [user, setUser] = useState(null);
  const [isPro, setIsPro] = useState(false);
  const [trialEnd, setTrialEnd] = useState(null);            // ISO string | null
  const [subStatus, setSubStatus] = useState(null);          // stripe subscription status
  const [loading, setLoading] = useState(true);

  // Read the user's profile row (creating it if missing) and sync state.
  const loadProfile = useCallback(async (uid) => {
    if (!uid) { setIsPro(false); setTrialEnd(null); setSubStatus(null); return; }
    const { data, error } = await supabase
      .from("profiles")
      .select("is_pro, trial_end, subscription_status")
      .eq("id", uid)
      .maybeSingle();

    if (error) { return; }

    if (!data) {
      // First sign-in for this user — create their profile row.
      await supabase.from("profiles").insert({ id: uid, is_pro: false });
      setIsPro(false); setTrialEnd(null); setSubStatus(null);
    } else {
      setIsPro(!!data.is_pro);
      setTrialEnd(data.trial_end || null);
      setSubStatus(data.subscription_status || null);
    }
  }, []);

  useEffect(() => {
    let mounted = true;

    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!mounted) return;
      setSession(session);
      setUser(session?.user ?? null);
      loadProfile(session?.user?.id).finally(() => mounted && setLoading(false));
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
      setUser(session?.user ?? null);
      // Defer Supabase calls out of the auth callback to avoid deadlocks.
      setTimeout(() => loadProfile(session?.user?.id), 0);
    });

    return () => { mounted = false; subscription.unsubscribe(); };
  }, [loadProfile]);

  // ── Auth actions ──────────────────────────────────────────────
  const signUp = (email, password) =>
    supabase.auth.signUp({
      email,
      password,
      // After the user clicks the confirmation email, land on /auth/callback.
      options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
    });

  const signInWithPassword = (email, password) =>
    supabase.auth.signInWithPassword({ email, password });

  const signInWithGoogle = () =>
    supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    });

  const signOut = () => supabase.auth.signOut();

  // Send a password-reset email; the link lands on /reset-password.
  const resetPassword = (email) =>
    supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`,
    });

  // Set a new password (used on /reset-password with the recovery session).
  const updatePassword = (password) =>
    supabase.auth.updateUser({ password });

  // Re-authenticate the user by their password (used to confirm sensitive
  // actions like account deletion). Returns { error } — null on success.
  const reauthenticate = useCallback(async (password) => {
    if (!user?.email) return { error: "This account has no email/password to verify." };
    const { error } = await supabase.auth.signInWithPassword({ email: user.email, password });
    return { error: error ? error.message : null };
  }, [user]);

  // Permanently delete the account via the serverless function (which holds
  // the service-role key). Returns { error } on failure, {} on success.
  const deleteAccount = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token;
    if (!token) return { error: "You are not signed in." };
    try {
      const res = await fetch("/api/delete-account", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return { error: body.error || `Delete failed (${res.status}).` };
      return {};
    } catch (e) {
      return { error: e.message || "Network error — could not reach the server." };
    }
  }, []);

  // Update isPro in the Supabase profile (and locally, optimistically).
  const setProStatus = useCallback(async (value) => {
    setIsPro(value);
    if (!user) return;
    await supabase.from("profiles").upsert({ id: user.id, is_pro: value });
  }, [user]);

  // Re-read the profile from Supabase (e.g. after returning from checkout).
  const refreshProfile = useCallback(async () => {
    if (user?.id) await loadProfile(user.id);
  }, [user, loadProfile]);

  // Start a Stripe Checkout session for the given price and redirect to it.
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

  // Open the Stripe Customer Portal (manage / cancel subscription).
  const openPortal = useCallback(async () => {
    if (!user) return { error: "Please sign in first." };
    try {
      const res = await fetch("/api/create-portal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.url) return { error: data.error || "Could not open billing portal." };
      window.location.href = data.url;
      return {};
    } catch (e) {
      return { error: e.message || "Network error." };
    }
  }, [user]);

  const value = {
    session, user, isPro, trialEnd, subStatus, loading,
    signUp, signInWithPassword, signInWithGoogle, signOut, setProStatus, deleteAccount, reauthenticate,
    resetPassword, updatePassword, refreshProfile, startCheckout, openPortal,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
