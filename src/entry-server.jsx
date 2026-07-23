import { renderToString } from "react-dom/server";
import { StaticRouter } from "react-router";
import { Routes, Route } from "react-router-dom";

import { AuthContext } from "./context/AuthContext.jsx";
import { LangContext } from "./context/LanguageContext.jsx";
import { getTranslations } from "./i18n.js";

import SiteLayout from "./components/SiteLayout.jsx";
import Home from "./pages/Home.jsx";
import Features from "./pages/Features.jsx";
import Pricing from "./pages/Pricing.jsx";
import About from "./pages/About.jsx";
import Contact from "./pages/Contact.jsx";
import Blog from "./pages/Blog.jsx";
import BlogPost from "./pages/BlogPost.jsx";
import PrivacyPolicy from "./pages/PrivacyPolicy.jsx";
import TermsOfService from "./pages/TermsOfService.jsx";

// Logged-out, non-Pro mock so marketing/blog components render server-side
// without Clerk. Every function is a no-op — none run during a static render.
const authMock = {
  user: null, isPro: false, loading: false, usage: null,
  subStatus: null, subPlan: null, periodEnd: null, cancelAtPeriodEnd: false,
  getToken: async () => null, signOut() {}, deleteAccount: async () => ({}),
  reauthenticate: async () => ({}), setProStatus() {}, refreshProfile: async () => {},
  startCheckout: async () => ({}), openPortal: async () => ({}),
  refreshUsage: async () => {}, consumeQuestions: async () => ({}),
  watchAd: async () => ({}), buyPack: async () => ({}),
};
const langMock = { lang: "en", t: getTranslations("en"), setLang() {} };

// Renders the marketing/blog route tree for `url` to a static HTML string.
// (DevContext already has sensible defaults, so no provider is needed for it.)
export function render(url) {
  return renderToString(
    <StaticRouter location={url}>
      <LangContext.Provider value={langMock}>
        <AuthContext.Provider value={authMock}>
          <Routes>
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
          </Routes>
        </AuthContext.Provider>
      </LangContext.Provider>
    </StaticRouter>
  );
}
