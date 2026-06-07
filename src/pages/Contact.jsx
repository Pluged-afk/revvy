import { useState } from "react";
import { Link } from "react-router-dom";
import emailjs from "@emailjs/browser";
import usePageMeta from "../lib/usePageMeta.js";

// EmailJS config (public by design — the public key is safe in client code).
const EMAILJS_SERVICE_ID = "service_nxh1vpu";
const EMAILJS_TEMPLATE_ID = "template_6cwrm14";
const EMAILJS_PUBLIC_KEY = "RHMZNoZuyGsSenMXI";

export default function Contact() {
  usePageMeta("Contact — Revyy", "Questions, feedback, or feature ideas? Get in touch with the Revyy team.");
  const [form, setForm] = useState({ name: "", email: "", message: "" });
  const [status, setStatus] = useState("idle"); // idle | sending | sent | error
  const [errMsg, setErrMsg] = useState("");

  const update = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const onSubmit = async (e) => {
    e.preventDefault();
    setStatus("sending");
    setErrMsg("");
    try {
      await emailjs.send(
        EMAILJS_SERVICE_ID,
        EMAILJS_TEMPLATE_ID,
        {
          // Sent with several common aliases so the template fields resolve
          // regardless of which variable names it uses.
          name: form.name,
          from_name: form.name,
          email: form.email,
          from_email: form.email,
          reply_to: form.email,
          message: form.message,
        },
        { publicKey: EMAILJS_PUBLIC_KEY }
      );
      setStatus("sent");
      setForm({ name: "", email: "", message: "" }); // clear after sending
    } catch (err) {
      setStatus("error");
      setErrMsg(err?.text || "Something went wrong. Please try again or email us directly.");
    }
  };

  const sending = status === "sending";

  return (
    <>
      <section className="hero" style={{ padding: "84px 0 90px" }}>
        <div className="container">
          <span className="eyebrow">Contact</span>
          <h1>Get in touch</h1>
          <p className="hero-sub">Questions, feedback, or feature ideas? We'd love to hear from you.</p>
        </div>
      </section>

      <section className="section">
        <div className="container contact-grid">
          {/* Form */}
          <div>
            {status === "sent" && (
              <div className="form-success">✓ Message sent! We'll reply within 24 hours.</div>
            )}
            {status === "error" && (
              <div className="auth-error">{errMsg}</div>
            )}
            <form onSubmit={onSubmit}>
              <div className="form-field">
                <label htmlFor="name">Name</label>
                <input id="name" type="text" required value={form.name} onChange={update("name")} placeholder="Your name" disabled={sending} />
              </div>
              <div className="form-field">
                <label htmlFor="email">Email</label>
                <input id="email" type="email" required value={form.email} onChange={update("email")} placeholder="you@example.com" disabled={sending} />
              </div>
              <div className="form-field">
                <label htmlFor="message">Message</label>
                <textarea id="message" required value={form.message} onChange={update("message")} placeholder="How can we help?" disabled={sending} />
              </div>
              <button type="submit" className="btn btn-primary btn-lg" disabled={sending}>
                {sending ? "Sending…" : "Send Message →"}
              </button>
            </form>
          </div>

          {/* Side info */}
          <div>
            <div className="contact-card" style={{ marginBottom: 18 }}>
              <h3>Email us</h3>
              <p>Prefer email? Reach us directly:</p>
              <a className="maillink" href="mailto:revyyapp@outlook.com">revyyapp@outlook.com</a>
            </div>
            <div className="contact-card" style={{ marginBottom: 18 }}>
              <h3>Response time</h3>
              <span className="note-pill">⏱ We reply within 24 hours</span>
            </div>
            <div className="contact-card">
              <h3>Quick links</h3>
              <p style={{ margin: 0 }}>
                <Link to="/pricing" className="maillink">Pricing & plans</Link><br />
                <Link to="/features" className="maillink">Feature overview</Link><br />
                <Link to="/privacy" className="maillink">Privacy Policy</Link><br />
                <Link to="/terms" className="maillink">Terms of Service</Link>
              </p>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
