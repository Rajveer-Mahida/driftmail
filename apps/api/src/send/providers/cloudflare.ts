// Cloudflare Email Sending, via the `send_email` binding.
//
// The binding itself is a thin call; almost all the value here is error mapping.
// Cloudflare's raw messages were previously surfaced verbatim to the composer,
// which is why "destination not verified" was the app's most common and least
// actionable failure — it names neither the cause nor the fix.

import type { SendEmailBinding } from "../../env.ts";
import {
  SendError,
  buildHeaders,
  countRecipients,
  formatAddress,
  MAX_RECIPIENTS,
  type OutboundMessage,
  type Provider,
  type SendResult,
} from "../types.ts";

const PROVIDER = "cloudflare" as const;

/** Cloudflare error codes, from the send_email binding's documented set. */
function mapError(err: unknown): SendError {
  const raw = (err as Error)?.message ?? "send failed";
  const code = (err as { code?: string })?.code ?? "";
  // The binding sets `.code`, but older runtimes only put it in the message.
  const has = (c: string) => code === c || raw.includes(c);

  if (has("E_SENDER_NOT_VERIFIED")) {
    return new SendError("sender_not_verified", raw, {
      provider: PROVIDER,
      hint:
        "This domain isn't onboarded for sending yet. Finish it under " +
        "Settings → Domains → Sending, or switch this domain to Resend.",
    });
  }
  if (has("E_RECIPIENT_NOT_ALLOWED")) {
    return new SendError("recipient_not_allowed", raw, {
      provider: PROVIDER,
      hint:
        "Cloudflare only lets you send to verified destination addresses on the " +
        "free plan. Sending to anyone else needs the Workers Paid plan — or use " +
        "Resend instead, which has no such limit.",
    });
  }
  if (has("E_TOO_MANY_RECIPIENTS")) {
    return new SendError("too_many_recipients", raw, {
      provider: PROVIDER,
      hint: `At most ${MAX_RECIPIENTS} recipients across To, Cc and Bcc.`,
    });
  }
  if (has("E_CONTENT_TOO_LARGE")) {
    return new SendError("too_large", raw, {
      provider: PROVIDER,
      hint: "Cloudflare caps a message at 5 MB including attachments.",
    });
  }
  if (has("E_RATE_LIMIT_EXCEEDED") || has("E_DAILY_LIMIT_EXCEEDED")) {
    return new SendError("rate_limited", raw, { provider: PROVIDER, retryable: true });
  }
  // Anything unrecognised is assumed transient: a message that could have gone
  // out is worse to drop than to retry.
  return new SendError("provider_error", raw, { provider: PROVIDER, retryable: true });
}

export function cloudflareProvider(binding: SendEmailBinding | undefined): Provider {
  return {
    name: PROVIDER,
    async send(msg: OutboundMessage): Promise<SendResult> {
      if (!binding) {
        throw new SendError("not_configured", "The EMAIL binding is not available", {
          provider: PROVIDER,
          hint: "This Worker was deployed without a send_email binding.",
        });
      }
      if (countRecipients(msg) > MAX_RECIPIENTS) {
        throw new SendError(
          "too_many_recipients",
          `${countRecipients(msg)} recipients exceeds the limit of ${MAX_RECIPIENTS}`,
          { provider: PROVIDER, hint: `At most ${MAX_RECIPIENTS} across To, Cc and Bcc.` },
        );
      }

      const headers = buildHeaders(msg);
      try {
        const res = await binding.send({
          to: msg.to,
          cc: msg.cc?.length ? msg.cc : undefined,
          bcc: msg.bcc?.length ? msg.bcc : undefined,
          from: formatAddress(msg.from),
          replyTo: msg.replyTo,
          subject: msg.subject,
          html: msg.html,
          text: msg.text ?? "",
          headers: Object.keys(headers).length ? headers : undefined,
          attachments: msg.attachments?.length
            ? msg.attachments.map((a) => ({
                content: a.content,
                filename: a.filename,
                type: a.type ?? "application/octet-stream",
                disposition: a.disposition ?? "attachment",
                contentId: a.contentId,
              }))
            : undefined,
        });
        return { messageId: res.messageId, provider: PROVIDER };
      } catch (err) {
        throw mapError(err);
      }
    },
  };
}
