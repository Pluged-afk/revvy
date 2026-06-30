import { BrowserRouter, Routes, Route, useNavigate } from 'react-router-dom'
import { ClerkProvider, SignedIn, SignedOut, RedirectToSignIn } from '@clerk/clerk-react'
import { AuthProvider } from './context/AuthContext.jsx'
import { LanguageProvider } from './context/LanguageContext.jsx'
import { DevProvider } from './context/DevContext.jsx'
import DevWidget from './components/DevWidget.jsx'
import SiteLayout from './components/SiteLayout.jsx'
import Home from './pages/Home.jsx'
import Features from './pages/Features.jsx'
import Pricing from './pages/Pricing.jsx'
import About from './pages/About.jsx'
import Contact from './pages/Contact.jsx'
import Blog from './pages/Blog.jsx'
import BlogPost from './pages/BlogPost.jsx'
import PrivacyPolicy from './pages/PrivacyPolicy.jsx'
import TermsOfService from './pages/TermsOfService.jsx'
import Login from './pages/Login.jsx'
import Signup from './pages/Signup.jsx'
import NotFound from './pages/NotFound.jsx'
import LogoExport from './pages/LogoExport.jsx'
import StudyQuiz from './StudyQuiz.jsx'
import './site.css'

const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY

// Clerk lives inside the router so its path-based <SignIn>/<SignUp> components
// navigate through react-router instead of full page reloads.
function ClerkRoutes() {
  const navigate = useNavigate()
  return (
    <ClerkProvider
      publishableKey={PUBLISHABLE_KEY}
      routerPush={(to) => navigate(to)}
      routerReplace={(to) => navigate(to, { replace: true })}
    >
      <DevProvider>
      <LanguageProvider>
      <AuthProvider>
        <DevWidget />
        <Routes>
          {/* Marketing website — navbar + footer layout */}
          <Route element={<SiteLayout />}>
            <Route path="/" element={<Home />} />
            <Route path="/features" element={<Features />} />
            <Route path="/pricing" element={<Pricing />} />
            <Route path="/about" element={<About />} />
            <Route path="/contact" element={<Contact />} />
            <Route path="/blog" element={<Blog />} />
            <Route path="/blog/:slug" element={<BlogPost />} />
            <Route path="/privacy" element={<PrivacyPolicy />} />
            <Route path="/terms" element={<TermsOfService />} />
          </Route>

          {/* Clerk auth pages (path routing needs the splat) */}
          <Route path="/login/*" element={<Login />} />
          <Route path="/signup/*" element={<Signup />} />

          {/* Standalone logo export (no navbar/footer) — for screenshotting */}
          <Route path="/logo-export" element={<LogoExport />} />

          {/* The quiz app — Clerk-gated */}
          <Route
            path="/app"
            element={
              <>
                <SignedIn><StudyQuiz /></SignedIn>
                <SignedOut><RedirectToSignIn /></SignedOut>
              </>
            }
          />

          {/* Unknown routes → 404 inside the site chrome */}
          <Route path="*" element={<SiteLayout />}>
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </AuthProvider>
      </LanguageProvider>
      </DevProvider>
    </ClerkProvider>
  )
}

export default function App() {
  if (!PUBLISHABLE_KEY) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, textAlign: "center", fontFamily: "system-ui, sans-serif", color: "#1e293b" }}>
        <div>
          <h1 style={{ fontSize: 20, marginBottom: 8 }}>Configuration needed</h1>
          <p style={{ color: "#64748b", maxWidth: 420 }}>Set <code>VITE_CLERK_PUBLISHABLE_KEY</code> in your environment to start the app.</p>
        </div>
      </div>
    )
  }
  return (
    <BrowserRouter>
      <ClerkRoutes />
    </BrowserRouter>
  )
}
