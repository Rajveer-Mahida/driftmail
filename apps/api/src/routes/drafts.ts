import { Hono } from "hono";
import type { HonoEnv } from "../env.ts";
import { listDrafts, getDraft, upsertDraft, deleteDraft } from "../db.ts";
import { scopeOf } from "../middleware.ts";

export const drafts = new Hono<HonoEnv>();

drafts.get("/", async (c) => c.json(await listDrafts(c.env.DB, scopeOf(c))));

drafts.get("/:id", async (c) => {
  const d = await getDraft(c.env.DB, scopeOf(c), c.req.param("id"));
  // 404 rather than 403 for someone else's draft: a 403 would confirm it exists.
  if (!d) return c.json({ error: "not found" }, 404);
  return c.json(d);
});

// Create or update (autosave).
drafts.post("/", async (c) => {
  const b = await c.req
    .json<{
      id?: string;
      to_addr?: string;
      cc?: string | null;
      bcc?: string | null;
      subject?: string | null;
      text?: string | null;
      html?: string | null;
      in_reply_to_id?: string | null;
      attachments?: string | null;
    }>()
    .catch(() => null);
  if (!b) return c.json({ error: "invalid json" }, 400);
  const row = await upsertDraft(c.env.DB, scopeOf(c), { ...b, to_addr: b.to_addr ?? "" });
  return c.json(row);
});

drafts.delete("/:id", async (c) => {
  await deleteDraft(c.env.DB, scopeOf(c), c.req.param("id"));
  return c.json({ ok: true });
});
