import { Hono } from "hono";
import type { HonoEnv } from "../env.ts";
import { listRules, createRule, updateRule, deleteRule, applyRulesToExisting } from "../db.ts";
import { scopeOf } from "../middleware.ts";

export const rules = new Hono<HonoEnv>();

const FIELDS = ["from", "to", "subject"];
const OPS = ["contains", "equals", "startswith", "endswith"];
const ACTIONS = ["label", "archive", "read", "trash"];

rules.get("/", async (c) => c.json(await listRules(c.env.DB, scopeOf(c))));

rules.post("/", async (c) => {
  const b = await c.req
    .json<{ field?: string; op?: string; value?: string; action?: string; action_value?: string | null }>()
    .catch(() => ({}) as Record<string, never>);

  if (!b.field || !FIELDS.includes(b.field)) return c.json({ error: "invalid field" }, 400);
  if (!b.op || !OPS.includes(b.op)) return c.json({ error: "invalid op" }, 400);
  if (!b.value?.trim()) return c.json({ error: "value required" }, 400);
  if (!b.action || !ACTIONS.includes(b.action)) return c.json({ error: "invalid action" }, 400);
  if (b.action === "label" && !b.action_value) return c.json({ error: "label required" }, 400);

  const row = await createRule(c.env.DB, scopeOf(c), {
    field: b.field,
    op: b.op,
    value: b.value.trim(),
    action: b.action,
    action_value: b.action === "label" ? b.action_value : null,
  });
  return c.json(row, 201);
});

rules.post("/update", async (c) => {
  const b = await c.req
    .json<{ id?: string; enabled?: boolean }>()
    .catch(() => ({}) as Record<string, never>);
  if (!b.id || typeof b.enabled !== "boolean") return c.json({ error: "id + enabled required" }, 400);
  await updateRule(c.env.DB, scopeOf(c), b.id, b.enabled ? 1 : 0);
  return c.json({ ok: true });
});

rules.post("/delete", async (c) => {
  const b = await c.req.json<{ id?: string }>().catch(() => ({}) as { id?: string });
  if (!b.id) return c.json({ error: "id required" }, 400);
  await deleteRule(c.env.DB, scopeOf(c), b.id);
  return c.json({ ok: true });
});

// Re-run rules over existing inbound mail.
rules.post("/run", async (c) => {
  const touched = await applyRulesToExisting(c.env.DB, scopeOf(c));
  return c.json({ ok: true, touched });
});
