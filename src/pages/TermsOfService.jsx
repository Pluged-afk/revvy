import { Link } from "react-router-dom";
import usePageMeta from "../lib/usePageMeta.js";

export default function TermsOfService() {
  usePageMeta("Terms of Service · Revyy", "The terms that govern your use of Revyy, including plans, payments, your content, and acceptable use.");
  return (
    <section className="section">
      <div className="container legal">
        <h1>Terms of Service</h1>
        <p className="updated">Last updated: August 2026</p>

        <p>
          These Terms govern your use of Revyy. By using the service you agree to them. If you do
          not agree, please do not use Revyy.
        </p>

        <h2>1. What Revyy does</h2>
        <p>
          Revyy generates quizzes, flashcards and mock exams from study material you provide, using
          AI. You can upload PDFs, images and text, import a set from Quizlet, or upload an audio or
          video recording that we transcribe to text first. The questions and any grading are
          produced automatically. While we aim for accuracy, the output can contain mistakes and
          should not be treated as authoritative or as a replacement for your official course
          material.
        </p>

        <h2>2. Your account</h2>
        <ul>
          <li>Most features require an account, which is handled by our sign-in provider (Clerk) using your email and a password or Google sign-in.</li>
          <li>You are responsible for keeping your login secure and for activity under your account.</li>
          <li>You must be old enough to hold an account under your local rules (generally 13, or 16 in parts of the EU).</li>
        </ul>

        <h2>3. Free and Pro plans</h2>
        <ul>
          <li><strong>Free:</strong> a set number of questions per day, multiple-choice always available, other quiz types and one mock exam a day available with ads, and smaller file uploads.</li>
          <li><strong>Pro:</strong> a higher daily question allowance, all quiz types, unlimited and custom mock exams, larger file uploads, and no ads.</li>
          <li>We may adjust plan limits or features over time, and will give notice of material changes where reasonable.</li>
        </ul>

        <h2>4. Payments and refunds</h2>
        <ul>
          <li>Pro subscriptions (monthly or yearly) are billed through Stripe and charged when you subscribe and at each renewal.</li>
          <li>You can cancel at any time. Your access continues until the end of the period you have already paid for.</li>
          <li>Except where the law requires otherwise, payments are non-refundable, but we will consider reasonable refund requests in good faith.</li>
        </ul>

        <h2>5. Your material and content</h2>
        <ul>
          <li>You keep ownership of the material you upload. You give us permission to process it for the purpose of generating your quiz, including sending it to our AI provider (Anthropic), transcribing audio or video with our transcription provider (AssemblyAI), and running an automated safety check on it.</li>
          <li>You confirm you have the right to use and upload the material, and that it is not unlawful or infringing.</li>
          <li>If you create a share link, you are making that quiz's content available to anyone who has the link. Do not share content you do not have the right to distribute.</li>
        </ul>

        <h2>6. Acceptable use</h2>
        <p>You agree not to:</p>
        <ul>
          <li>Upload material you do not have the right to use, or that is unlawful or infringing.</li>
          <li>Upload sexual, explicit, hateful or other non-study content. An automated check rejects it, and repeated attempts may end your access.</li>
          <li>Use Revyy to generate harmful, deceptive or illegal content.</li>
          <li>Attempt to disrupt, reverse-engineer, scrape, or get around the service's usage limits.</li>
          <li>Resell or redistribute the service without our permission.</li>
        </ul>

        <h2>7. Third-party services</h2>
        <p>
          Revyy relies on other providers to work, including Clerk (sign-in), Stripe (payments),
          Anthropic (AI generation and content checks), AssemblyAI (audio and video transcription),
          Neon (database), Vercel (hosting), Google (advertising) and Resend (contact email). Your
          use of Revyy is also subject to their terms where relevant.
        </p>

        <h2>8. Account suspension</h2>
        <p>
          We may suspend or end access if these Terms are broken or if your use puts the service or
          other users at risk. You can stop using Revyy at any time; cancelling a Pro subscription
          is done from within the app or through your payment provider.
        </p>

        <h2>9. Disclaimer and limitation of liability</h2>
        <p>
          Revyy is provided "as is", without warranties of any kind. To the maximum extent
          permitted by law, we are not liable for indirect, incidental or consequential damages, or
          for any loss arising from reliance on AI-generated content, including exam outcomes.
          Always check important answers against a trusted source. Our total liability for any claim
          is limited to the amount you paid us in the preceding twelve months.
        </p>

        <h2>10. Changes and contact</h2>
        <p>
          We may update these Terms as the product changes, and will update the date above when we
          do. Questions? Email{" "}
          <a href="mailto:support@revyy.app">support@revyy.app</a> or visit our{" "}
          <Link to="/contact">Contact page</Link>.
        </p>
      </div>
    </section>
  );
}
