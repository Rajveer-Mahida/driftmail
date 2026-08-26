import { Hono } from "hono";
import type { HonoEnv } from "../env.ts";
import {
  listLabels,
  createLabel,
  deleteLabel,
  getViewCounts,
  getLabelCounts,
  draftCount,
} from "../db.ts";
import { scopeOf } from "../middleware.ts";

export const labels = new Hono<HonoEnv>();

labels.get("/", async (c) => c.json(await listLabels(c.env.DB, scopeOf(c))));

labels.post("/", async (c) => {
  const { name, color } = await c.req
    .json<{ name?: string; color?: string }>()
    .catch(() => ({}) as Record<string, never>);
  if (!name?.trim()) return c.json({ error: "name required" }, 400);
  const label = await createLabel(c.env.DB, scopeOf(c), name.trim(), color ?? "#888888");
  return c.json(label, 201);
});

labels.delete("/", async (c) => {
  const { id } = await c.req.json<{ id?: string }>().catch(() => ({}) as { id?: string });
  if (!id) return c.json({ error: "id required" }, 400);
  await deleteLabel(c.env.DB, scopeOf(c), id);
  return c.json({ ok: true });
});

// GET /api/counts → sidebar view + label counts
export const counts = new Hono<HonoEnv>();
counts.get("/", async (c) => {
  const uid = scopeOf(c);
  const [views, labelCounts, drafts] = await Promise.all([
    getViewCounts(c.env.DB, uid),
    getLabelCounts(c.env.DB, uid),
    draftCount(c.env.DB, uid),
  ]);
  return c.json({ views, labels: labelCounts, drafts });
});
