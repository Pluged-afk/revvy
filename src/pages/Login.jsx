import { SignIn } from "@clerk/clerk-react";
import RevyyMark from "../components/Logo.jsx";

export default function Login() {
  return (
    <div className="site">
      <div className="auth-shell">
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 18 }}>
          <div className="auth-brand" style={{ color: "#fff" }}><RevyyMark /> Revyy</div>
          <SignIn
            routing="path"
            path="/login"
            signUpUrl="/signup"
            fallbackRedirectUrl="/app"
            appearance={{ variables: { colorPrimary: "#4f46e5" } }}
          />
        </div>
      </div>
    </div>
  );
}
