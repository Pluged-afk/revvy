import { SignUp } from "@clerk/clerk-react";
import RevyyMark from "../components/Logo.jsx";

export default function Signup() {
  return (
    <div className="site">
      <div className="auth-shell">
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 18 }}>
          <div className="auth-brand" style={{ color: "#fff" }}><RevyyMark /> Revyy</div>
          <SignUp
            routing="path"
            path="/signup"
            signInUrl="/login"
            fallbackRedirectUrl="/app"
            appearance={{ variables: { colorPrimary: "#4f46e5" } }}
          />
        </div>
      </div>
    </div>
  );
}
