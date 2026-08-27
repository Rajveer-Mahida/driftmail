import { Hono } from "hono";
import PostalMime from "postal-mime";
import type { Context } from "hono";
import type { HonoEnv } from "../env.ts";
import type {
  MessageListItem,
  MessageDetail,
  ViewName,
  FlagField,
} from "@email/shared";
import {
  listMessages,
  getMessage,
  getThread,
  attachmentsForMessages,
  getAttachments,
  labelsForMessages,
  markRead,
  softDelete,
  setFlag,
  setSnooze,
  markAllRead,
  permanentDeleteMessages,
  applyLabels,
  removeLabel,
  cancelPendingMessage,
} from "../db.ts";
import { flushPending } from "../send/outbox.ts";
import { SendError } from "../send/types.ts";
import { mailedBy, signedBy, replyToOf } from "../headers.ts";
import { scopeOf } from "../middleware.ts";

const FLAG_FIELDS: FlagField[] = ["is_starred", "is_archived", "is_deleted", "is_read"];

export const messages = new Hono<HonoEnv>();

// GET /api/messages?view=&q=&label=&limit=&offset=
messages.get("/", async (c) => {
  const db = c.env.DB;
  const uid = scopeOf(c);
  const view = (c.req.query("view") as ViewName) || "inbox";
  const q = c.req.query("q") ?? undefined;
  const labelId = c.req.query("label") ?? undefined;
  const to = c.req.query("to") ?? undefined;
  const limit = Number(c.req.query("limit") ?? "50");
  const offset = Number(c.req.query("offset") ?? "0");

  const rows = await listMessages(db, uid, { view, q, labelId, to, limit, offset });
  const labelMap = await labelsForMessages(db, uid, rows.map((m) => m.id));

  const items: MessageListItem[] = rows.map(({ html: _h, text: _t, ...rest }) => ({
    ...rest,
    labels: labelMap.get(rest.id) ?? [],
  }));
  return c.json(items);
});

// GET /api/messages/:id  → message + thread + attachments + labels
messages.get("/:id", async (c) => {
  const db = c.env.DB;
  const uid = scopeOf(c);
  const id = c.req.param("id");
  const message = await getMessage(db, uid, id);
  if (!message) return c.json({ error: "not found" }, 404);

  const threadKey = message.thread_id ?? message.message_id ?? message.id;
  const thread = await getThread(db, uid, threadKey);
  const messages = thread.length ? thread : [message];

  const [attachments, labelMap] = await Promise.all([
    attachmentsForMessages(db, uid, messages.map((m) => m.id)),
    labelsForMessages(db, uid, [id]),
  ]);

  const detail: MessageDetail = {
    message,
    thread: messages,
    attachments,
    labels: labelMap.get(id) ?? [],
  };
  return c.json(detail);
});

// ── One-click unsubscribe (RFC 2369 / 8058) ────────────────────────────────
// List-Unsubscribe headers aren't stored at ingest; parse them on demand from
// the raw .eml in R2 (cheap, rare operation).
function parseUnsub(value: string): { http: string | null; mailto: string | null } {
  let http: string | null = null;
  let mailto: string | null = null;
  for (const m of value.match(/<([^>]+)>/g) ?? []) {
    const url = m.slice(1, -1).trim();
    if (/^https?:/i.test(url)) http ??= url;
    else if (/^mailto:/i.test(url)) mailto ??= url;
  }
  return { http, mailto };
}

async function unsubInfo(c: Context<HonoEnv>, id: string) {
  const msg = await getMessage(c.env.DB, scopeOf(c), id);
  if (!msg?.raw_key) return null;
  const obj = await c.env.EMAIL_CACHE.get(msg.raw_key);
  if (!obj) return null;
  const parsed = await new PostalMime().parse(await obj.arrayBuffer());
  const headers = parsed.headers ?? [];
  const lu = headers.find((h) => h.key === "list-unsubscribe")?.value;
  if (!lu) return { http: null, mailto: null, oneClick: false };
  const lup = headers.find((h) => h.key === "list-unsubscribe-post")?.value;
  return { ...parseUnsub(lu), oneClick: !!lup && /one-click/i.test(lup) };
}

// GET → the "details" panel metadata (mailed-by / signed-by / reply-to).
// Everything else the panel shows (from, to, cc, date) is already on the row,
// so this is fetched lazily, only when the panel is actually opened — it costs
// an R2 read plus a full MIME parse.
messages.get("/:id/details", async (c) => {
  const empty = { mailedBy: null, signedBy: null, replyTo: null };
  const msg = await getMessage(c.env.DB, scopeOf(c), c.req.param("id"));
  if (!msg?.raw_key) return c.json(empty);
  const obj = await c.env.EMAIL_CACHE.get(msg.raw_key);
  if (!obj) return c.json(empty);
  try {
    const parsed = await new PostalMime().parse(await obj.arrayBuffer());
    const headers = parsed.headers ?? [];
    return c.json({
      mailedBy: mailedBy(headers),
      signedBy: signedBy(headers),
      replyTo: replyToOf(headers),
    });
  } catch {
    return c.json(empty);
  }
});

