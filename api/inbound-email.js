import crypto from "node:crypto";

// Inbound email webhook for Resend.
//
// Resend (Domains → revyy.app → Inbound) POSTs every email received at the
// domain to this endpoint. We forward it on to the support inbox using Resend's
// send API, with reply-to set to the original sender so replies reach them.
//
// Raw body parsing stays OFF so the Svix signature (if a secret is configured)
// can be verified against the exact bytes Resend signed.
export const config = { api: { bodyParser: false } };

const FORWARD_TO = "revyy.support@gmail.com";
// Sender must be on a Resend-verified domain (revyy.app). Override via env.
const FORWARD_FROM = process.env.RESEND_FROM || "Revyy Inbound <inbound@revyy.app>";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_API_KEY) {
    console.error("[inbound] missing RESEND_API_KEY");
    return res.status(500).json({ error: "Server missing RESEND_API_KEY." });
  }

  const raw = (await readRaw(req)).toString("utf8");

  // Optional signature check — only enforced when a secret is configured.
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (secret && !verifySvix(secret, req.headers, raw)) {
    console.error("[inbound] signature verification failed");
    return res.status(401).json({ error: "Invalid signature." });
  }

  let payload;
  try { payload = raw ? JSON.parse(raw) : {}; }
  catch { return res.status(400).json({ error: "Invalid JSON." }); }

  // Resend may wrap the email under `data`; tolerate a flat payload too.
  const d = payload.data && typeof payload.data === "object" ? payload.data : payload;
  const from = stringifyAddr(d.from) || "unknown sender";
  const to = Array.isArray(d.to) ? d.to.map(stringifyAddr).join(", ") : (stringifyAddr(d.to) || "");
  const subject = d.subject || "(no subject)";
  const text = d.text || "";
  const html = d.html || "";

  console.log(`[inbound] from="${from}" subject="${subject}" → ${FORWARD_TO}`);

  const header = `---------- Forwarded message ----------\nFrom: ${from}\nTo: ${to}\nSubject: ${subject}\n\n`;
  const htmlHeader = `<div style="color:#64748b;font-size:13px;border-bottom:1px solid #e2e8f0;padding-bottom:8px;margin-bottom:12px">` +
    `Forwarded message<br><b>From:</b> ${escapeHtml(from)}<br><b>To:</b> ${escapeHtml(to)}<br><b>Subject:</b> ${escapeHtml(subject)}</div>`;

  const body = {
    from: FORWARD_FROM,
    to: [FORWARD_TO],
    reply_to: from,
    subject: `Fwd: ${subject}`,
    text: text ? header + text : header + "(no plain-text body)",
  };
  if (html) body.html = htmlHeader + html;

  // Forward original attachments when Resend includes their content.
  const attachments = Array.isArray(d.attachments)
    ? d.attachments
        .filter((a) => a && (a.content || a.content_base64) && (a.filename || a.name))
        .map((a) => ({ filename: a.filename || a.name, content: a.content || a.content_base64 }))
    : [];
  if (attachments.length) body.attachments = attachments;

  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_API_KEY}` },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const err = await r.text().catch(() => "");
      console.error(`[inbound] forward failed ${r.status}:`, err);
      return res.status(502).json({ error: "Failed to forward email." });
    }
    console.log("[inbound] forwarded ok");
    return res.status(200).json({ forwarded: true });
  } catch (e) {
    console.error("[inbound] forward threw:", e.message);
    return res.status(502).json({ error: "Failed to forward email." });
  }
}

// Resend "from"/"to" can be a string or an { address, name } object.
function stringifyAddr(a) {
  if (!a) return "";
  if (typeof a === "string") return a;
  if (typeof a === "object") {
    const email = a.address || a.email || "";
    return a.name ? `${a.name} <${email}>` : email;
  }
  return String(a);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// Verify a Svix-signed webhook (Resend uses Svix). Header `svix-signature` is a
// space-separated list of `v1,<base64>` entries; the signed content is
// `${id}.${timestamp}.${rawBody}`, HMAC-SHA256 with the base64 secret body.
function verifySvix(secret, headers, rawBody) {
  try {
    const id = headers["svix-id"];
    const ts = headers["svix-timestamp"];
    const sigHeader = headers["svix-signature"];
    if (!id || !ts || !sigHeader) return false;
    const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
    const expected = crypto.createHmac("sha256", key).update(`${id}.${ts}.${rawBody}`).digest("base64");
    const expBuf = Buffer.from(expected);
    return sigHeader.split(" ").some((part) => {
      const sig = part.split(",")[1];
      if (!sig) return false;
      const sigBuf = Buffer.from(sig);
      return sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf);
    });
  } catch {
    return false;
  }
}

async function readRaw(req) {
  const chunks = [];
  for await (const c of req) chunks.push(typeof c === "string" ? Buffer.from(c) : c);
  return Buffer.concat(chunks);
}
