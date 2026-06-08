import { del } from "@vercel/blob";

// Uploads a file to the Anthropic Files API and returns its file_id.
//
// Two ingress paths:
//  1) Direct (free / ≤4.5 MB): browser sends raw bytes as the body, filename in
//     the x-filename header.
//  2) Blob (Pro / large): browser uploads straight to Vercel Blob first, then
//     sends JSON { blobUrl, filename, contentType }; we fetch the blob
//     server-side (no body limit), forward it, then delete the blob.
export const config = { api: { bodyParser: false } };

const FILES_URL = "https://api.anthropic.com/v1/files";

async function rawBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(typeof c === "string" ? Buffer.from(c) : c);
  return Buffer.concat(chunks);
}

// Forward a buffer to the Anthropic Files API → file_id.
async function sendToAnthropic(buf, filename, contentType, KEY) {
  const fd = new FormData();
  fd.append("file", new Blob([buf], { type: contentType || "application/octet-stream" }), filename || "upload");
  const upstream = await fetch(FILES_URL, {
    method: "POST",
    headers: {
      "x-api-key": KEY,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "files-api-2025-04-14",
    },
    body: fd,
  });
  const data = await upstream.json().catch(() => ({}));
  return { ok: upstream.ok, status: upstream.status, data };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const KEY = process.env.ANTHROPIC_API_KEY;
  if (!KEY) return res.status(500).json({ error: "Server missing ANTHROPIC_API_KEY." });

  const ct = req.headers["content-type"] || "";
  const buf = await rawBody(req);

  try {
    let fileBuf, filename, contentType, blobUrl;

    if (ct.includes("application/json")) {
      // Pro/large path: fetch the already-uploaded blob.
      let json = {};
      try { json = JSON.parse(buf.toString("utf8") || "{}"); } catch { /* ignore */ }
      blobUrl = json.blobUrl;
      filename = json.filename || "upload";
      contentType = json.contentType || "application/octet-stream";
      if (!blobUrl) return res.status(400).json({ error: "Missing blobUrl." });
      const r = await fetch(blobUrl);
      if (!r.ok) return res.status(502).json({ error: "Could not read uploaded blob." });
      fileBuf = Buffer.from(await r.arrayBuffer());
    } else {
      // Direct path: the body IS the file.
      fileBuf = buf;
      filename = decodeURIComponent(req.headers["x-filename"] || "upload");
      contentType = ct || "application/octet-stream";
    }

    if (!fileBuf || fileBuf.length === 0) return res.status(400).json({ error: "Empty upload." });

    const { ok, status, data } = await sendToAnthropic(fileBuf, filename, contentType, KEY);

    // Best-effort cleanup of the transient blob.
    if (blobUrl) del(blobUrl).catch((e) => console.warn("[upload-file] blob del failed:", e?.message));

    if (!ok) {
      console.error("[upload-file]", status, JSON.stringify(data?.error || data));
      return res.status(status).json({ error: data?.error?.message || "File upload failed." });
    }
    return res.status(200).json({ file_id: data.id });
  } catch (err) {
    console.error("[upload-file] threw:", err?.message || err);
    return res.status(502).json({ error: err.message || "Upload request failed." });
  }
}
