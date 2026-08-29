// Contact form submissions → emailed to the support inbox via Resend.
// Sends from support@revyy.app (a Resend-verified domain) with reply-to set to
// the submitter so a reply goes straight back to them. Needs RESEND_API_KEY.
import sql from "./db.js";

const SEND_TO = "revyy.support@gmail.com";
const SEND_FROM = process.env.RESEND_FROM_CONTACT || "Revyy Contact <support@revyy.app>";

// Per-day caps, keyed by the sender's IP so nobody can flood the inbox. The
// general contact form is capped low; in-app "report a bug" gets more room since
// those are real issues the founder acts on. "Day" is the calendar day
// (CURRENT_DATE), so it resets at midnight, not 24h after the last send.
const CONTACT_DAILY = 2;
const BUG_DAILY = 5;

let contactRateReady = false;
async function ensureContactRate() {
  if (contactRateReady) return;
  await sql`CREATE TABLE IF NOT EXISTS contact_rate (
    ip    TEXT NOT NULL,
    day   DATE NOT NULL DEFAULT CURRENT_DATE,
    kind  TEXT NOT NULL,
    count INT  NOT NULL DEFAULT 0,
    PRIMARY KEY (ip, day, kind)
  )`;
  contactRateReady = true;
}
// Today's send count for this IP + kind. Fail-OPEN (0) on any DB hiccup so a
// counter problem never blocks a genuine message.
async function contactCount(ip, kind) {
  try {
    await ensureContactRate();
    const rows = await sql`SELECT count FROM contact_rate WHERE ip = ${ip} AND day = CURRENT_DATE AND kind = ${kind}`;
    return rows[0]?.count || 0;
  } catch (e) { console.error("[contact] rate read failed (allowing):", e.message); return 0; }
}
// Count a SUCCESSFUL send (so a failed send never uses up a slot).
async function bumpContact(ip, kind) {
  try {
    await ensureContactRate();
    await sql`INSERT INTO contact_rate (ip, day, kind, count) VALUES (${ip}, CURRENT_DATE, ${kind}, 1)
              ON CONFLICT (ip, day, kind) DO UPDATE SET count = contact_rate.count + 1`;
    if (Math.random() < 0.03) { try { await sql`DELETE FROM contact_rate WHERE day < CURRENT_DATE - 2`; } catch { /* ignore */ } }
  } catch (e) { console.error("[contact] rate bump failed:", e.message); }
}
function clientIp(req) {
  return (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.headers["x-real-ip"] || "unknown";
}

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
  const kind = body.kind === "bug" ? "bug" : "contact";

  if (!name || !email || !message) return res.status(400).json({ error: "Name, email and message are required." });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Please enter a valid email address." });
  if (name.length > 200 || email.length > 200) return res.status(400).json({ error: "Name or email is too long." });
  if (message.length > 5000) return res.status(400).json({ error: "Message is too long (max 5000 characters)." });

  // Per-IP daily cap (invisible unless exceeded). Bug reports get more room.
  const ip = clientIp(req);
  const cap = kind === "bug" ? BUG_DAILY : CONTACT_DAILY;
  if ((await contactCount(ip, kind)) >= cap) {
    return res.status(429).json({ error: "You have reached today's limit. Please try again tomorrow.", code: "rate_limited" });
  }

  const subject = `Contact form, ${name}`;
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
    await bumpContact(ip, kind); // only a delivered message uses a daily slot
    console.log(`[contact] sent (${kind}) from "${name}" <${email}>`);
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
