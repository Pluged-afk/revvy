import { del } from "@vercel/blob";
import { verifyToken } from "@clerk/backend";

// Two jobs in one function (kept together to stay under Vercel's function limit):
//
//  1) Upload a file to the Anthropic Files API -> { file_id }.
//     - Direct (free / <=4.5 MB): raw bytes in the body, filename in x-filename.
//     - Blob (Pro / large): browser uploads to Vercel Blob first, then sends
//       JSON { blobUrl, filename, contentType }; we fetch it server-side, forward
//       it, then delete the blob.
//
//  2) Transcribe an audio/video lecture with AssemblyAI (Pro):
//     - POST JSON { transcribe:true, blobUrl } -> { transcriptId }
//     - GET  ?transcript=<id>                 -> { status, text }
//     The Blob bytes are pulled server-side and handed to AssemblyAI's OWN
//     upload endpoint (a private URL only it can use), and the Blob is deleted
//     right away, so no public URL is ever handed to a third party. blobUrl is
//     validated to be one of OUR Vercel Blob URLs, so this can't be turned into
//     an SSRF fetch-any-URL tool.
export const config = { api: { bodyParser: false } };

const FILES_URL = "https://api.anthropic.com/v1/files";
const AAI = "https://api.assemblyai.com/v2";

async function rawBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(typeof c === "string" ? Buffer.from(c) : c);
  return Buffer.concat(chunks);
}

async function requireUser(req, res) {
  const authz = req.headers.authorization || "";
  const token = authz.startsWith("Bearer ") ? authz.slice(7) : "";
  if (!token) { res.status(401).json({ error: "Sign in to upload files." }); return false; }
  try { await verifyToken(token, { secretKey: process.env.CLERK_SECRET_KEY }); return true; }
  catch { res.status(401).json({ error: "Invalid session." }); return false; }
}

// SSRF guard: only ever fetch our own Vercel Blob URLs.
function isOwnBlobUrl(u) {
  try {
    const url = new URL(u);
    return url.protocol === "https:" && url.hostname.endsWith(".public.blob.vercel-storage.com");
  } catch { return false; }
}

// Forward a buffer to the Anthropic Files API -> file_id.
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
  // ── Poll a transcription (GET ?transcript=id) ──
  if (req.method === "GET") {
    if (!(await requireUser(req, res))) return;
    const id = String(req.query.transcript || "");
    if (!/^[A-Za-z0-9_-]{6,100}$/.test(id)) return res.status(400).json({ error: "Bad transcript id." });
    const KEY = process.env.ASSEMBLYAI_API_KEY;
    if (!KEY) return res.status(500).json({ error: "Server missing ASSEMBLYAI_API_KEY." });
    try {
      const r = await fetch(`${AAI}/transcript/${id}`, { headers: { authorization: KEY } });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return res.status(502).json({ error: "Could not check transcription." });
      return res.status(200).json({ status: d.status, text: d.text || "", error: d.error || "" });
    } catch (e) {
      console.error("[transcribe poll]", e?.message || e);
      return res.status(502).json({ error: "Could not check transcription." });
    }
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!(await requireUser(req, res))) return;

  const ct = req.headers["content-type"] || "";
  const buf = await rawBody(req);

  // ── JSON body: either a transcription submit, or the Blob -> Anthropic path ──
  if (ct.includes("application/json")) {
    let json = {};
    try { json = JSON.parse(buf.toString("utf8") || "{}"); } catch { /* ignore */ }

    // Transcription submit.
    if (json.transcribe) {
      const KEY = process.env.ASSEMBLYAI_API_KEY;
      if (!KEY) return res.status(500).json({ error: "Server missing ASSEMBLYAI_API_KEY." });
      if (!isOwnBlobUrl(json.blobUrl)) return res.status(400).json({ error: "Invalid file reference." });
      try {
        const media = await fetch(json.blobUrl);
        if (!media.ok) return res.status(502).json({ error: "Could not read the uploaded file." });
        const bytes = Buffer.from(await media.arrayBuffer());
        del(json.blobUrl).catch((e) => console.warn("[transcribe] blob del failed:", e?.message));
        if (!bytes.length) return res.status(400).json({ error: "The file was empty." });
        const up = await fetch(`${AAI}/upload`, { method: "POST", headers: { authorization: KEY }, body: bytes });
        const upJson = await up.json().catch(() => ({}));
        if (!up.ok || !upJson.upload_url) return res.status(502).json({ error: "Upload to the transcriber failed." });
        const tr = await fetch(`${AAI}/transcript`, {
          method: "POST",
          headers: { authorization: KEY, "content-type": "application/json" },
          body: JSON.stringify({ audio_url: upJson.upload_url }),
        });
        const trJson = await tr.json().catch(() => ({}));
        if (!tr.ok || !trJson.id) return res.status(502).json({ error: "Could not start transcription." });
        return res.status(200).json({ transcriptId: trJson.id });
      } catch (e) {
        console.error("[transcribe submit]", e?.message || e);
        return res.status(502).json({ error: "Transcription failed." });
      }
    }
  }

  // ── File upload to Anthropic (existing behaviour) ──
  const KEY = process.env.ANTHROPIC_API_KEY;
  if (!KEY) return res.status(500).json({ error: "Server missing ANTHROPIC_API_KEY." });

  try {
    let fileBuf, filename, contentType, blobUrl;

    if (ct.includes("application/json")) {
      // Pro/large path: fetch the already-uploaded blob.
      let json = {};
      try { json = JSON.parse(buf.toString("utf8") || "{}"); } catch { /* ignore */ }
      blobUrl = json.blobUrl;
      filename = json.filename || "upload";
      contentType = json.contentType || "application/octet-stream";
      if (!isOwnBlobUrl(blobUrl)) return res.status(400).json({ error: "Invalid file reference." });
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
