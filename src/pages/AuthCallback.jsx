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

    (async () => {
      const url = new URL(window.location.href);
      const code = url.searchParams.get("code");
      const tokenHash = url.searchParams.get("token_hash");
      const type = url.searchParams.get("type");
      const errDesc = url.searchParams.get("error_description");

      if (errDesc) {
        if (!cancelled) { setError(errDesc); setTimeout(() => navigate("/login", { replace: true }), 2500); }
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
        if (!cancelled) { setError(e.message || "Could not complete sign-in."); setTimeout(() => navigate("/login", { replace: true }), 2500); }
        return;
      }

      const { data: { session } } = await supabase.auth.getSession();
      if (cancelled) return;
      navigate(session ? "/app" : "/login", { replace: true });
    })();

    return () => { cancelled = true; };
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
