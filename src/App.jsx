import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { AuthProvider } from './context/AuthContext.jsx'
import { LanguageProvider } from './context/LanguageContext.jsx'
import { DevProvider } from './context/DevContext.jsx'
import DevWidget from './components/DevWidget.jsx'
import ProtectedRoute from './components/ProtectedRoute.jsx'
import SiteLayout from './components/SiteLayout.jsx'
import Home from './pages/Home.jsx'
import Features from './pages/Features.jsx'
import Pricing from './pages/Pricing.jsx'
import About from './pages/About.jsx'
import Contact from './pages/Contact.jsx'
import PrivacyPolicy from './pages/PrivacyPolicy.jsx'
import TermsOfService from './pages/TermsOfService.jsx'
import Login from './pages/Login.jsx'
import Signup from './pages/Signup.jsx'
import AuthCallback from './pages/AuthCallback.jsx'
import ResetPassword from './pages/ResetPassword.jsx'
import NotFound from './pages/NotFound.jsx'
import StudyQuiz from './StudyQuiz.jsx'
import './site.css'

export default function App() {
  return (
    <BrowserRouter>
      <DevProvider>
      <LanguageProvider>
      <AuthProvider>
        <DevWidget />
        <Routes>
          {/* Marketing website — wrapped in navbar + footer layout */}
          <Route element={<SiteLayout />}>
            <Route path="/" element={<Home />} />
            <Route path="/features" element={<Features />} />
            <Route path="/pricing" element={<Pricing />} />
            <Route path="/about" element={<About />} />
            <Route path="/contact" element={<Contact />} />
            <Route path="/privacy" element={<PrivacyPolicy />} />
            <Route path="/terms" element={<TermsOfService />} />
          </Route>

          {/* Auth pages — standalone */}
          <Route path="/login" element={<Login />} />
          <Route path="/signup" element={<Signup />} />
          <Route path="/auth/callback" element={<AuthCallback />} />
          <Route path="/reset-password" element={<ResetPassword />} />

          {/* The quiz app — requires authentication */}
          <Route
            path="/app"
            element={
              <ProtectedRoute>
                <StudyQuiz />
              </ProtectedRoute>
            }
          />

          {/* Unknown routes render a proper 404 (inside the site chrome) */}
          <Route path="*" element={<SiteLayout />}>
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </AuthProvider>
      </LanguageProvider>
      </DevProvider>
    </BrowserRouter>
  )
}
