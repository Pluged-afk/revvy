import { Navigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";

export default function ProtectedRoute({ children }) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div style={{
        minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
        background: "#1e1b4b", color: "#c7d2fe", fontFamily: "'DM Sans', sans-serif", fontSize: 15,
      }}>
        Loading…
      </div>
    );
  }

  if (!user) return <Navigate to="/login" replace />;

  return children;
}
