import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase.js";

// Handles the redirect after email confirmation or OAuth sign-in, then
// sends the user straight to /app. Supabase's client (detectSessionInUrl)
// auto-processes a `code`/hash; we also handle `token_hash` (OTP links).
export default function AuthCallback() {
  const navigate = useNavigate();
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    const done = (path) => { if (!cancelled) { cancelled = true; navigate(path, { replace: true }); } };

    // Safety net: if Supabase establishes the session a beat later (OAuth hash
    // flow, slow token exchange), route straight to the app the moment it does.
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, session) => {
      if (session) done("/app");
    });

    (async () => {
      const url = new URL(window.location.href);
      const code = url.searchParams.get("code");
      const tokenHash = url.searchParams.get("token_hash");
      const type = url.searchParams.get("type");
      const errDesc = url.searchParams.get("error_description") || url.searchParams.get("error");

      if (errDesc) {
        if (!cancelled) { setError(errDesc); setTimeout(() => done("/login"), 2500); }
        return;
      }

      try {
        if (tokenHash && type) {
          const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
          if (error) throw error;
        } else if (code) {
          // detectSessionInUrl may have already used the code; ignore "already used".
          const { error } = await supabase.auth.exchangeCodeForSession(code);
          if (error && !/already|verifier|non-empty/i.test(error.message)) throw error;
        }
      } catch (e) {
        if (!cancelled) { setError(e.message || "Could not complete sign-in."); setTimeout(() => done("/login"), 2500); }
        return;
      }

      // Poll briefly for the session (covers detectSessionInUrl races) before
      // deciding where to send the user. Never dead-ends on the callback route.
      for (let i = 0; i < 6 && !cancelled; i++) {
        const { data: { session } } = await supabase.auth.getSession();
        if (session) return done("/app");
        await new Promise((r) => setTimeout(r, 300));
      }
      done("/login");
    })();

    return () => { cancelled = true; subscription.unsubscribe(); };
  }, [navigate]);

  return (
    <div style={{
      minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
      flexDirection: "column", gap: 12, textAlign: "center", padding: 24,
      background: "radial-gradient(120% 120% at 80% 0%, #4338ca 0%, #312e81 45%, #1e1b4b 100%)",
      color: "#c7d2fe", fontFamily: "'DM Sans', system-ui, sans-serif",
    }}>
      {error
        ? <><div style={{ fontSize: 34 }}>⚠️</div><div style={{ maxWidth: 360, fontSize: 14 }}>{error}</div><div style={{ fontSize: 13, opacity: 0.8 }}>Redirecting to sign in…</div></>
        : <><div style={{ fontSize: 34 }}>✓</div><div style={{ fontSize: 15 }}>Confirming your account…</div></>}
    </div>
  );
}
