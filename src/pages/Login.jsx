import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";
import RevvyMark from "../components/Logo.jsx";

function GoogleIcon() {
  return (
    <svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
    </svg>
  );
}

export default function Login() {
  const { signInWithPassword, signInWithGoogle, user } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (user) navigate("/app", { replace: true }); }, [user, navigate]);

  const onSubmit = async (e) => {
    e.preventDefault();
    setErr(""); setBusy(true);
    const { error } = await signInWithPassword(email, password);
    setBusy(false);
    if (error) setErr(error.message);
    else navigate("/app", { replace: true });
  };

  const onGoogle = async () => {
    setErr("");
    const { error } = await signInWithGoogle();
    if (error) setErr(error.message);
  };

  return (
    <div className="site">
      <div className="auth-shell">
        <div className="auth-card">
          <div className="auth-brand"><RevvyMark /> Revyy</div>
          <h1>Welcome back</h1>
          <p className="auth-sub">Sign in to start building quizzes.</p>

          {err && <div className="auth-error">{err}</div>}

          <form onSubmit={onSubmit}>
            <div className="form-field">
              <label htmlFor="email">Email</label>
              <input id="email" type="email" required autoComplete="email"
                value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
            </div>
            <div className="form-field">
              <label htmlFor="password">Password</label>
              <input id="password" type="password" required autoComplete="current-password"
                value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
            </div>
            <button type="submit" className="btn btn-primary btn-block btn-lg" disabled={busy}>
              {busy ? "Signing in…" : "Sign In"}
            </button>
          </form>

          <div className="auth-divider">or</div>

          <button type="button" className="btn btn-google btn-block btn-lg" onClick={onGoogle}>
            <GoogleIcon /> Continue with Google
          </button>

          <p className="auth-switch">
            Don't have an account? <Link to="/signup">Sign up</Link>
          </p>
        </div>
      </div>
    </div>
  );
}
