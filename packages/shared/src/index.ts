// Single source of truth for the JSON contract between the Hono API worker and the SPA.
// Mirrors the D1 schema in the existing project (migrations 0001–0003).

export type Direction = "in" | "out";

// ── users ────────────────────────────────────────────────────────────────────

export type UserRole = "admin" | "user";

/**
 * A user id, branded so it cannot be confused with any other string.
 *
 * Every scoped database function takes this type. Row fields such as
 * `MessageRow.user_id` stay a plain `string`, which makes
 * `getThread(db, row.user_id, ...)` a compile error on purpose: identity must
 * come from the session or the address resolver, never from a row that was
 * itself fetched without a scope.
 */
export type UserId = string & { readonly __userId: unique symbol };

/** The three places a UserId legitimately originates. Anywhere else, don't. */
export const asUserId = (id: string): UserId => id as UserId;

/** Everything about a user that is safe to show to anyone signed in. Password
 *  material is deliberately absent from the type, not merely omitted in code. */
export type PublicUser = {
  id: string;
  email: string;
  /** Routing handle. Mail to <handle>@, <handle>.tag@, tag-<handle>@ and so on
   *  reaches this mailbox — see the resolver in apps/api/src/routing.ts. */
  handle: string;
  name: string | null;
  role: UserRole;
  disabled: number;
  created_at: number;
  last_login_at: number | null;
};

export type SessionUser = PublicUser & { must_change_pw: boolean };

export type MeResponse = { user: SessionUser };
export type LoginRequest = { email: string; password: string };

export type AdminUserRow = PublicUser & {
  alias_count: number;
  message_count: number;
  catchall_domains: string[];
};

export type CreateUserRequest = {
  email: string;
  handle: string;
  name?: string;
  role?: UserRole;
};

/** The temp password is shown exactly once, at creation. An emailed invite link
 *  is the one flow guaranteed to be broken on day one, because outbound sending
 *  may not be verified yet when the second user is created. */
export type CreateUserResponse = { user: PublicUser; temp_password: string };

export type SendState =
  | "pending"
  | "sending"
  | "sent"
  | "cancelled"
  /** The provider rejected it in a way retrying cannot fix; see `send_error`. */
  | "failed"
  | null;

export type MessageRow = {
  id: string;
  message_id: string | null;
  in_reply_to: string | null;
  thread_id: string | null;
  direction: Direction;
  from_addr: string;
  from_name: string | null;
  to_addr: string;
  cc: string | null;
  bcc: string | null;
  subject: string | null;
  snippet: string | null;
  html: string | null;
  text: string | null;
  raw_key: string;
  size_bytes: number | null;
  received_at: number;
  is_read: number;
  is_deleted: number;
  is_starred: number;
  is_archived: number;
  snooze_until: number | null;
  send_after: number | null;
  send_state: SendState;
  send_error: string | null;
};

export type AttachmentRow = {
  id: string;
  message_id: string;
  filename: string | null;
  mime_type: string | null;
  r2_key: string;
  size_bytes: number | null;
  content_id: string | null;
};

export type LabelRow = {
  id: string;
  name: string;
  color: string;
  created_at: number;
};

export type ViewName = "inbox" | "starred" | "snoozed" | "archived" | "trash" | "sent";

export const VIEWS: ViewName[] = ["inbox", "starred", "snoozed", "archived", "trash", "sent"];

export type ViewCounts = {
  inbox: number;
  unread: number;
  starred: number;
  snoozed: number;
  archived: number;
  trash: number;
  sent: number;
};

export type LabelCount = LabelRow & { count: number };

export type CountsResponse = {
  views: ViewCounts;
  labels: LabelCount[];
  drafts: number;
};

/** A list row: one row per thread — the latest message matching the current
 *  view, minus heavy body fields, plus its labels and thread tallies. */
export type MessageListItem = Omit<MessageRow, "html" | "text"> & {
  labels: LabelRow[];
  /** Messages in this thread matching the current view/filter. */
  thread_count: number;
  /** Unread among them. */
  thread_unread: number;
};

