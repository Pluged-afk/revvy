import { del } from "@vercel/blob";
import { verifyToken } from "@clerk/backend";

// Audio / video transcription via AssemblyAI. The client uploads media to
// Vercel Blob first (Pro-gated in /api/blob-upload), then:
//   POST /api/transcribe { blobUrl }   -> { transcriptId }   (submit)
//   GET  /api/transcribe?id=<id>       -> { status, text }   (poll)
//
// Security: the Blob bytes are pulled server-side and streamed to AssemblyAI's
// OWN upload endpoint (which returns a private URL only AssemblyAI can use), and
// the Blob is deleted immediately after, so no public URL is ever handed to a
// third party and nothing lingers. The blobUrl is validated to be one of OUR
// Vercel Blob URLs, so this endpoint can't be turned into an SSRF fetch-any-URL
// tool. Requires ASSEMBLYAI_API_KEY (server-only, never sent to the browser).

const AAI = "https://api.assemblyai.com/v2";

async function requireUser(req, res) {
  const authz = req.headers.authorization || "";
  const token = authz.startsWith("Bearer ") ? authz.slice(7) : "";
  if (!token) { res.status(401).json({ error: "Sign in to transcribe." }); return false; }
  try { await verifyToken(token, { secretKey: process.env.CLERK_SECRET_KEY }); return true; }
  catch { res.status(401).json({ error: "Invalid session." }); return false; }
}

// Only ever fetch our own Vercel Blob URLs. This is the SSRF guard: without it,
// a caller could pass http://169.254.169.254/... or an internal address and make
// the server fetch it. Allowlist the Blob host + https only.
function isOwnBlobUrl(u) {
  try {
    const url = new URL(u);
    return url.protocol === "https:" && url.hostname.endsWith(".public.blob.vercel-storage.com");
  } catch { return false; }
}

export default async function handler(req, res) {
  const KEY = process.env.ASSEMBLYAI_API_KEY;
  if (!KEY) return res.status(500).json({ error: "Server missing ASSEMBLYAI_API_KEY." });
  if (!(await requireUser(req, res))) return;

  try {
    // ── Poll a transcript's status ──
    if (req.method === "GET") {
      const id = String(req.query.id || "");
      if (!/^[A-Za-z0-9_-]{6,100}$/.test(id)) return res.status(400).json({ error: "Bad transcript id." });
      const r = await fetch(`${AAI}/transcript/${id}`, { headers: { authorization: KEY } });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return res.status(502).json({ error: "Could not check transcription." });
      return res.status(200).json({ status: d.status, text: d.text || "", error: d.error || "" });
    }

    // ── Submit a transcription job ──
    if (req.method === "POST") {
      const blobUrl = req.body?.blobUrl;
      if (!isOwnBlobUrl(blobUrl)) return res.status(400).json({ error: "Invalid file reference." });

      // Pull the uploaded media, then delete the Blob straight away so it never
      // lingers publicly (we already have the bytes in memory).
      const media = await fetch(blobUrl);
      if (!media.ok) return res.status(502).json({ error: "Could not read the uploaded file." });
      const buf = Buffer.from(await media.arrayBuffer());
      del(blobUrl).catch((e) => console.warn("[transcribe] blob del failed:", e?.message));
      if (!buf.length) return res.status(400).json({ error: "The file was empty." });

      // Hand the bytes to AssemblyAI's private upload (returns a URL only it can use).
      const up = await fetch(`${AAI}/upload`, { method: "POST", headers: { authorization: KEY }, body: buf });
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
    }

    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("[transcribe]", e?.message || e);
    return res.status(502).json({ error: "Transcription failed." });
  }
}
