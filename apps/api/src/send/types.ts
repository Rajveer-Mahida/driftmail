// The outbound contract every provider implements.
//
// Before this existed the send call was duplicated at four sites, each building a
// slightly different payload against the Cloudflare binding directly. Anything a
// message needs to carry has to be expressible here.

export type ProviderName = "resend" | "cloudflare" | "none";

export type OutboundAttachment = {
  content: ArrayBuffer;
  filename: string;
  type?: string;
  disposition?: "attachment" | "inline";
  contentId?: string;
};

export type OutboundMessage = {
  from: string | { email: string; name?: string };
  to: string[];
  cc?: string[];
  bcc?: string[];
  replyTo?: string;
  subject: string;
  html?: string;
  text?: string;
  headers?: Record<string, string>;
  attachments?: OutboundAttachment[];

  /** RFC 5322 threading. Every pre-refactor call site dropped these, so replies
   *  sent from Driftmail did not thread in the recipient's client. */
  inReplyTo?: string;
  references?: string[];

  /** Our own message id, passed to the provider as an idempotency key so a cron
   *  retry after a timeout cannot deliver the message twice. */
  idempotencyKey?: string;
};

export type SendResult = { messageId: string; provider: ProviderName };

export type SendErrorCode =
  | "not_configured"
  | "no_sender"
  | "sender_not_verified"
  | "recipient_not_allowed"
  | "too_many_recipients"
  | "too_large"
  | "rate_limited"
  | "already_sending"
  | "provider_error";

export class SendError extends Error {
  readonly code: SendErrorCode;
  /** Whether retrying could plausibly succeed. The cron reverts a message to
   *  'pending' only when this is true; otherwise it lands in 'failed'. Without
   *  the distinction a permanently-rejected message retries every minute forever. */
  readonly retryable: boolean;
  readonly provider: ProviderName;
  readonly status?: number;
  /** Actionable and user-facing, as opposed to the provider's raw message. */
  readonly hint?: string;

  constructor(
    code: SendErrorCode,
    message: string,
    opts: { provider: ProviderName; retryable?: boolean; status?: number; hint?: string },
  ) {
    super(message);
    this.name = "SendError";
    this.code = code;
    this.provider = opts.provider;
    this.retryable = opts.retryable ?? false;
    this.status = opts.status;
    this.hint = opts.hint;
  }

  /** The shape routes return, so the SPA can show the hint alongside the cause. */
  toJSON() {
    return { error: this.message, code: this.code, hint: this.hint, provider: this.provider };
  }
}

export interface Provider {
  readonly name: ProviderName;
  send(msg: OutboundMessage): Promise<SendResult>;
}

/** Cloudflare caps a message at 50 recipients across To/Cc/Bcc. Checking before
 *  dispatch turns a provider error into a message the composer can show. */
export const MAX_RECIPIENTS = 50;

export function countRecipients(msg: OutboundMessage): number {
  return msg.to.length + (msg.cc?.length ?? 0) + (msg.bcc?.length ?? 0);
}

export function formatAddress(from: OutboundMessage["from"]): string {
  if (typeof from === "string") return from;
  return from.name ? `${from.name} <${from.email}>` : from.email;
}

/** Merge explicit headers with the threading ones, without letting a caller's
 *  header be silently overwritten. */
export function buildHeaders(msg: OutboundMessage): Record<string, string> {
  const headers: Record<string, string> = { ...(msg.headers ?? {}) };
  if (msg.inReplyTo && !headers["In-Reply-To"]) headers["In-Reply-To"] = msg.inReplyTo;
  if (msg.references?.length && !headers["References"]) {
    headers["References"] = msg.references.join(" ");
  }
  return headers;
}
