import { SignIn } from "@clerk/clerk-react";
import RevyyMark from "../components/Logo.jsx";

// The account that last signed in on this browser (email + name), saved by
// AuthContext. Lets us greet a returning user and pre-fill their email so a
// re-login is one tap. Clerk keeps the session persistent on its own; this is
// only for the rare time the sign-in screen does show up.
function lastAccount() {
  try {
    const v = JSON.parse(localStorage.getItem("revyy_last_account") || "null");
    return v && v.email ? v : null;
  } catch { return null; }
}

export default function Login() {
  const last = lastAccount();
  return (
    <div className="site">
      <div className="auth-shell">
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16 }}>
          <div className="auth-brand" style={{ color: "var(--ink)" }}><RevyyMark /> Revyy</div>
          {last && (
            <div style={{ fontSize: 14, lineHeight: 1.5, textAlign: "center", color: "var(--ink)", opacity: 0.75, maxWidth: 340 }}>
              Welcome back{last.name ? `, ${last.name}` : ""}. Continue as <strong style={{ opacity: 1 }}>{last.email}</strong>.
            </div>
          )}
          <SignIn
            routing="path"
            path="/login"
            signUpUrl="/signup"
            fallbackRedirectUrl="/app"
            initialValues={last ? { emailAddress: last.email } : undefined}
          />
        </div>
      </div>
    </div>
  );
}