/** Full message detail: the message, its thread, per-message attachments, and labels. */
export type MessageDetail = {
  message: MessageRow;
  thread: MessageRow[];
  /** Attachments keyed by message id — covers every message in the thread. */
  attachments: Record<string, AttachmentRow[]>;
  labels: LabelRow[];
};

/** Extra header-derived metadata for the Gmail-style "details" panel. Parsed
 *  from the raw .eml on demand, so it isn't part of MessageRow. */
export type MessageHeaderDetails = {
  /** Domain that passed SPF — Gmail's "mailed-by". */
  mailedBy: string | null;
  /** Domain in the DKIM signature — Gmail's "signed-by". */
  signedBy: string | null;
  replyTo: string | null;
};

export type SettingsResponse = {
  /** Instance-wide kill switches; only an admin can change these. */
  reply_enabled: boolean;
  compose_enabled: boolean;
  /** Per-user preferences. */
  primary_domain: string;
  signature: string;
  block_remote_images: boolean;
  image_allowlist: string[];
  /** Mail domains this instance handles. */
  domains: string[];
  /** Whether a Cloudflare token is stored — the SPA hides the Domains section
   *  when it isn't, since every /api/domains route returns 503. */
  domain_management: boolean;
  user: SessionUser;
};

/** A mail domain this instance handles, as stored. */
export type DomainRow = {
  domain: string;
  zone_id: string | null;
  is_primary: number;
  routing_state: "none" | "enabling" | "pending_dns" | "ready" | "error";
  routing_error: string | null;
  accept_all: number;
  /** Comma-separated address globs; only enforced when accept_all is 0. */
  allowed_pattern: string | null;
  alias_suffix: string | null;
  /** Copy every delivered message here. */
  forward_to: string | null;
  /** Where rejected mail goes instead of bouncing. */
  fallback_forward_to: string | null;
  catchall_user_id: string | null;
  send_provider: "resend" | "cloudflare" | "none" | null;
  send_state: "none" | "pending_dns" | "verifying" | "verified" | "failed";
  send_error: string | null;
};

export type DomainsResponse = { worker: string; domains: DomainRow[] };

export type DomainDnsRecord = {
  type: string;
  name: string;
  content: string;
  priority?: number;
};

export type FlagField = "is_starred" | "is_archived" | "is_deleted" | "is_read";

// ── Compose / drafts ─────────────────────────────────────────────────────────

/** A file already uploaded to R2, ready to attach to an outgoing message. */
export type UploadedAttachment = {
  key: string; // R2 key under uploads/
  filename: string;
  mime_type: string;
  size_bytes: number;
};

export type ComposeRequest = {
  from?: string; // alias to send from; defaults to primary alias
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
  html?: string | null;
  attachments?: UploadedAttachment[];
  sendAfter?: number; // schedule-send timestamp (ms)
  inReplyToMessageId?: string; // set for reply / forward threading
  draftId?: string; // delete this draft once sent
};

export type DraftRow = {
  id: string;
  to_addr: string; // comma-joined
  cc: string | null;
  bcc: string | null;
  subject: string | null;
  text: string | null;
  html: string | null;
  in_reply_to_id: string | null;
  attachments: string | null; // JSON UploadedAttachment[]
  updated_at: number;
};

export type SignatureResponse = { signature: string };

// ── Aliases ──────────────────────────────────────────────────────────────────

export type AliasRow = {
  address: string;
  name: string | null;
  note: string | null;
  disabled: number;
  created_at: number;
};

export type AliasWithCount = AliasRow & {
  mail_count: number;
  unread_count: number;
};

// ── Filters / rules ──────────────────────────────────────────────────────────

export type RuleField = "from" | "to" | "subject";
export type RuleOp = "contains" | "equals" | "startswith" | "endswith";
export type RuleAction = "label" | "archive" | "read" | "trash";

export type RuleRow = {
  id: string;
  field: RuleField;
  op: RuleOp;
  value: string;
  action: RuleAction;
  action_value: string | null; // label_id when action === "label"
  enabled: number;
  created_at: number;
};
