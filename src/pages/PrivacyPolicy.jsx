import { Link } from "react-router-dom";
import usePageMeta from "../lib/usePageMeta.js";

export default function PrivacyPolicy() {
  usePageMeta("Privacy Policy — Revyy", "How Revyy collects, uses, and protects your data.");
  return (
    <section className="section">
      <div className="container legal">
        <h1>Privacy Policy</h1>
        <p className="updated">Last updated: January 2025</p>

        <p>
          This Privacy Policy explains what information Revyy ("we", "us") collects when you
          use our website and app, how we use it, and the rights you have over your data. By
          using Revyy you agree to the practices described below.
        </p>

        <h2>1. Data we collect</h2>
        <ul>
          <li><strong>Study material you provide</strong> — PDFs, images, text and links you upload to generate a quiz.</li>
          <li><strong>Account &amp; usage data</strong> — basic settings (such as language and theme) and counters like the number of quizzes generated, stored locally in your browser.</li>
          <li><strong>Payment data</strong> — if you subscribe to Pro, billing details are handled by our payment provider; we never see or store your full card number.</li>
          <li><strong>Technical data</strong> — standard log information such as browser type and approximate region, used to keep the service secure and reliable.</li>
        </ul>

        <h2>2. How we use it</h2>
        <ul>
          <li>To generate quizzes from the material you submit.</li>
          <li>To operate, maintain and improve the service.</li>
          <li>To process subscriptions and prevent abuse of free-plan limits.</li>
          <li>To respond to support requests you send us.</li>
        </ul>
        <p>
          We do <strong>not</strong> sell your personal data, and we do not retain your uploaded
          files after your quiz has been generated.
        </p>

        <h2>3. Google AdSense</h2>
        <p>
          Free-plan pages may display ads served through Google AdSense. Google and its partners
          may use cookies to serve ads based on your prior visits to this and other websites. You
          can opt out of personalised advertising through{" "}
          <a href="https://adssettings.google.com" target="_blank" rel="noreferrer">Google Ads Settings</a>.
        </p>

        <h2>4. Anthropic AI API</h2>
        <p>
          Quizzes are generated using Anthropic's Claude API. The study material you submit is
          sent to Anthropic solely to produce your quiz. Anthropic processes this content under
          its own API terms and does not use API inputs to train its models.
        </p>

        <h2>5. Stripe payments</h2>
        <p>
          Pro subscriptions are processed by Stripe, our payment provider. Your card details are
          collected and stored by Stripe under their privacy policy and are never seen or stored
          by Revyy — we only receive confirmation of your subscription status.
        </p>

        <h2>6. Your rights</h2>
        <ul>
          <li>Access, correct or delete the personal data we hold about you.</li>
          <li>Withdraw consent or object to certain processing.</li>
          <li>Clear locally stored settings at any time by clearing your browser data.</li>
          <li>Request data portability where applicable.</li>
        </ul>

        <h2>7. Contact</h2>
        <p>
          For any privacy questions or requests, email us at{" "}
          <a href="mailto:revyyapp@outlook.com">revyyapp@outlook.com</a> or visit our{" "}
          <Link to="/contact">Contact page</Link>.
        </p>
      </div>
    </section>
  );
}
