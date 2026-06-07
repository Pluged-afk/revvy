import { Link } from "react-router-dom";
import usePageMeta from "../lib/usePageMeta.js";

export default function TermsOfService() {
  usePageMeta("Terms of Service — Revyy", "The terms that govern your use of Revyy.");
  return (
    <section className="section">
      <div className="container legal">
        <h1>Terms of Service</h1>
        <p className="updated">Last updated: January 2025</p>

        <p>
          These Terms of Service ("Terms") govern your use of Revyy. By accessing or using the
          service, you agree to be bound by these Terms. If you do not agree, please do not use
          Revyy.
        </p>

        <h2>1. Service description</h2>
        <p>
          Revyy is an AI-powered study tool that generates quizzes, flashcards and practice exams
          from material you provide. Quizzes are produced automatically and, while we strive for
          accuracy, they may contain errors and should not be treated as authoritative or as a
          substitute for your official course material.
        </p>

        <h2>2. Free and Pro plans</h2>
        <ul>
          <li><strong>Free plan</strong> — includes a limited number of quizzes per day and a subset of features, available at no cost.</li>
          <li><strong>Pro plan</strong> — a paid subscription unlocking unlimited quizzes, all quiz types, Exam Mode and an ad-free experience.</li>
          <li>We may adjust plan limits or features over time, with notice of material changes where reasonable.</li>
        </ul>

        <h2>3. Payment and refunds</h2>
        <ul>
          <li>Pro subscriptions (monthly or yearly) are billed securely through Stripe and charged immediately at checkout. You can cancel anytime.</li>
          <li>You may cancel at any time; access continues until the end of the current billing period.</li>
          <li>Except where required by law, payments are non-refundable, but we will always consider reasonable refund requests in good faith.</li>
        </ul>

        <h2>4. Acceptable use</h2>
        <p>You agree not to:</p>
        <ul>
          <li>Upload material you do not have the right to use, or that is unlawful or infringing.</li>
          <li>Attempt to disrupt, reverse-engineer, or abuse the service or its usage limits.</li>
          <li>Use Revyy to generate harmful, deceptive or illegal content.</li>
          <li>Resell or redistribute the service without our permission.</li>
        </ul>

        <h2>5. Account termination</h2>
        <p>
          We may suspend or terminate access if these Terms are violated or if your use poses a
          risk to the service or other users. You may stop using Revyy at any time; cancelling a
          Pro subscription is handled from within the app or via your payment provider.
        </p>

        <h2>6. Limitation of liability</h2>
        <p>
          Revyy is provided "as is" without warranties of any kind. To the maximum extent
          permitted by law, we are not liable for any indirect, incidental or consequential
          damages, or for any loss arising from reliance on AI-generated content, including exam
          outcomes. Our total liability for any claim is limited to the amount you paid us in the
          preceding twelve months.
        </p>

        <h2>7. Contact</h2>
        <p>
          Questions about these Terms? Email{" "}
          <a href="mailto:revyyapp@outlook.com">revyyapp@outlook.com</a> or visit our{" "}
          <Link to="/contact">Contact page</Link>.
        </p>
      </div>
    </section>
  );
}