// GET → what unsubscribe options this message offers
messages.get("/:id/unsubscribe", async (c) => {
  const info = await unsubInfo(c, c.req.param("id"));
  return c.json(info ?? { http: null, mailto: null, oneClick: false });
});

// POST → perform the RFC 8058 one-click POST server-side (avoids browser CORS)
messages.post("/:id/unsubscribe", async (c) => {
  const info = await unsubInfo(c, c.req.param("id"));
  if (!info?.http) return c.json({ error: "no http unsubscribe target" }, 400);
  try {
    const res = await fetch(info.http, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "List-Unsubscribe=One-Click",
    });
    return c.json({ ok: res.ok, status: res.status });
  } catch {
    return c.json({ error: "request failed" }, 502);
  }
});

messages.post("/mark-read", async (c) => {
  const { id, read } = await c.req
    .json<{ id?: string; read?: boolean }>()
    .catch(() => ({}) as { id?: string; read?: boolean });
  if (!id) return c.json({ error: "id required" }, 400);
  await markRead(c.env.DB, scopeOf(c), id, read !== false);
  return c.json({ ok: true });
});

messages.post("/delete", async (c) => {
  const { id } = await c.req.json<{ id?: string }>().catch(() => ({}) as { id?: string });
  if (!id) return c.json({ error: "id required" }, 400);
  await softDelete(c.env.DB, scopeOf(c), id);
  return c.json({ ok: true });
});

messages.post("/flag", async (c) => {
  const { ids, field, value, byThread } = await c.req
    .json<{ ids?: string[]; field?: string; value?: 0 | 1; byThread?: boolean }>()
    .catch(() => ({}) as Record<string, never>);
  if (!ids?.length || !field || !FLAG_FIELDS.includes(field as FlagField) || value === undefined) {
    return c.json({ error: "invalid params" }, 400);
  }
  await setFlag(c.env.DB, scopeOf(c), ids, field as FlagField, value, { byThread });
  return c.json({ ok: true });
});

messages.post("/snooze", async (c) => {
  const { ids, until, byThread } = await c.req
    .json<{ ids?: string[]; until?: number | null; byThread?: boolean }>()
    .catch(() => ({}) as Record<string, never>);
  if (!ids?.length || until === undefined) {
    return c.json({ error: "ids and until required" }, 400);
  }
  await setSnooze(c.env.DB, scopeOf(c), ids, until, { byThread });
  return c.json({ ok: true });
});

messages.post("/mark-all-read", async (c) => {
  const { view, labelId } = await c.req
    .json<{ view?: string; labelId?: string }>()
    .catch(() => ({}) as Record<string, never>);
  await markAllRead(c.env.DB, scopeOf(c), { view: (view as ViewName) || "inbox", labelId });
  return c.json({ ok: true });
});

messages.post("/permanent-delete", async (c) => {
  const { ids } = await c.req.json<{ ids?: string[] }>().catch(() => ({}) as { ids?: string[] });
  if (!ids?.length) return c.json({ error: "ids required" }, 400);
  await permanentDeleteMessages(c.env.DB, scopeOf(c), ids);
  return c.json({ ok: true });
});

messages.post("/labels", async (c) => {
  const { messageIds, labelIds } = await c.req
    .json<{ messageIds?: string[]; labelIds?: string[] }>()
    .catch(() => ({}) as Record<string, never>);
  if (!messageIds?.length || !labelIds?.length) {
    return c.json({ error: "messageIds and labelIds required" }, 400);
  }
  await applyLabels(c.env.DB, scopeOf(c), messageIds, labelIds);
  return c.json({ ok: true });
});

messages.delete("/labels", async (c) => {
  const { messageId, labelId } = await c.req
    .json<{ messageId?: string; labelId?: string }>()
    .catch(() => ({}) as Record<string, never>);
  if (!messageId || !labelId) return c.json({ error: "messageId and labelId required" }, 400);
  await removeLabel(c.env.DB, scopeOf(c), messageId, labelId);
  return c.json({ ok: true });
});

messages.post("/cancel-send", async (c) => {
  const { id } = await c.req.json<{ id?: string }>().catch(() => ({}) as { id?: string });
  if (!id) return c.json({ error: "id required" }, 400);
  const cancelled = await cancelPendingMessage(c.env.DB, id);
  return c.json({ ok: true, cancelled });
});

messages.post("/send-now", async (c) => {
  const { id } = await c.req.json<{ id?: string }>().catch(() => ({}) as { id?: string });
  if (!id) return c.json({ error: "id required" }, 400);

  // No gate here: the pending row was already authorized at creation
  // (reply -> reply_enabled, compose -> compose_enabled). This is just the flush.
  try {
    await flushPending(c.env, id);
    return c.json({ ok: true });
  } catch (err) {
    // A cron tick may have claimed it a moment ago; that is a race, not a
    // failure, and the message still goes out.
    if (err instanceof SendError && err.code === "already_sending") {
      return c.json({ ok: true, skipped: true });
    }
    console.error("send-now failed", err);
    if (err instanceof SendError) return c.json(err.toJSON(), 502);
    return c.json({ error: (err as Error)?.message ?? "send failed" }, 500);
  }
});
