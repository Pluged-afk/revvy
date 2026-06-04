import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase.js";
import { useAuth } from "../context/AuthContext.jsx";
import RevvyMark from "../components/Logo.jsx";

// Landing page for the password-reset email link. Supabase establishes a
// short-lived recovery session from the URL; the user then sets a new password.
export default function ResetPassword() {
  const { updatePassword } = useAuth();
  const navigate = useNavigate();
  const [ready, setReady] = useState(false);   // recovery session detected?
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [err, setErr] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // The client auto-processes the recovery token in the URL; wait for a session.
    supabase.auth.getSession().then(({ data: { session } }) => setReady(!!session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY" || session) setReady(true);
    });
    return () => subscription.unsubscribe();
  }, []);

  const onSubmit = async (e) => {
    e.preventDefault();
    setErr("");
    if (password.length < 6) { setErr("Password must be at least 6 characters."); return; }
    if (password !== confirm) { setErr("Passwords don't match."); return; }
    setBusy(true);
    const { error } = await updatePassword(password);
    setBusy(false);
    if (error) { setErr(error.message); return; }
    setDone(true);
    setTimeout(() => navigate("/app", { replace: true }), 1500);
  };

  return (
    <div className="site">
      <div className="auth-shell">
        <div className="auth-card">
          <div className="auth-brand"><RevvyMark /> Revyy</div>
          <h1>Set a new password</h1>
          <p className="auth-sub">Choose a new password for your account.</p>

          {done && <div className="auth-info">✓ Password updated — signing you in…</div>}
          {err && <div className="auth-error">{err}</div>}
          {!ready && !done && (
            <div className="auth-info">
              Open this page from the reset link in your email. If you got here by mistake,{" "}
              <Link to="/login">go back to sign in</Link>.
            </div>
          )}

          {!done && (
            <form onSubmit={onSubmit}>
              <div className="form-field">
                <label htmlFor="password">New password</label>
                <input id="password" type="password" required autoComplete="new-password"
                  value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 6 characters" />
              </div>
              <div className="form-field">
                <label htmlFor="confirm">Confirm password</label>
                <input id="confirm" type="password" required autoComplete="new-password"
                  value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="Re-enter password" />
              </div>
              <button type="submit" className="btn btn-primary btn-block btn-lg" disabled={busy || !ready}>
                {busy ? "Updating…" : "Update password"}
              </button>
            </form>
          )}

          <p className="auth-switch"><Link to="/login">Back to sign in</Link></p>
        </div>
      </div>
    </div>
  );
}
