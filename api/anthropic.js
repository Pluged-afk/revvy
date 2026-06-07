// Server-side proxy for the Anthropic Messages API.
//
// The browser must NEVER hold the Anthropic key, and api.anthropic.com does
// not allow direct browser calls (CORS). So the quiz-app sends its request
// body here and this function adds the secret key + version header and
// forwards it, returning Anthropic's JSON response unchanged.
//
// Requires ANTHROPIC_API_KEY in the server environment (Vercel → Settings →
// Environment Variables — NOT prefixed with VITE_).

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: { message: "Method not allowed" } });
  }

  const KEY = process.env.ANTHROPIC_API_KEY;
  if (!KEY) return res.status(500).json({ error: { message: "Server missing ANTHROPIC_API_KEY." } });

  let body = req.body;
  if (!body || typeof body !== "object") {
    try { body = JSON.parse(await readRaw(req) || "{}"); } catch { body = {}; }
  }

  // Only forward the fields the client is allowed to set.
  const { model, max_tokens, system, messages } = body;
  if (!model || !Array.isArray(messages)) {
    return res.status(400).json({ error: { message: "Missing model or messages." } });
  }

  try {
    const upstream = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model, max_tokens, system, messages }),
    });
    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      // Surface the real Anthropic error in the server logs (Vercel → Logs).
      console.error(
        `[anthropic] ${upstream.status} for model "${model}":`,
        JSON.stringify(data?.error || data)
      );
    }
    return res.status(upstream.status).json(data);
  } catch (err) {
    console.error("[anthropic] proxy request threw:", err?.message || err);
    return res.status(502).json({ error: { message: err.message || "Upstream request failed." } });
  }
}

async function readRaw(req) {
  const chunks = [];
  for await (const c of req) chunks.push(typeof c === "string" ? Buffer.from(c) : c);
  return Buffer.concat(chunks).toString("utf8");
}
