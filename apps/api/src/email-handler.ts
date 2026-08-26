// Inbound email ingestion.
//
// Cloudflare Email Routing delivers a ForwardableEmailMessage here. The catch-all
// points every address on every configured domain at this Worker, so the first
// job is deciding whose mailbox the message belongs in — see routing.ts.

import PostalMime from "postal-mime";
import { asUserId } from "@email/shared";
import type { Env } from "./env.ts";
import { registerAlias, applyRules } from "./db.ts";
import { loadPolicies, recordUnrouted } from "./config/domains.ts";
import { resolveRecipient, type RejectCode } from "./routing.ts";
import { notifyNewMail } from "./push.ts";

/** What the sending server is told, per reason. Kept short and non-specific:
 *  a bounce should not enumerate which addresses exist. */
const REJECT_MESSAGE: Record<RejectCode, string> = {
  bad_address: "Invalid recipient address",
  unknown_domain: "Address not allowed",
  disabled_alias: "Address not active",
  disabled_owner: "Mailbox unavailable",
  no_owner: "Address not allowed",
};

export async function handleEmail(
  message: ForwardableEmailMessage,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const policies = await loadPolicies(env.DB);
  const route = await resolveRecipient(env.DB, message.to, policies);

  if (route.kind === "reject") {
    // Where undeliverable mail goes is a per-domain choice; falling back to a
    // real inbox beats a bounce for a personal catch-all.
    const fallback = route.policy?.fallbackForwardTo?.trim();
    if (fallback) {
      console.log("Forwarding unroutable mail:", message.to, "->", fallback, route.code);
      await message.forward(fallback);
    } else {
      console.log("Rejected:", message.to, route.code);
      message.setReject(REJECT_MESSAGE[route.code]);
    }
    // Recorded either way. Without this the failure is invisible: Cloudflare
    // accepted the message and nothing shows that it went nowhere.
    if (route.code !== "bad_address") {
      await recordUnrouted(env.DB, {
        address: route.recipient,
        from_addr: message.from,
        reason: route.code,
      }).catch(() => {});
    }
    return;
  }

  const { userId, recipient, baseAddress, policy } = route;
  const owner = asUserId(userId);

  // Auto-track the alias so it shows up in the owner's list. The plus tag is
  // stripped first, or foo+a@, foo+b@ and foo+c@ each become their own alias.
  await registerAlias(env.DB, owner, baseAddress);

  const raw = await new Response(message.raw).arrayBuffer();
  const parsed = await new PostalMime().parse(raw);

  const id = crypto.randomUUID();
  const ts = Date.now();
  // Namespaced by owner so deleting a user is a prefix sweep, and so the
  // attachment route can do a structural check before touching the database.
  const rawKey = `u/${owner}/emails/${ts}-${id}.eml`;

  await env.EMAIL_CACHE.put(rawKey, raw, {
    httpMetadata: { contentType: "message/rfc822" },
  });

  const text = parsed.text ?? "";
  const snippet = text.replace(/\s+/g, " ").trim().slice(0, 200);
  const threadId = parsed.inReplyTo || parsed.messageId || id;
  const fromAddr = parsed.from?.address ?? message.from;
  const fromName = parsed.from?.name ?? null;

  await env.DB.prepare(
    `INSERT INTO messages
       (id, user_id, message_id, in_reply_to, thread_id, direction,
        from_addr, from_name, to_addr, subject, snippet,
        html, text, raw_key, size_bytes, received_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(
      id,
      owner,
      parsed.messageId ?? null,
      parsed.inReplyTo ?? null,
      threadId,
      "in",
      fromAddr,
      fromName,
      // The full address including any +tag, so the reader can see what the
      // sender actually wrote.
      recipient,
      parsed.subject ?? "",
      snippet,
      parsed.html ?? null,
      text,
      rawKey,
      raw.byteLength,
      ts,
    )
    .run();

  // Apply this owner's filters (label / archive / mark-read / trash).
  await applyRules(env.DB, owner, {
    id,
    from_addr: fromAddr,
    to_addr: recipient,
    subject: parsed.subject ?? "",
  });

  // Notify only the owner. Pushing to every subscription would tell every user
  // that someone else had received mail.
  ctx.waitUntil(notifyNewMail(env, owner));

  for (const att of parsed.attachments ?? []) {
    const aid = crypto.randomUUID();
    const safeName = (att.filename ?? "file").replace(/[^A-Za-z0-9._-]+/g, "_");
    const r2Key = `u/${owner}/attachments/${aid}-${safeName}`;

    let bytes: ArrayBuffer;
    if (typeof att.content === "string") {
      bytes = new TextEncoder().encode(att.content).buffer as ArrayBuffer;
    } else if (att.content instanceof ArrayBuffer) {
      bytes = att.content;
    } else {
      const view = att.content as ArrayBufferView;
      bytes = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
    }

    await env.EMAIL_CACHE.put(r2Key, bytes, {
      httpMetadata: { contentType: att.mimeType ?? "application/octet-stream" },
    });

    const cid = att.contentId ? att.contentId.replace(/^<|>$/g, "") : null;

    await env.DB.prepare(
      `INSERT INTO attachments (id, user_id, message_id, filename, mime_type, r2_key, size_bytes, content_id)
       VALUES (?,?,?,?,?,?,?,?)`,
    )
      .bind(
        aid,
        owner,
        id,
        att.filename ?? null,
        att.mimeType ?? null,
        r2Key,
        bytes.byteLength,
        cid,
      )
      .run();
  }

  console.log("Stored:", { id, owner, from: fromAddr, to: recipient, subject: parsed.subject });

  // Per-domain copy-forward, for anyone who wants a mirror in an existing inbox.
  const forwardTo = policy.forwardTo?.trim();
  if (forwardTo) {
    await message.forward(forwardTo);
    console.log("Forwarded to:", forwardTo);
  }
}
