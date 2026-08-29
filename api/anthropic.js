// Server-side proxy for the Anthropic Messages API.
//
// The browser must NEVER hold the Anthropic key, and api.anthropic.com does
// not allow direct browser calls (CORS). So the quiz-app sends its request
// body here, this function adds the secret key + version header, requests a
// STREAM from Anthropic, and pipes the assembled text back to the client as it
// arrives. Streaming keeps the connection alive on long generations (large
// PDFs / high max_tokens) so the gateway doesn't 504. The client accumulates
// the full text and only renders once it's complete, no partial UI.
//
// Requires ANTHROPIC_API_KEY in the server environment (Vercel → Settings →
// Environment Variables, NOT prefixed with VITE_).

import { verifyToken } from "@clerk/backend";
import sql from "./db.js";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

// Abuse guards. This proxy spends the server's Anthropic key, so a signed-in
// user must not be able to turn it into an unmetered, arbitrary-cost gateway.
const ALLOWED_MODEL = /^claude-haiku-/i; // the cheap tier the app uses; reject pricier models
const MAX_OUTPUT_TOKENS = 64000;         // hard ceiling on client-requested max_tokens
const MAX_AI_CALLS_DAILY = 400;          // per-account proxy calls/day (generous for heavy Pro use)

// Per-account daily call counter (own tiny table, self-provisioned + cached per
// warm lambda). Fail-OPEN on any DB hiccup so a counter blip never breaks
// generation, the model pin + token cap still bound per-call cost regardless.
let aiRateReady = false;
async function underRateLimit(userId) {
  try {
    if (!aiRateReady) {
      await sql`CREATE TABLE IF NOT EXISTS ai_rate (
        clerk_user_id TEXT NOT NULL,
        day           DATE NOT NULL DEFAULT CURRENT_DATE,
        calls         INT  NOT NULL DEFAULT 0,
        PRIMARY KEY (clerk_user_id, day)
      )`;
      aiRateReady = true;
    }
    const rows = await sql`INSERT INTO ai_rate (clerk_user_id, day, calls) VALUES (${userId}, CURRENT_DATE, 1)
                           ON CONFLICT (clerk_user_id, day) DO UPDATE SET calls = ai_rate.calls + 1
                           RETURNING calls`;
    if (Math.random() < 0.02) { try { await sql`DELETE FROM ai_rate WHERE day < CURRENT_DATE - 2`; } catch { /* ignore */ } }
    return (rows[0]?.calls || 1) <= MAX_AI_CALLS_DAILY;
  } catch (e) {
    console.error("[anthropic] rate-limit check failed (allowing):", e.message);
    return true;
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: { message: "Method not allowed" } });
  }

  // Require a signed-in user, this proxy spends the server's Anthropic key,
  // so it must never be callable anonymously (client usage limits aren't a gate).
  const authz = req.headers.authorization || "";
  const token = authz.startsWith("Bearer ") ? authz.slice(7) : "";
  if (!token) return res.status(401).json({ error: { message: "Sign in to use this feature." } });
  let userId;
  try { const payload = await verifyToken(token, { secretKey: process.env.CLERK_SECRET_KEY }); userId = payload?.sub; }
  catch { return res.status(401).json({ error: { message: "Invalid session." } }); }
  if (!userId) return res.status(401).json({ error: { message: "Invalid session." } });

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
  // Pin the model to the cheap tier the app uses, clamp the output budget, and
  // rate-limit per account, so this authenticated proxy can't be driven as an
  // arbitrary-cost Anthropic gateway.
  if (!ALLOWED_MODEL.test(String(model))) {
    return res.status(400).json({ error: { message: "Unsupported model." } });
  }
  const safeMaxTokens = Math.min(Math.max(parseInt(max_tokens, 10) || 4000, 1), MAX_OUTPUT_TOKENS);
  if (!(await underRateLimit(userId))) {
    return res.status(429).json({ error: { message: "You have reached today's generation limit. Please try again tomorrow." } });
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
      body: JSON.stringify({ model, max_tokens: safeMaxTokens, system, messages, stream: true }),
    });

    // Errors (bad model, auth, oversized, etc.) come back before the stream, 
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
