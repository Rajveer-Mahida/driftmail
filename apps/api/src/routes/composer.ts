// Composer support: which addresses the signed-in user may send from, and their
// saved templates.
//
// Templates live in user_settings as one JSON list, like the signature: they are
// personal, few, and small, so they don't need a table (or a migration).

import { Hono } from "hono";
import type { HonoEnv } from "../env.ts";
import { scopeOf } from "../middleware.ts";
import { listDomains } from "../config/domains.ts";
import { getUserSetting, setUserSetting } from "../config/user.ts";
import { resolveFrom, SendError } from "../send/index.ts";

export const composer = new Hono<HonoEnv>();

// ── Senders ──────────────────────────────────────────────────────────────────

/**
 * GET /api/compose/senders — the From picker's options, default first.
 * Everything listed passes resolveFrom's ownership check; admins may also type
 * any other address on the instance's domains.
 */
composer.get("/senders", async (c) => {
  const user = c.get("user");
  const domains = await listDomains(c.env.DB);
  const onOurDomain = (a: string) => domains.some((d) => a.endsWith(`@${d.domain.toLowerCase()}`));

  let fallback: string | null = null;
  try {
    fallback = await resolveFrom(c.env.DB, { user });
  } catch (err) {
    if (!(err instanceof SendError)) throw err;
  }

  const out: string[] = [];
  const add = (a: string | null | undefined) => {
    const v = a?.trim().toLowerCase();
    if (v && !out.includes(v)) out.push(v);
  };
  add(fallback);
  if (onOurDomain(user.email.toLowerCase())) add(user.email);
  for (const d of domains) add(`${user.handle}@${d.domain}`);

  const { results } = await c.env.DB.prepare(
    `SELECT address FROM aliases WHERE user_id = ? AND disabled = 0 ORDER BY address`,
  )
    .bind(user.id)
    .all<{ address: string }>();
  for (const r of results ?? []) add(r.address);

  if (user.role === "admin") for (const d of domains) add(d.default_from);

  return c.json({
    default: fallback,
    addresses: out,
    // Admins can send as anything on these domains; the picker offers "Other…".
    customDomains: user.role === "admin" ? domains.map((d) => d.domain) : [],
  });
});

// ── Templates ────────────────────────────────────────────────────────────────

export type Template = { id: string; name: string; subject: string; html: string; updated_at: number };

const MAX_TEMPLATES = 50;
const MAX_TEMPLATE_BYTES = 100_000;

async function loadTemplates(db: D1Database, userId: ReturnType<typeof scopeOf>): Promise<Template[]> {
  const raw = await getUserSetting(db, userId, "templates");
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter(
          (t): t is Template =>
            !!t && typeof t === "object" && typeof (t as Template).id === "string" && typeof (t as Template).html === "string",
        )
      : [];
  } catch {
    // A corrupt row must not break composing.
    return [];
  }
}

composer.get("/templates", async (c) => c.json(await loadTemplates(c.env.DB, scopeOf(c))));

/** POST /api/compose/templates — create, or update when `id` matches one. */
composer.post("/templates", async (c) => {
  const b = await c.req
    .json<{ id?: string; name?: string; subject?: string; html?: string }>()
    .catch(() => null);
  const name = b?.name?.trim().slice(0, 80);
  const html = b?.html ?? "";
  if (!name) return c.json({ error: "Give the template a name" }, 400);
  if (!html.replace(/<[^>]*>|&nbsp;|\s/g, "")) return c.json({ error: "The template is empty" }, 400);
  if (html.length > MAX_TEMPLATE_BYTES) return c.json({ error: "That template is too long" }, 400);

  const list = await loadTemplates(c.env.DB, scopeOf(c));
  const now = Date.now();
  const existing = b?.id ? list.find((t) => t.id === b.id) : list.find((t) => t.name.toLowerCase() === name.toLowerCase());
  let saved: Template;
  if (existing) {
    saved = Object.assign(existing, { name, subject: b?.subject?.trim() ?? "", html, updated_at: now });
  } else {
    if (list.length >= MAX_TEMPLATES) return c.json({ error: `At most ${MAX_TEMPLATES} templates` }, 400);
    saved = { id: crypto.randomUUID(), name, subject: b?.subject?.trim() ?? "", html, updated_at: now };
    list.push(saved);
  }
  list.sort((a, z) => a.name.localeCompare(z.name));
  await setUserSetting(c.env.DB, scopeOf(c), "templates", JSON.stringify(list));
  return c.json(saved);
});

composer.delete("/templates/:id", async (c) => {
  const list = await loadTemplates(c.env.DB, scopeOf(c));
  const next = list.filter((t) => t.id !== c.req.param("id"));
  await setUserSetting(c.env.DB, scopeOf(c), "templates", JSON.stringify(next));
  return c.json({ ok: true });
});
