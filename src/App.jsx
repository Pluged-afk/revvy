import { useEffect, useMemo } from 'react'
import { BrowserRouter, Routes, Route, useNavigate } from 'react-router-dom'
import { ClerkProvider } from '@clerk/clerk-react'
import { applyAppearance } from './lib/appearance.js'
import { AuthProvider } from './context/AuthContext.jsx'
import { StudyProvider } from './context/StudyContext.jsx'
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
import PracticeHub from './pages/PracticeHub.jsx'
import ExamPage from './pages/ExamPage.jsx'
import PrivacyPolicy from './pages/PrivacyPolicy.jsx'
import TermsOfService from './pages/TermsOfService.jsx'
import Login from './pages/Login.jsx'
import Signup from './pages/Signup.jsx'
import NotFound from './pages/NotFound.jsx'
import LogoExport from './pages/LogoExport.jsx'
import SharedQuiz from './pages/SharedQuiz.jsx'
import StudyQuiz from './StudyQuiz.jsx'
import './site.css'

const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY

// Applies theme + font-scale from the saved settings to the whole document (the
// marketing site as well as the app), and keeps them in sync when the settings
// change (a `revyy-appearance` event the app fires), across tabs (storage), or
// when the OS colour scheme flips for "system".
function AppearanceApplier() {
  useEffect(() => {
    applyAppearance();
    const reapply = () => applyAppearance();
    const onStorage = (e) => { if (!e || e.key === 'revyy_settings') applyAppearance(); };
    window.addEventListener('revyy-appearance', reapply);
    window.addEventListener('storage', onStorage);
    let mq;
    try { mq = window.matchMedia('(prefers-color-scheme: dark)'); mq.addEventListener?.('change', reapply); } catch { /* ignore */ }
    return () => {
      window.removeEventListener('revyy-appearance', reapply);
      window.removeEventListener('storage', onStorage);
      try { mq?.removeEventListener?.('change', reapply); } catch { /* ignore */ }
    };
  }, []);
  return null;
}

// Clerk lives inside the router so its path-based <SignIn>/<SignUp> components
// navigate through react-router instead of full page reloads.
function ClerkRoutes() {
  const navigate = useNavigate()
  // Theme Clerk's cards to match the app so text stays readable in both modes.
  // (Default Clerk text was near-invisible on its white card when the app is in
  // dark mode.) data-theme is set on <html> before first paint, so reading it
  // once here is correct on load; a rare mid-session theme flip needs a reload
  // of the auth card, which is acceptable for a logged-out page.
  const clerkAppearance = useMemo(() => {
    const dark = typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme') === 'dark'
    const variables = dark
      ? { colorPrimary: '#a3a4f7', colorText: '#ececec', colorTextSecondary: '#a6a6a6', colorBackground: '#242424', colorInputText: '#ececec', colorInputBackground: '#1f1f1f', colorNeutral: '#ececec' }
      : { colorPrimary: '#4f46e5', colorText: '#1e293b', colorTextSecondary: '#64748b', colorBackground: '#ffffff', colorInputText: '#1e293b', colorInputBackground: '#ffffff' }
    return { variables }
  }, [])
  return (
    <ClerkProvider
      publishableKey={PUBLISHABLE_KEY}
      appearance={clerkAppearance}
      routerPush={(to) => navigate(to)}
      routerReplace={(to) => navigate(to, { replace: true })}
    >
      <DevProvider>
      <LanguageProvider>
      <AuthProvider>
        <DevWidget />
        <AppearanceApplier />
        <Routes>
          {/* Marketing website, navbar + footer layout */}
          <Route element={<SiteLayout />}>
            <Route path="/" element={<Home />} />
            <Route path="/features" element={<Features />} />
            <Route path="/pricing" element={<Pricing />} />
            <Route path="/about" element={<About />} />
            <Route path="/contact" element={<Contact />} />
            <Route path="/blog" element={<Blog />} />
            <Route path="/blog/:slug" element={<BlogPost />} />
            <Route path="/practice" element={<PracticeHub />} />
            <Route path="/practice/:exam" element={<ExamPage />} />
            <Route path="/privacy" element={<PrivacyPolicy />} />
            <Route path="/terms" element={<TermsOfService />} />
          </Route>

          {/* Clerk auth pages (path routing needs the splat) */}
          <Route path="/login/*" element={<Login />} />
          <Route path="/signup/*" element={<Signup />} />

          {/* Standalone logo export (no navbar/footer), for screenshotting */}
          <Route path="/logo-export" element={<LogoExport />} />

          {/* Public shared-quiz taker (no account needed), the share-a-quiz
              growth loop. Standalone: its own styling, no app shell. */}
          <Route path="/q/:id" element={<SharedQuiz />} />

          {/* The quiz app, browsable by everyone. Generating a quiz requires
              an account; that gate lives in StudyQuiz's generate handlers.
              StudyProvider (server-synced deck / stats / plans) wraps only this
              route so it never loads on the marketing pages or during SSR. */}
          <Route path="/app" element={<StudyProvider><StudyQuiz /></StudyProvider>} />

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
