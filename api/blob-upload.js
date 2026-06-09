import { handleUpload } from "@vercel/blob/client";
import { verifyToken } from "@clerk/backend";
import { readBody } from "./db.js";
import sql from "./db.js";

// Mints a short-lived client-upload token for Vercel Blob — but ONLY for Pro
// users. The client passes its Clerk session token as clientPayload; we verify
// it and check is_pro in Neon before allowing a large direct-to-Blob upload.
// Requires BLOB_READ_WRITE_TOKEN in the server environment.
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const body = await readBody(req);

  try {
    const json = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async (_pathname, clientPayload) => {
        let userId;
        try {
          const payload = await verifyToken(clientPayload || "", { secretKey: process.env.CLERK_SECRET_KEY });
          userId = payload.sub;
        } catch {
          throw new Error("Unauthorized.");
        }
        const rows = await sql`SELECT is_pro FROM profiles WHERE clerk_user_id = ${userId} OR id = ${userId} LIMIT 1`;
        if (!rows[0]?.is_pro) throw new Error("Large uploads are a Pro feature.");
        return {
          allowedContentTypes: ["application/pdf", "image/png", "image/jpeg", "image/webp", "image/gif"],
          maximumSizeInBytes: 100 * 1024 * 1024, // 100 MB ceiling for Pro
          addRandomSuffix: true, // unique blob name per upload — no conflicts
          tokenPayload: JSON.stringify({ userId }),
        };
      },
      // Not relied upon (we forward to Anthropic separately); no-op.
      onUploadCompleted: async () => {},
    });
    return res.status(200).json(json);
  } catch (e) {
    console.error("[blob-upload]", e.message);
    return res.status(400).json({ error: e.message || "Upload not allowed." });
  }
}
