// Resend. The default provider, because Cloudflare Email Sending is still beta
// and only free to *verified destination addresses* — arbitrary recipients need
// the Workers Paid plan, and arbitrary recipients is exactly what a mail client
// sends to.

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

const PROVIDER = "resend" as const;
const API = "https://api.resend.com";

/**
 * Attachment ceiling, in raw bytes before encoding.
 *
 * Resend's own cap is ~40 MB *after* base64, but base64 in a JS string costs
 * roughly 2.7x the byte length against a Worker's 128 MB budget. Bailing at 20 MB
 * before allocating turns an OOM into an error message.
 */
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

function base64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  // Chunked: String.fromCharCode(...bytes) blows the call stack past ~100 KB.
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

type ResendError = { statusCode?: number; message?: string; name?: string };

function mapError(status: number, body: ResendError | null, raw: string): SendError {
  const message = body?.message ?? raw ?? `Resend returned ${status}`;

  if (status === 401 || status === 403) {
    // A 403 that names the domain is a verification problem, not a key problem.
    if (/domain/i.test(message)) {
      return new SendError("sender_not_verified", message, {
        provider: PROVIDER,
        status,
        hint:
          "Resend hasn't verified this sending domain yet. Check its DNS records " +
          "under Settings → Domains → Sending.",
      });
    }
    return new SendError("provider_error", message, {
      provider: PROVIDER,
      status,
      hint: "Resend rejected the API key. Replace it under Settings → Sending.",
    });
  }
  if (status === 429) {
    return new SendError("rate_limited", message, {
      provider: PROVIDER,
      status,
      retryable: true,
      hint: "Resend is rate-limiting this account; the message will be retried.",
    });
  }
  if (status === 413) {
    return new SendError("too_large", message, { provider: PROVIDER, status });
  }
  if (status === 422 || status === 400) {
    // A validation failure will fail identically forever, so never retry it.
    return new SendError("provider_error", message, { provider: PROVIDER, status });
  }
  return new SendError("provider_error", message, {
    provider: PROVIDER,
    status,
    retryable: status >= 500,
  });
}

export function resendProvider(apiKey: string): Provider {
  return {
    name: PROVIDER,
    async send(msg: OutboundMessage): Promise<SendResult> {
      if (countRecipients(msg) > MAX_RECIPIENTS) {
        throw new SendError(
          "too_many_recipients",
          `${countRecipients(msg)} recipients exceeds the limit of ${MAX_RECIPIENTS}`,
          { provider: PROVIDER, hint: `At most ${MAX_RECIPIENTS} across To, Cc and Bcc.` },
        );
      }

      const totalBytes = (msg.attachments ?? []).reduce((n, a) => n + a.content.byteLength, 0);
      if (totalBytes > MAX_ATTACHMENT_BYTES) {
        throw new SendError(
          "too_large",
          `Attachments total ${Math.round(totalBytes / 1024 / 1024)} MB`,
          {
            provider: PROVIDER,
            hint: `Attachments must total under ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`,
          },
        );
      }

      const headers = buildHeaders(msg);
      const payload: Record<string, unknown> = {
        from: formatAddress(msg.from),
        to: msg.to,
        subject: msg.subject,
      };
      if (msg.cc?.length) payload.cc = msg.cc;
      if (msg.bcc?.length) payload.bcc = msg.bcc;
      // snake_case: `replyTo` is silently ignored by the API.
      if (msg.replyTo) payload.reply_to = msg.replyTo;
      if (msg.html) payload.html = msg.html;
      if (msg.text) payload.text = msg.text;
      if (Object.keys(headers).length) payload.headers = headers;
      if (msg.attachments?.length) {
        payload.attachments = msg.attachments.map((a) => ({
          // Bare base64, not a data: URI — a prefix here is accepted and then
          // delivered as corrupt bytes.
          content: base64(a.content),
          filename: a.filename,
          content_type: a.type ?? "application/octet-stream",
          ...(a.contentId ? { content_id: a.contentId } : {}),
        }));
      }

      const reqHeaders: Record<string, string> = {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      };
      if (msg.idempotencyKey) reqHeaders["Idempotency-Key"] = msg.idempotencyKey.slice(0, 256);

      let res: Response;
      try {
        res = await fetch(`${API}/emails`, {
          method: "POST",
          headers: reqHeaders,
          body: JSON.stringify(payload),
        });
      } catch (err) {
        throw new SendError("provider_error", (err as Error)?.message ?? "Resend unreachable", {
          provider: PROVIDER,
          retryable: true,
        });
      }

      const raw = await res.text();
      let body: (ResendError & { id?: string }) | null = null;
      try {
        body = JSON.parse(raw) as ResendError & { id?: string };
      } catch {
        /* non-JSON body; `raw` carries the detail */
      }

      if (!res.ok) throw mapError(res.status, body, raw);
      if (!body?.id) {
        throw new SendError("provider_error", "Resend accepted the message but returned no id", {
          provider: PROVIDER,
          status: res.status,
        });
      }
      return { messageId: body.id, provider: PROVIDER };
    },
  };
}
