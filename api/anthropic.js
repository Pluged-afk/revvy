// Server-side proxy for the Anthropic Messages API.
//
// The browser must NEVER hold the Anthropic key, and api.anthropic.com does
// not allow direct browser calls (CORS). So the quiz-app sends its request
// body here, this function adds the secret key + version header, requests a
// STREAM from Anthropic, and pipes the assembled text back to the client as it
// arrives. Streaming keeps the connection alive on long generations (large
// PDFs / high max_tokens) so the gateway doesn't 504. The client accumulates
// the full text and only renders once it's complete — no partial UI.
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
        // Allows messages to reference uploaded files via source.type "file".
        "anthropic-beta": "files-api-2025-04-14",
      },
      body: JSON.stringify({ model, max_tokens, system, messages, stream: true }),
    });

    // Errors (bad model, auth, oversized, etc.) come back before the stream —
    // return them as JSON so the client's !res.ok branch can read the message.
    if (!upstream.ok) {
      const errJson = await upstream.json().catch(() => ({}));
      console.error(`[anthropic] ${upstream.status} for model "${model}":`, JSON.stringify(errJson?.error || errJson));
      return res.status(upstream.status).json(errJson?.error ? errJson : { error: { message: `Error ${upstream.status}` } });
    }

    // Stream the assembled text (concatenated text deltas) to the client.
    res.status(200);
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("X-Accel-Buffering", "no");

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let inTok = 0, outTok = 0, stopReason = null;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const ev = JSON.parse(payload);
          if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
            res.write(ev.delta.text);
          } else if (ev.type === "message_start") {
            inTok = ev.message?.usage?.input_tokens ?? inTok;
          } else if (ev.type === "message_delta") {
            if (ev.usage?.output_tokens != null) outTok = ev.usage.output_tokens;
            if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
          } else if (ev.type === "error") {
            console.error("[anthropic] stream error:", JSON.stringify(ev.error));
          }
        } catch { /* ignore keep-alive / partial frames */ }
      }
    }
    // Usage + cost (Haiku 4.5: $1/1M in, $5/1M out). TRUNCATED = max_tokens hit.
    const cost = (inTok * 1 + outTok * 5) / 1e6;
    console.log(`[anthropic] usage · in=${inTok} out=${outTok} stop=${stopReason} ~$${cost.toFixed(4)}${stopReason === "max_tokens" ? " ⚠️ TRUNCATED (raise max_tokens / fewer questions)" : ""}`);
    return res.end();
  } catch (err) {
    console.error("[anthropic] proxy request threw:", err?.message || err);
    if (res.headersSent) return res.end();
    return res.status(502).json({ error: { message: err.message || "Upstream request failed." } });
  }
}

async function readRaw(req) {
  const chunks = [];
  for await (const c of req) chunks.push(typeof c === "string" ? Buffer.from(c) : c);
  return Buffer.concat(chunks).toString("utf8");
}
