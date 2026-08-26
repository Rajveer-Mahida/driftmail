// Flushing a stored pending message — the undo-send window elapsing, the cron
// firing, or the user pressing "send now".
//
// All three did the same six things in their own way: claim the row, pull the
// attachments, rebuild the payload, send, mark sent, revert on error.

import type { Env } from "../env.ts";
import { claimPendingMessage, markMessageSent, markMessageUnsent } from "../db.ts";
import { sendMail } from "./index.ts";
import { loadFromR2, splitAddrs } from "./attachments.ts";
import { SendError, type SendResult } from "./types.ts";

type PendingRow = {
  id: string;
  to_addr: string;
  cc: string | null;
  bcc: string | null;
  from_addr: string | null;
  subject: string | null;
  html: string | null;
  text: string | null;
  message_id: string | null;
  in_reply_to: string | null;
};

const SELECT_COLS = `id, to_addr, cc, bcc, from_addr, subject, html, text, message_id, in_reply_to`;

async function attachmentsFor(env: Env, messageId: string) {
  const { results } = await env.DB.prepare(
    `SELECT filename, mime_type, r2_key, content_id FROM attachments WHERE message_id = ?`,
  )
    .bind(messageId)
    .all<{
      filename: string | null;
      mime_type: string | null;
      r2_key: string;
      content_id: string | null;
    }>();
  return loadFromR2(
    env.EMAIL_CACHE,
    (results ?? []).map((a) => ({
      key: a.r2_key,
      filename: a.filename,
      mime_type: a.mime_type,
      content_id: a.content_id,
    })),
  );
}

/**
 * Send one already-stored pending message.
 *
 * Throws SendError on failure, having already moved the row to its resting state:
 * back to `pending` when a retry could work, `failed` with `send_error` when it
 * never will.
 */
export async function flushPending(env: Env, id: string): Promise<SendResult> {
  const row = await env.DB.prepare(`SELECT ${SELECT_COLS} FROM messages WHERE id = ?`)
    .bind(id)
    .first<PendingRow>();
  if (!row) throw new Error(`No message ${id}`);

  // Exclusive ownership, so a cron tick and a "send now" click cannot both send.
  if (!(await claimPendingMessage(env.DB, id))) {
    throw new SendError("already_sending", "That message is already being sent", {
      provider: "none",
    });
  }

  try {
    const cc = splitAddrs(row.cc);
    const bcc = splitAddrs(row.bcc);
    const attachments = await attachmentsFor(env, id);

    const result = await sendMail(env, {
      from: row.from_addr ?? "",
      to: splitAddrs(row.to_addr),
      cc: cc.length ? cc : undefined,
      bcc: bcc.length ? bcc : undefined,
      subject: row.subject ?? "(no subject)",
      html: row.html ?? undefined,
      text: row.text ?? "",
      inReplyTo: row.in_reply_to ?? undefined,
      // Our own row id: a retry after a timeout reuses it, so the provider can
      // recognise the duplicate rather than delivering twice.
      idempotencyKey: id,
      attachments: attachments.length ? attachments : undefined,
    });

    await markMessageSent(env.DB, id);
    return result;
  } catch (err) {
    const retryable = err instanceof SendError ? err.retryable : true;
    const detail = (err as Error)?.message ?? "send failed";

    await markMessageUnsent(env.DB, id, { retryable, detail });

    console.error("flushPending failed", id, retryable ? "(will retry)" : "(final)", detail);
    throw err;
  }
}

/** Every pending message whose send_after has elapsed. */
export async function duePending(env: Env, now = Date.now(), limit = 200): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT id FROM messages
       WHERE send_state = 'pending' AND send_after <= ? AND is_deleted = 0
       ORDER BY send_after ASC LIMIT ?`,
  )
    .bind(now, limit)
    .all<{ id: string }>();
  return (results ?? []).map((r) => r.id);
}
