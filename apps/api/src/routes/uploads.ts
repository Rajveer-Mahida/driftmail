import { Hono } from "hono";
import type { HonoEnv } from "../env.ts";
import type { UploadedAttachment } from "@email/shared";
import { scopeOf } from "../middleware.ts";

export const uploads = new Hono<HonoEnv>();

const MAX_BYTES = 24 * 1024 * 1024; // keep under the 25 MiB email cap

type UploadFile = {
  name?: string;
  type?: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
};

// POST /api/uploads — multipart file → R2. Returns an UploadedAttachment.
uploads.post("/", async (c) => {
  const form = await c.req.formData().catch(() => null);
  const entry = form?.get("file") as unknown;
  if (!entry || typeof entry === "string") return c.json({ error: "file required" }, 400);
  const file = entry as UploadFile;
  if (file.size > MAX_BYTES) return c.json({ error: "file too large (max 24 MiB)" }, 413);

  const safeName = (file.name || "file").replace(/[^A-Za-z0-9._-]+/g, "_");
  // Namespaced by owner. A freshly uploaded blob has no database row until the
  // message is sent, so the attachment route can only authorize it by prefix.
  const key = `u/${scopeOf(c)}/uploads/${crypto.randomUUID()}-${safeName}`;
  const mime = file.type || "application/octet-stream";

  await c.env.EMAIL_CACHE.put(key, await file.arrayBuffer(), {
    httpMetadata: { contentType: mime },
  });

  const result: UploadedAttachment = {
    key,
    filename: file.name || safeName,
    mime_type: mime,
    size_bytes: file.size,
  };
  return c.json(result, 201);
});
