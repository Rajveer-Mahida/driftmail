import { Hono } from "hono";
import type { HonoEnv } from "../env.ts";
import { getAttachmentByCid, ownsR2Key } from "../db.ts";
import { scopeOf } from "../middleware.ts";

export const attachments = new Hono<HonoEnv>();

/** Legacy layout, from before objects were namespaced by owner. Keys under
 *  these prefixes are still served, but only after an ownership lookup. */
const LEGACY_PREFIXES = ["attachments/", "emails/", "uploads/"];
const INLINE_EXT = ["png", "jpg", "jpeg", "gif", "webp", "pdf", "txt"];

// GET /api/attachments/cid?mid=&cid=  → inline image referenced by Content-ID
attachments.get("/cid", async (c) => {
  const mid = c.req.query("mid");
  const cid = c.req.query("cid");
  if (!mid || !cid) return c.json({ error: "mid and cid required" }, 400);

  const att = await getAttachmentByCid(c.env.DB, scopeOf(c), mid, decodeURIComponent(cid));
  if (!att) return c.json({ error: "not found" }, 404);

  const obj = await c.env.EMAIL_CACHE.get(att.r2_key);
  if (!obj) return c.json({ error: "not found" }, 404);

  return new Response(obj.body, {
    headers: {
      "content-type":
        att.mime_type ?? obj.httpMetadata?.contentType ?? "application/octet-stream",
      "cache-control": "private, max-age=86400",
      "content-disposition": "inline",
    },
  });
});

// GET /api/attachments/*  → raw object from R2, if the caller owns it.
//
// Being signed in is not enough: without the ownership check below, any user
// could read any other user's attachments and raw .eml files by guessing or
// replaying a key.
attachments.get("/*", async (c) => {
  const uid = scopeOf(c);
  const fullKey = c.req.path.replace(/^\/api\/attachments\//, "");

  // Two ways to establish ownership: the key is inside this user's namespace,
  // or a row they own points at it.
  const owned =
    fullKey.startsWith(`u/${uid}/`) ||
    (LEGACY_PREFIXES.some((p) => fullKey.startsWith(p)) &&
      (await ownsR2Key(c.env.DB, uid, fullKey)));

  // 404, not 403: a 403 would confirm that the object exists.
  if (!owned) return c.json({ error: "not found" }, 404);

  const obj = await c.env.EMAIL_CACHE.get(fullKey);
  if (!obj) return c.json({ error: "not found" }, 404);

  const ext = fullKey.split(".").pop()?.toLowerCase();
  const isInline = INLINE_EXT.includes(ext ?? "");

  return new Response(obj.body, {
    headers: {
      "content-type": obj.httpMetadata?.contentType ?? "application/octet-stream",
      "content-length": String(obj.size),
      "cache-control": "private, max-age=3600",
      "content-disposition": isInline ? "inline" : "attachment",
    },
  });
});
