import { Link } from "react-router-dom";
import usePageMeta from "../lib/usePageMeta.js";

export default function PrivacyPolicy() {
  usePageMeta("Privacy Policy · Revyy", "What data Revyy collects, how it is used, the third parties involved, and the choices you have.");
  return (
    <section className="section">
      <div className="container legal">
        <h1>Privacy Policy</h1>
        <p className="updated">Last updated: August 2026</p>

        <p>
          This policy explains what information Revyy ("we", "us") collects when you use our
          website and app, how we use it, who we share it with, and the choices you have. We have
          tried to describe what actually happens rather than list every possibility. If anything
          is unclear, email us at <a href="mailto:support@revyy.app">support@revyy.app</a>.
        </p>

        <h2>1. Information we collect</h2>
        <ul>
          <li><strong>Account details:</strong> when you sign up, our authentication provider (Clerk) collects your email address and either a password or your Google sign-in, plus a display name if you provide one.</li>
          <li><strong>Study material you upload:</strong> the PDFs, images, photos, pasted text (including sets you import from Quizlet) and audio or video recordings you submit so we can generate a quiz, flashcards or an exam from them.</li>
          <li><strong>Your study progress:</strong> if you are signed in, we save the data the app produces, your review deck, quiz and exam scores, study plans, per-topic progress and any exam date you set, to our database so it syncs across your devices.</li>
          <li><strong>Usage and plan data:</strong> counters such as how many questions and mock exams you have generated today, and whether you are on the Free or Pro plan, so we can apply plan limits.</li>
          <li><strong>Payment data:</strong> if you subscribe to Pro, your card details are collected and held by our payment provider (Stripe). We never see or store your card number, only your subscription status.</li>
          <li><strong>Messages you send us:</strong> the name, email and message you submit through the contact form or the in-app report tool.</li>
          <li><strong>Settings stored on your device:</strong> your language, theme and a local copy of your study data and counters, kept in your browser's local storage.</li>
          <li><strong>Technical data:</strong> standard server logs such as IP address, browser type and approximate region, used to keep the service secure and working.</li>
        </ul>

        <h2>2. How we use your information</h2>
        <ul>
          <li>To generate quizzes, flashcards and mock exams from the material you provide.</li>
          <li>To save and sync your study progress across your devices when you are signed in.</li>
          <li>To apply Free and Pro plan limits and process subscriptions.</li>
          <li>To respond to your support messages.</li>
          <li>To keep the service secure, prevent abuse, and fix problems.</li>
          <li>On the Free plan, to show advertising (see section 5).</li>
        </ul>

        <h2>3. Your uploaded material, transcription and AI generation</h2>
        <p>
          To build your quiz, the material you upload is sent to Anthropic's Claude API, which reads
          it and writes the questions. Before that, we run a quick automated safety check on the
          content so that clearly explicit or non-study material is not turned into a quiz.
        </p>
        <p>
          If you upload an audio or video file, it is first transcribed to text by our transcription
          provider (AssemblyAI), and only the resulting text is used to generate your quiz. Larger
          uploads on the Pro plan, including audio and video, pass through a temporary file store
          (Vercel Blob), which we delete as soon as the file has been forwarded for processing. Sets
          you import from Quizlet are read in your own browser and never leave your device except as
          the same study text described above. We do not keep copies of your uploaded files on our
          own servers.
        </p>
        <p>
          So that Revyy can build a cumulative "quiz me on everything" review across what you have
          studied, we keep a short AI-written summary of each set as part of your study data. These
          summaries are a brief digest of the material, not the original files or their full text,
          and you can remove any of them, or all of them, from your study library whenever you like.
        </p>
        <p>
          Anthropic and AssemblyAI process your content only to provide these features, under their
          own terms, and do not use it to train their models.
        </p>

        <h2>4. Shared quizzes</h2>
        <p>
          If you create a share link for a quiz, we store that quiz's questions, the name shown on
          it (taken from the first part of your email address) and the scores of people who take it,
          so that anyone with the link can play it and see the leaderboard. A shared quiz is
          accessible to anyone who has the link. If you want a shared quiz removed, email us and we
          will delete it.
        </p>

        <h2>5. Advertising</h2>
        <p>
          Free-plan pages may display ads through Google AdSense. Google, as a third-party vendor, uses
          cookies (including the DoubleClick cookie) to serve ads based on your prior visits to this and
          other websites. You can review and turn off personalised advertising at{" "}
          <a href="https://www.google.com/settings/ads" target="_blank" rel="noopener noreferrer">Google's Ads Settings</a>,
          opt out of third-party vendor cookies at{" "}
          <a href="https://www.aboutads.info/choices/" target="_blank" rel="noopener noreferrer">aboutads.info</a>,
          or read more in{" "}
          <a href="https://policies.google.com/technologies/ads" target="_blank" rel="noopener noreferrer">Google's advertising policy</a>,
          as well as through your browser or device controls.
        </p>

        <h2>6. Who we share data with</h2>
        <p>We do not sell your personal data. We share it only with the service providers we rely on to run Revyy, and only for that purpose:</p>
        <ul>
          <li><strong>Clerk</strong>, accounts and sign-in.</li>
          <li><strong>Neon</strong>, our database (your study data, plan and usage counters, shared quizzes).</li>
          <li><strong>Anthropic</strong>, the AI that generates your quizzes from your material and runs the content safety check.</li>
          <li><strong>AssemblyAI</strong>, transcribing the audio and video you upload.</li>
          <li><strong>Stripe</strong>, payment processing for Pro.</li>
          <li><strong>Vercel</strong>, hosting and the temporary file transfer described above.</li>
          <li><strong>Google AdSense</strong>, advertising on the Free plan.</li>
          <li><strong>Resend</strong>, delivering your contact-form messages to our support inbox.</li>
        </ul>

        <h2>7. Data retention</h2>
        <p>
          Your study data is kept until you delete it or close your account. Daily usage counters
          reset each day. Contact messages remain in our support inbox. Shared quizzes stay
          available until you ask us to remove them or you close your account.
        </p>

        <h2>8. Your rights and choices</h2>
        <ul>
          <li>Access, correct or delete the personal data we hold about you.</li>
          <li>Delete your account, which removes your synced study data.</li>
          <li>Clear the settings and cache stored on your device by clearing your browser data.</li>
          <li>Opt out of personalised ads through Google's Ads Settings.</li>
        </ul>
        <p>To make any of these requests, email <a href="mailto:support@revyy.app">support@revyy.app</a>.</p>

        <h2>9. Children</h2>
        <p>
          Revyy is intended for students old enough to hold an account under their local rules
          (generally 13, or 16 in parts of the EU). It is not directed at younger children, and we
          do not knowingly collect their data.
        </p>

        <h2>10. Changes and contact</h2>
        <p>
          We may update this policy as the product changes, and will update the date above when we
          do. For any privacy question or request, email{" "}
          <a href="mailto:support@revyy.app">support@revyy.app</a> or visit our{" "}
          <Link to="/contact">Contact page</Link>.
        </p>
      </div>
    </section>
  );
}
