// Contact form submissions → emailed to the support inbox via Resend.
// Sends from support@revyy.app (a Resend-verified domain) with reply-to set to
// the submitter so a reply goes straight back to them. Needs RESEND_API_KEY.
const SEND_TO = "revyy.support@gmail.com";
const SEND_FROM = process.env.RESEND_FROM_CONTACT || "Revyy Contact <support@revyy.app>";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_API_KEY) {
    console.error("[contact] missing RESEND_API_KEY");
    return res.status(500).json({ error: "Server missing RESEND_API_KEY." });
  }

  const body = await readBody(req);
  const name = String(body.name || "").trim();
  const email = String(body.email || "").trim();
  const message = String(body.message || "").trim();

  if (!name || !email || !message) return res.status(400).json({ error: "Name, email and message are required." });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Please enter a valid email address." });
  if (message.length > 5000) return res.status(400).json({ error: "Message is too long (max 5000 characters)." });

  const subject = `Contact form — ${name}`;
  const text = `New contact form submission\n\nName: ${name}\nEmail: ${email}\n\n${message}`;
  const html =
    `<div style="font-family:system-ui,-apple-system,sans-serif;font-size:14px;line-height:1.6;color:#1e293b">` +
    `<h2 style="margin:0 0 12px">New contact form submission</h2>` +
    `<p style="margin:0 0 4px"><b>Name:</b> ${escapeHtml(name)}</p>` +
    `<p style="margin:0 0 12px"><b>Email:</b> ${escapeHtml(email)}</p>` +
    `<div style="white-space:pre-wrap;border-top:1px solid #e2e8f0;padding-top:12px">${escapeHtml(message)}</div></div>`;

  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_API_KEY}` },
      body: JSON.stringify({ from: SEND_FROM, to: [SEND_TO], reply_to: email, subject, text, html }),
    });
    if (!r.ok) {
      const err = await r.text().catch(() => "");
      console.error(`[contact] send failed ${r.status}:`, err);
      return res.status(502).json({ error: "Failed to send message. Please try again." });
    }
    console.log(`[contact] sent from "${name}" <${email}>`);
    return res.status(200).json({ sent: true });
  } catch (e) {
    console.error("[contact] threw:", e.message);
    return res.status(502).json({ error: "Failed to send message. Please try again." });
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  const chunks = [];
  for await (const c of req) chunks.push(typeof c === "string" ? Buffer.from(c) : c);
  const raw = Buffer.concat(chunks).toString("utf8");
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}
