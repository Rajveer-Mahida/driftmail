import { Hono } from "hono";
import type { HonoEnv } from "../env.ts";
import type { ComposeRequest, UploadedAttachment } from "@email/shared";
import { recordOutbound, getMessage, deleteDraft } from "../db.ts";
import { getComposeEnabled } from "../settings.ts";
import { sendMail, resolveFrom, loadFromR2, SendError } from "../send/index.ts";
import { scopeOf } from "../middleware.ts";

export const compose = new Hono<HonoEnv>();

const refs = (items: UploadedAttachment[]) =>
  items.map((a) => ({ key: a.key, filename: a.filename, mime_type: a.mime_type }));

// POST /api/send — new mail, reply-all, or forward (universal sender).
compose.post("/", async (c) => {
  if (!(await getComposeEnabled(c.env.DB))) {
    return c.json({ error: "Compose disabled in settings" }, 403);
  }

  const body = await c.req.json<ComposeRequest>().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON" }, 400);

  const to = (body.to ?? []).map((s) => s.trim()).filter(Boolean);
  const cc = (body.cc ?? []).map((s) => s.trim()).filter(Boolean);
  const bcc = (body.bcc ?? []).map((s) => s.trim()).filter(Boolean);
  if (!to.length) return c.json({ error: "At least one recipient required" }, 400);
  if (!body.subject?.trim()) return c.json({ error: "Subject required" }, 400);

  const parent = body.inReplyToMessageId
    ? await getMessage(c.env.DB, scopeOf(c), body.inReplyToMessageId)
    : null;

  let from: string;
  try {
    from = await resolveFrom(c.env.DB, { explicit: body.from, parent });
  } catch (err) {
    if (err instanceof SendError) return c.json(err.toJSON(), 400);
    throw err;
  }

  const attachments = body.attachments ?? [];
  const stored = {
    from,
    to: to.join(", "),
    cc: cc.length ? cc.join(", ") : null,
    bcc: bcc.length ? bcc.join(", ") : null,
    subject: body.subject,
    html: body.html ?? null,
    text: body.text ?? "",
    inReplyToMessageId: body.inReplyToMessageId ?? null,
    attachments: attachments.map((a) => ({
      key: a.key,
      filename: a.filename,
      mime_type: a.mime_type,
      size_bytes: a.size_bytes,
    })),
  };

  // Scheduled send → store pending; the cron sends it later (with attachments/cc).
  if (body.sendAfter) {
    const id = await recordOutbound(c.env.DB, scopeOf(c), { ...stored, sendAfter: Number(body.sendAfter) });
    if (body.draftId) await deleteDraft(c.env.DB, scopeOf(c), body.draftId);
    return c.json({ ok: true, id, pending: true });
  }

  try {
    await sendMail(c.env, {
      from,
      to,
      cc: cc.length ? cc : undefined,
      bcc: bcc.length ? bcc : undefined,
      subject: body.subject,
      html: body.html ? String(body.html) : undefined,
      text: body.text || "",
      // Threading, so the reply lands in the recipient's existing conversation
      // rather than starting a new one.
      inReplyTo: parent?.message_id ?? undefined,
      references: parent?.message_id ? [parent.message_id] : undefined,
      attachments: attachments.length
        ? await loadFromR2(c.env.EMAIL_CACHE, refs(attachments))
        : undefined,
    });

    const id = await recordOutbound(c.env.DB, scopeOf(c), stored);
    if (body.draftId) await deleteDraft(c.env.DB, scopeOf(c), body.draftId);
    return c.json({ ok: true, id });
  } catch (err) {
    console.error("send failed", err);
    if (err instanceof SendError) return c.json(err.toJSON(), 502);
    return c.json({ error: (err as Error)?.message ?? "send failed" }, 500);
  }
});
