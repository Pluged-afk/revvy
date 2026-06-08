// Uploads a file to the Anthropic Files API and returns its file_id.
// The browser sends the raw file bytes as the request body (no base64), with
// the filename in the x-filename header. The secret key stays server-side.
//
// Note: Vercel caps the serverless request body at ~4.5 MB, so that's the
// effective per-upload ceiling here. For larger files, upload to blob storage
// first and forward from there.
export const config = { api: { bodyParser: false } };

const FILES_URL = "https://api.anthropic.com/v1/files";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const KEY = process.env.ANTHROPIC_API_KEY;
  if (!KEY) return res.status(500).json({ error: "Server missing ANTHROPIC_API_KEY." });

  const filename = decodeURIComponent(req.headers["x-filename"] || "upload");
  const contentType = req.headers["content-type"] || "application/octet-stream";

  let buf;
  try {
    const chunks = [];
    for await (const c of req) chunks.push(typeof c === "string" ? Buffer.from(c) : c);
    buf = Buffer.concat(chunks);
  } catch (e) {
    return res.status(400).json({ error: "Could not read upload body." });
  }
  if (!buf || buf.length === 0) return res.status(400).json({ error: "Empty upload." });

  try {
    // Node 18+ (Vercel) has global FormData/Blob/fetch. fetch sets the
    // multipart Content-Type (with boundary) automatically for FormData.
    const fd = new FormData();
    fd.append("file", new Blob([buf], { type: contentType }), filename);

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
    if (!upstream.ok) {
      console.error("[upload-file]", upstream.status, JSON.stringify(data?.error || data));
      return res.status(upstream.status).json({ error: data?.error?.message || "File upload failed." });
    }
    return res.status(200).json({ file_id: data.id });
  } catch (err) {
    console.error("[upload-file] threw:", err?.message || err);
    return res.status(502).json({ error: err.message || "Upload request failed." });
  }
}
