import { Hono } from "hono";
import type { HonoEnv } from "../env.ts";
import { insertOutbound, getMessage } from "../db.ts";
import { getReplyEnabled } from "../settings.ts";
import { sendMail, resolveFrom, SendError } from "../send/index.ts";
import { scopeOf } from "../middleware.ts";

export const reply = new Hono<HonoEnv>();

reply.post("/", async (c) => {
  if (!(await getReplyEnabled(c.env.DB))) {
    return c.json({ error: "Replies disabled in settings" }, 403);
  }

  const body = await c.req
    .json<{
      messageId?: string;
      to?: string;
      subject?: string;
      html?: string | null;
      text?: string;
      sendAfter?: number;
    }>()
    .catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON" }, 400);

  const { messageId, to, subject, html, text, sendAfter } = body;
  if (!messageId || !to || !subject) {
    return c.json({ error: "Missing fields" }, 400);
  }

  // Reply FROM the alias this thread belongs to — i.e. the alias that received
  // the original mail (inbound `to_addr`) — not a generic instance-wide address.
  const parent = await getMessage(c.env.DB, scopeOf(c), String(messageId));

  let from: string;
  try {
    from = await resolveFrom(c.env.DB, { parent });
  } catch (err) {
    if (err instanceof SendError) return c.json(err.toJSON(), 400);
    throw err;
  }

  const stored = {
    inReplyToMessageId: String(messageId),
    from,
    to: String(to),
    subject: String(subject),
    html: html ?? null,
    text: String(text ?? ""),
  };

  // Undo-send flow: persist as pending; the cron flushes it when the window ends.
  if (sendAfter) {
    try {
      const id = await insertOutbound(c.env.DB, scopeOf(c), { ...stored, sendAfter: Number(sendAfter) });
      return c.json({ ok: true, id, pending: true });
    } catch (err) {
      return c.json({ error: (err as Error)?.message ?? "failed" }, 500);
    }
  }

  try {
    const resp = await sendMail(c.env, {
      from,
      to: [String(to)],
      subject: String(subject),
      html: html ? String(html) : undefined,
      text: text ? String(text) : undefined,
      inReplyTo: parent?.message_id ?? undefined,
      references: parent?.message_id ? [parent.message_id] : undefined,
    });

    const id = await insertOutbound(c.env.DB, scopeOf(c), stored);
    return c.json({ ok: true, id, messageId: resp.messageId });
  } catch (err) {
    console.error("reply send failed", err);
    if (err instanceof SendError) return c.json(err.toJSON(), 502);
    return c.json({ error: (err as Error)?.message ?? "send failed" }, 500);
  }
});
