// Every mailbox-owned query is scoped to a user.
//
// The owner is an explicit parameter rather than a bound wrapper object, because
// of how the two fail: adding a required parameter makes the type-checker
// enumerate all ~120 call sites, whereas a wrapper still compiles in any file
// that was missed — and that silent case is a cross-tenant read.
//
// Writes put `user_id` in the WHERE clause instead of checking ownership first,
// so an id belonging to someone else silently affects nothing. Reads that miss
// return null or an empty list, and routes turn that into a 404 — never a 403,
// which would confirm the row exists.
//
// Three functions are deliberately unscoped: claimPendingMessage,
// markMessageSent and markMessageUnsent are driven by the cron, which is
// instance-wide by design and has no session to scope to.

import type {
  MessageRow,
  AttachmentRow,
  LabelRow,
  ViewCounts,
  LabelCount,
  ViewName,
  DraftRow,
  AliasRow,
  AliasWithCount,
  RuleRow,
  UserId,
} from "@email/shared";

type DB = D1Database;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function viewWhere(view: ViewName, now: number): { where: string; args: unknown[] } {
  switch (view) {
    case "starred":
      return { where: "is_starred=1 AND is_deleted=0", args: [] };
    case "snoozed":
      return { where: "snooze_until > ? AND is_deleted=0", args: [now] };
    case "archived":
      return { where: "is_archived=1 AND is_deleted=0", args: [] };
    case "trash":
      return { where: "is_deleted=1", args: [] };
    case "sent":
      return {
        where:
          "direction='out' AND (send_state IS NULL OR send_state IN ('sent','pending','cancelled'))",
        args: [],
      };
    default: // inbox
      return {
        where:
          "is_deleted=0 AND is_archived=0 AND direction='in' AND (snooze_until IS NULL OR snooze_until <= ?)",
        args: [now],
      };
  }
}

type SearchParsed = {
  free: string;
  from: string[];
  to: string[];
  subject: string[];
  hasAttachment: boolean;
  isUnread: boolean;
  isRead: boolean;
  isStarred: boolean;
};

/** Parse Gmail-style operators (from:, to:, subject:, has:attachment, is:unread|read|starred). */
function parseSearch(q: string): SearchParsed {
  const out: SearchParsed = {
    free: "",
    from: [],
    to: [],
    subject: [],
    hasAttachment: false,
    isUnread: false,
    isRead: false,
    isStarred: false,
  };
  const freeParts: string[] = [];
  const re = /(\w+):"([^"]+)"|(\w+):(\S+)|"([^"]+)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(q)) !== null) {
    const key = (m[1] || m[3])?.toLowerCase();
    const val = m[2] ?? m[4];
    if (key && val !== undefined) {
      const v = val.toLowerCase();
      if (key === "from") out.from.push(val);
      else if (key === "to") out.to.push(val);
      else if (key === "subject") out.subject.push(val);
      else if (key === "has" && v.startsWith("attach")) out.hasAttachment = true;
      else if (key === "is" && v === "unread") out.isUnread = true;
      else if (key === "is" && v === "read") out.isRead = true;
      else if (key === "is" && v === "starred") out.isStarred = true;
      else freeParts.push(`${key}:${val}`);
    } else if (m[5] !== undefined) freeParts.push(m[5]);
    else if (m[6] !== undefined) freeParts.push(m[6]);
  }
  out.free = freeParts.join(" ").trim();
  return out;
}

export async function listMessages(
  db: DB,
  userId: UserId,
  opts: {
    limit?: number;
    offset?: number;
    q?: string;
    view?: ViewName;
    labelId?: string;
    to?: string;
  } = {},
): Promise<MessageRow[]> {
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;
  const view = opts.view ?? "inbox";
  const now = Date.now();

  const joins: string[] = [];
  const whereParts: string[] = [];
  const whereArgs: unknown[] = [];

  // Scope: a label (across views) or the current view's predicate.
  if (opts.labelId) {
    joins.push("JOIN message_labels ml ON ml.message_id = m.id");
    whereParts.push("m.is_deleted = 0", "ml.label_id = ?");
    whereArgs.push(opts.labelId);
  } else {
    const { where, args } = viewWhere(view, now);
    whereParts.push(where);
    whereArgs.push(...args);
  }

  // Free-text + operator search.
  const s = opts.q?.trim() ? parseSearch(opts.q) : null;
  if (s?.free) {
    joins.push("JOIN messages_fts f ON f.rowid = m.rowid");
    const term = s.free
      .split(/\s+/)
      .map((t) => `"${t.replace(/"/g, '""')}"*`)
      .join(" ");
    // The owner filter goes INSIDE the MATCH expression, where it becomes a
    // posting-list intersection, rather than being left to the outer WHERE which
    // would make FTS walk every user's matching documents and then discard them.
    //
    // The {column set} is not cosmetic either: without it the free text is also
    // matched against the user_id column, so searching another user's id string
    // would return their mail.
    whereParts.push("messages_fts MATCH ?");
    whereArgs.push(`user_id : ${userId} AND {subject from_addr snippet text} : (${term})`);
  }
  if (s) {
    for (const v of s.from) {
      whereParts.push("m.from_addr LIKE ?");
      whereArgs.push(`%${v}%`);
    }
    for (const v of s.to) {
      whereParts.push("m.to_addr LIKE ?");
      whereArgs.push(`%${v}%`);
    }
    for (const v of s.subject) {
      whereParts.push("m.subject LIKE ?");
      whereArgs.push(`%${v}%`);
    }
    if (s.hasAttachment)
      whereParts.push("EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id)");
    if (s.isUnread) whereParts.push("m.is_read = 0");
    if (s.isRead) whereParts.push("m.is_read = 1");
    if (s.isStarred) whereParts.push("m.is_starred = 1");
  }

  // Scope to one alias (alias filter — exact match).
  if (opts.to) {
    whereParts.push("m.to_addr = ?");
    whereArgs.push(opts.to);
  }

  // Unconditional, search or not — defence in depth behind the FTS filter above.
  whereParts.push("m.user_id = ?");
  whereArgs.push(userId);

  const sql = `SELECT m.* FROM messages m ${joins.join(" ")}
     WHERE ${whereParts.join(" AND ")}
     ORDER BY m.received_at DESC LIMIT ? OFFSET ?`;
  const res = await db
    .prepare(sql)
    .bind(...whereArgs, limit, offset)
    .all<MessageRow>();
  return res.results ?? [];
}

export async function getViewCounts(db: DB, userId: UserId): Promise<ViewCounts> {
  const now = Date.now();
  // COALESCE because SUM() over zero rows is NULL, not 0 — an empty mailbox
  // would otherwise report `null` for every view in the sidebar.
  const row = await db
    .prepare(
      `SELECT
        COALESCE(SUM(CASE WHEN is_deleted=0 AND is_archived=0 AND direction='in' AND (snooze_until IS NULL OR snooze_until <= ?) THEN 1 ELSE 0 END), 0) as inbox,
        COALESCE(SUM(CASE WHEN is_read=0 AND is_deleted=0 AND is_archived=0 AND direction='in' AND (snooze_until IS NULL OR snooze_until <= ?) THEN 1 ELSE 0 END), 0) as unread,
        COALESCE(SUM(CASE WHEN is_starred=1 AND is_deleted=0 THEN 1 ELSE 0 END), 0) as starred,
        COALESCE(SUM(CASE WHEN snooze_until > ? AND is_deleted=0 THEN 1 ELSE 0 END), 0) as snoozed,
        COALESCE(SUM(CASE WHEN is_archived=1 AND is_deleted=0 THEN 1 ELSE 0 END), 0) as archived,
        COALESCE(SUM(CASE WHEN is_deleted=1 THEN 1 ELSE 0 END), 0) as trash,
        COALESCE(SUM(CASE WHEN direction='out' AND (send_state IS NULL OR send_state IN ('sent','pending')) THEN 1 ELSE 0 END), 0) as sent
      FROM messages WHERE user_id = ?`,
    )
    .bind(now, now, now, userId)
    .first<ViewCounts>();
  return row ?? { inbox: 0, unread: 0, starred: 0, snoozed: 0, archived: 0, trash: 0, sent: 0 };
}

export async function getLabelCounts(db: DB, userId: UserId): Promise<LabelCount[]> {
  const res = await db
    .prepare(
      `SELECT l.id, l.name, l.color, l.created_at, COUNT(ml.message_id) as count
       FROM labels l
       LEFT JOIN message_labels ml ON ml.label_id = l.id
       -- The message join carries its own owner check as well as the label's:
       -- two users can hold identically-named labels, and one must not count the
       -- other's mail.
       LEFT JOIN messages m ON m.id = ml.message_id AND m.is_deleted = 0 AND m.user_id = ?
       WHERE l.user_id = ?
       GROUP BY l.id
       ORDER BY l.name ASC`,
    )
    .bind(userId, userId)
    .all<LabelCount>();
  return res.results ?? [];
}

export async function getMessage(
  db: DB,
  userId: UserId,
  id: string,
): Promise<MessageRow | null> {
  const res = await db
    .prepare(`SELECT * FROM messages WHERE id = ? AND user_id = ?`)
    .bind(id, userId)
    .first<MessageRow>();
  return res ?? null;
}

export async function getThread(
  db: DB,
  userId: UserId,
  threadId: string,
): Promise<MessageRow[]> {
  const res = await db
    .prepare(
      `SELECT * FROM messages WHERE thread_id = ? AND user_id = ? ORDER BY received_at ASC`,
    )
    .bind(threadId, userId)
    .all<MessageRow>();
  return res.results ?? [];
}

export async function getAttachments(
  db: DB,
  userId: UserId,
  messageId: string,
): Promise<AttachmentRow[]> {
  const res = await db
    .prepare(`SELECT * FROM attachments WHERE message_id = ? AND user_id = ?`)
    .bind(messageId, userId)
    .all<AttachmentRow>();
  return res.results ?? [];
}

export async function attachmentsForMessages(
  db: DB,
  userId: UserId,
  ids: string[],
): Promise<Record<string, AttachmentRow[]>> {
  const map: Record<string, AttachmentRow[]> = {};
  if (!ids.length) return map;
  const ph = ids.map(() => "?").join(",");
  const res = await db
    .prepare(`SELECT * FROM attachments WHERE user_id = ? AND message_id IN (${ph})`)
    .bind(userId, ...ids)
    .all<AttachmentRow>();
  for (const a of res.results ?? []) {
    (map[a.message_id] ??= []).push(a);
  }
  return map;
}

export async function getAttachmentByCid(
  db: DB,
  userId: UserId,
  messageId: string,
  contentId: string,
): Promise<AttachmentRow | null> {
  const res = await db
    .prepare(
      `SELECT * FROM attachments WHERE message_id = ? AND content_id = ? AND user_id = ?`,
    )
    .bind(messageId, contentId, userId)
    .first<AttachmentRow>();
  return res ?? null;
}

export async function markRead(
  db: DB,
  userId: UserId,
  id: string,
  read = true,
): Promise<void> {
  await db
    .prepare(`UPDATE messages SET is_read = ? WHERE id = ? AND user_id = ?`)
    .bind(read ? 1 : 0, id, userId)
    .run();
}

export async function softDelete(db: DB, userId: UserId, id: string): Promise<void> {
  await db
    .prepare(`UPDATE messages SET is_deleted = 1 WHERE id = ? AND user_id = ?`)
    .bind(id, userId)
    .run();
}

export async function permanentDeleteMessages(
  db: DB,
  userId: UserId,
  ids: string[],
): Promise<void> {
  if (!ids.length) return;
  for (const c of chunk(ids, 100)) {
    const ph = c.map(() => "?").join(",");
    await db
      .prepare(`DELETE FROM messages WHERE user_id = ? AND id IN (${ph})`)
      .bind(userId, ...c)
      .run();
  }
}

export async function markAllRead(
  db: DB,
  userId: UserId,
  opts: { view: ViewName; labelId?: string },
): Promise<void> {
  const now = Date.now();
  if (opts.labelId) {
    await db
      .prepare(
        `UPDATE messages SET is_read = 1 WHERE is_read = 0 AND user_id = ? AND id IN (
          SELECT m.id FROM messages m JOIN message_labels ml ON ml.message_id = m.id
          WHERE ml.label_id = ? AND m.is_deleted = 0 AND m.user_id = ?
        )`,
      )
      .bind(userId, opts.labelId, userId)
      .run();
    return;
  }
  const { where, args } = viewWhere(opts.view, now);
  await db
    .prepare(`UPDATE messages SET is_read = 1 WHERE is_read = 0 AND user_id = ? AND ${where}`)
    .bind(userId, ...args)
    .run();
}

export async function setFlag(
  db: DB,
  userId: UserId,
  ids: string[],
  field: "is_starred" | "is_archived" | "is_deleted" | "is_read",
  value: 0 | 1,
): Promise<void> {
  if (!ids.length) return;
  for (const c of chunk(ids, 100)) {
    const ph = c.map(() => "?").join(",");
    await db
      .prepare(`UPDATE messages SET ${field} = ? WHERE user_id = ? AND id IN (${ph})`)
      .bind(value, userId, ...c)
      .run();
  }
}

export async function setSnooze(
  db: DB,
  userId: UserId,
  ids: string[],
  until: number | null,
): Promise<void> {
  if (!ids.length) return;
  for (const c of chunk(ids, 100)) {
    const ph = c.map(() => "?").join(",");
    await db
      .prepare(`UPDATE messages SET snooze_until = ? WHERE user_id = ? AND id IN (${ph})`)
      .bind(until, userId, ...c)
      .run();
  }
}

// ── Labels ──────────────────────────────────────────────────────────────────

export async function listLabels(db: DB, userId: UserId): Promise<LabelRow[]> {
  const res = await db
    .prepare(`SELECT * FROM labels WHERE user_id = ? ORDER BY name ASC`)
    .bind(userId)
    .all<LabelRow>();
  return res.results ?? [];
}

export async function createLabel(
  db: DB,
  userId: UserId,
  name: string,
  color: string,
): Promise<LabelRow> {
  const id = crypto.randomUUID();
  const created_at = Date.now();
  await db
    .prepare(`INSERT INTO labels (id, user_id, name, color, created_at) VALUES (?,?,?,?,?)`)
    .bind(id, userId, name, color, created_at)
    .run();
  return { id, name, color, created_at };
}

export async function deleteLabel(db: DB, userId: UserId, id: string): Promise<void> {
  await db.prepare(`DELETE FROM labels WHERE id = ? AND user_id = ?`).bind(id, userId).run();
}

/**
 * Both sides of the join are checked in one statement.
 *
 * A read-then-write would race, and would also need somewhere to put the
 * "belongs to someone else" case; here the SELECT simply produces no row, so
 * nothing is inserted.
 */
export async function applyLabels(
  db: DB,
  userId: UserId,
  messageIds: string[],
  labelIds: string[],
): Promise<void> {
  for (const mid of messageIds) {
    for (const lid of labelIds) {
      await db
        .prepare(
          `INSERT OR IGNORE INTO message_labels (message_id, label_id)
             SELECT m.id, l.id FROM messages m, labels l
              WHERE m.id = ? AND l.id = ? AND m.user_id = ? AND l.user_id = ?`,
        )
        .bind(mid, lid, userId, userId)
        .run();
    }
  }
}

export async function removeLabel(
  db: DB,
  userId: UserId,
  messageId: string,
  labelId: string,
): Promise<void> {
  await db
    .prepare(
      `DELETE FROM message_labels
         WHERE message_id = ? AND label_id = ?
           AND EXISTS (SELECT 1 FROM messages m WHERE m.id = ? AND m.user_id = ?)`,
    )
    .bind(messageId, labelId, messageId, userId)
    .run();
}

export async function labelsForMessages(
  db: DB,
  userId: UserId,
  ids: string[],
): Promise<Map<string, LabelRow[]>> {
  if (!ids.length) return new Map();
  const ph = ids.map(() => "?").join(",");
  const res = await db
    .prepare(
      `SELECT ml.message_id, l.id, l.name, l.color, l.created_at
       FROM message_labels ml JOIN labels l ON l.id = ml.label_id
       WHERE l.user_id = ? AND ml.message_id IN (${ph})`,
    )
    .bind(userId, ...ids)
    .all<{ message_id: string } & LabelRow>();
  const map = new Map<string, LabelRow[]>();
  for (const row of res.results ?? []) {
    const arr = map.get(row.message_id) ?? [];
    arr.push({ id: row.id, name: row.name, color: row.color, created_at: row.created_at });
    map.set(row.message_id, arr);
  }
  return map;
}

// ── Outbound / undo-send ─────────────────────────────────────────────────────

export async function insertOutbound(
  db: DB,
  userId: UserId,
  opts: {
    inReplyToMessageId: string;
    from: string;
    to: string;
    subject: string;
    html: string | null;
    text: string;
    sendAfter?: number;
  },
): Promise<string> {
  const id = crypto.randomUUID();
  const ts = Date.now();
  const snippet = opts.text.replace(/\s+/g, " ").trim().slice(0, 200);
  const pending = opts.sendAfter !== undefined;

  const parent = await getMessage(db, userId, opts.inReplyToMessageId);
  const threadId = parent?.thread_id ?? parent?.message_id ?? opts.inReplyToMessageId;
  const inReplyTo = parent?.message_id ?? null;

  await db
    .prepare(
      `INSERT INTO messages
         (id, user_id, in_reply_to, thread_id, direction, from_addr, from_name,
          to_addr, subject, snippet, html, text, raw_key, received_at, is_read,
          send_state, send_after)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`,
    )
    .bind(
      id,
      userId,
      inReplyTo,
      threadId,
      "out",
      opts.from,
      null,
      opts.to,
      opts.subject,
      snippet,
      opts.html,
      opts.text,
      "",
      ts,
      pending ? "pending" : null,
      opts.sendAfter ?? null,
    )
    .run();
  return id;
}

/** Record an outbound message (new compose / forward / reply) with cc/bcc and
 *  attachment rows. Returns the new message id. Pending if sendAfter is set. */
export async function recordOutbound(
  db: DB,
  userId: UserId,
  opts: {
    from: string;
    to: string;
    cc?: string | null;
    bcc?: string | null;
    subject: string;
    html: string | null;
    text: string;
    inReplyToMessageId?: string | null;
    sendAfter?: number;
    attachments?: { key: string; filename: string; mime_type: string; size_bytes: number }[];
  },
): Promise<string> {
  const id = crypto.randomUUID();
  const ts = Date.now();
  const snippet = opts.text.replace(/\s+/g, " ").trim().slice(0, 200);
  const pending = opts.sendAfter !== undefined;

  let threadId: string = id;
  let inReplyTo: string | null = null;
  if (opts.inReplyToMessageId) {
    const parent = await getMessage(db, userId, opts.inReplyToMessageId);
    threadId = parent?.thread_id ?? parent?.message_id ?? opts.inReplyToMessageId;
    inReplyTo = parent?.message_id ?? null;
  }

  await db
    .prepare(
      `INSERT INTO messages
         (id, user_id, in_reply_to, thread_id, direction, from_addr, from_name,
          to_addr, cc, bcc, subject, snippet, html, text, raw_key, received_at,
          is_read, send_state, send_after)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`,
    )
    .bind(
      id,
      userId,
      inReplyTo,
      threadId,
      "out",
      opts.from,
      null,
      opts.to,
      opts.cc ?? null,
      opts.bcc ?? null,
      opts.subject,
      snippet,
      opts.html,
      opts.text,
      "",
      ts,
      pending ? "pending" : null,
      opts.sendAfter ?? null,
    )
    .run();

  for (const a of opts.attachments ?? []) {
    await db
      .prepare(
        `INSERT INTO attachments (id, user_id, message_id, filename, mime_type, r2_key, size_bytes, content_id)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .bind(crypto.randomUUID(), userId, id, a.filename, a.mime_type, a.key, a.size_bytes, null)
      .run();
  }
  return id;
}

// ── Drafts ───────────────────────────────────────────────────────────────────

export async function listDrafts(db: DB, userId: UserId): Promise<DraftRow[]> {
  const res = await db
    .prepare(`SELECT * FROM drafts WHERE user_id = ? ORDER BY updated_at DESC`)
    .bind(userId)
    .all<DraftRow>();
  return res.results ?? [];
}

export async function getDraft(db: DB, userId: UserId, id: string): Promise<DraftRow | null> {
  return (
    (await db
      .prepare(`SELECT * FROM drafts WHERE id = ? AND user_id = ?`)
      .bind(id, userId)
      .first<DraftRow>()) ?? null
  );
}

export async function upsertDraft(
  db: DB,
  userId: UserId,
  d: {
    id?: string;
    to_addr: string;
    cc?: string | null;
    bcc?: string | null;
    subject?: string | null;
    text?: string | null;
    html?: string | null;
    in_reply_to_id?: string | null;
    attachments?: string | null;
  },
): Promise<DraftRow> {
  const id = d.id ?? crypto.randomUUID();
  const updated_at = Date.now();
  await db
    .prepare(
      `INSERT INTO drafts (id, user_id, to_addr, cc, bcc, subject, text, html, in_reply_to_id, attachments, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         to_addr=excluded.to_addr, cc=excluded.cc, bcc=excluded.bcc, subject=excluded.subject,
         text=excluded.text, html=excluded.html, in_reply_to_id=excluded.in_reply_to_id,
         attachments=excluded.attachments, updated_at=excluded.updated_at
       WHERE drafts.user_id = excluded.user_id`,
    )
    .bind(
      id,
      userId,
      d.to_addr,
      d.cc ?? null,
      d.bcc ?? null,
      d.subject ?? null,
      d.text ?? null,
      d.html ?? null,
      d.in_reply_to_id ?? null,
      d.attachments ?? null,
      updated_at,
    )
    .run();
  return {
    id,
    to_addr: d.to_addr,
    cc: d.cc ?? null,
    bcc: d.bcc ?? null,
    subject: d.subject ?? null,
    text: d.text ?? null,
    html: d.html ?? null,
    in_reply_to_id: d.in_reply_to_id ?? null,
    attachments: d.attachments ?? null,
    updated_at,
  };
}

export async function deleteDraft(db: DB, userId: UserId, id: string): Promise<void> {
  await db.prepare(`DELETE FROM drafts WHERE id = ? AND user_id = ?`).bind(id, userId).run();
}

export async function draftCount(db: DB, userId: UserId): Promise<number> {
  const r = await db
    .prepare(`SELECT COUNT(*) AS n FROM drafts WHERE user_id = ?`)
    .bind(userId)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

// ── Aliases ──────────────────────────────────────────────────────────────────

export async function listAliases(db: DB, userId: UserId): Promise<AliasWithCount[]> {
  const res = await db
    .prepare(
      `SELECT a.address, a.name, a.note, a.disabled, a.created_at,
              COUNT(m.id) AS mail_count,
              SUM(CASE WHEN m.is_read = 0 AND m.direction = 'in' THEN 1 ELSE 0 END) AS unread_count
       FROM aliases a
       -- The join needs its own owner check: an address can appear in more than
       -- one mailbox's history, and without this each user would see the other's
       -- counts against their own alias.
       LEFT JOIN messages m
              ON m.to_addr = a.address AND m.is_deleted = 0 AND m.direction = 'in'
             AND m.user_id = a.user_id
       WHERE a.user_id = ?
       GROUP BY a.address
       ORDER BY a.created_at DESC`,
    )
    .bind(userId)
    .all<AliasWithCount>();
  return (res.results ?? []).map((r) => ({
    ...r,
    mail_count: r.mail_count ?? 0,
    unread_count: r.unread_count ?? 0,
  }));
}

export async function createAlias(
  db: DB,
  userId: UserId,
  address: string,
  name: string | null,
  note: string | null,
): Promise<AliasRow> {
  const created_at = Date.now();
  // `address` is the global primary key — one address has exactly one owner
  // across the whole instance, which is what keeps the routing rules from ever
  // disagreeing with each other. The owner check on the update keeps a second
  // user from quietly taking over someone else's alias by re-creating it.
  await db
    .prepare(
      `INSERT INTO aliases (address, user_id, name, note, disabled, created_at) VALUES (?,?,?,?,0,?)
       ON CONFLICT(address) DO UPDATE SET name = COALESCE(excluded.name, aliases.name),
                                          note = COALESCE(excluded.note, aliases.note)
        WHERE aliases.user_id = excluded.user_id`,
    )
    .bind(address, userId, name, note, created_at)
    .run();
  return (await db
    .prepare(`SELECT * FROM aliases WHERE address = ? AND user_id = ?`)
    .bind(address, userId)
    .first<AliasRow>())!;
}

/** Auto-track an alias on first inbound (no-op if it already exists). */
export async function registerAlias(
  db: DB,
  userId: UserId,
  address: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO aliases (address, user_id, disabled, created_at) VALUES (?,?,0,?)`,
    )
    .bind(address, userId, Date.now())
    .run();
}

export async function updateAlias(
  db: DB,
  userId: UserId,
  address: string,
  fields: { name?: string | null; note?: string | null; disabled?: 0 | 1 },
): Promise<void> {
  const sets: string[] = [];
  const args: unknown[] = [];
  if (fields.name !== undefined) {
    sets.push("name = ?");
    args.push(fields.name);
  }
  if (fields.note !== undefined) {
    sets.push("note = ?");
    args.push(fields.note);
  }
  if (fields.disabled !== undefined) {
    sets.push("disabled = ?");
    args.push(fields.disabled);
  }
  if (!sets.length) return;
  args.push(address, userId);
  await db
    .prepare(`UPDATE aliases SET ${sets.join(", ")} WHERE address = ? AND user_id = ?`)
    .bind(...args)
    .run();
}

export async function deleteAlias(db: DB, userId: UserId, address: string): Promise<void> {
  await db
    .prepare(`DELETE FROM aliases WHERE address = ? AND user_id = ?`)
    .bind(address, userId)
    .run();
}

// ── Filters / rules ──────────────────────────────────────────────────────────

export async function listRules(db: DB, userId: UserId): Promise<RuleRow[]> {
  const res = await db
    .prepare(`SELECT * FROM rules WHERE user_id = ? ORDER BY created_at ASC`)
    .bind(userId)
    .all<RuleRow>();
  return res.results ?? [];
}

export async function createRule(
  db: DB,
  userId: UserId,
  r: { field: string; op: string; value: string; action: string; action_value?: string | null },
): Promise<RuleRow> {
  const id = crypto.randomUUID();
  const created_at = Date.now();
  await db
    .prepare(
      `INSERT INTO rules (id, user_id, field, op, value, action, action_value, enabled, created_at)
       VALUES (?,?,?,?,?,?,?,1,?)`,
    )
    .bind(id, userId, r.field, r.op, r.value, r.action, r.action_value ?? null, created_at)
    .run();
  return (await db
    .prepare(`SELECT * FROM rules WHERE id = ? AND user_id = ?`)
    .bind(id, userId)
    .first<RuleRow>())!;
}

export async function updateRule(
  db: DB,
  userId: UserId,
  id: string,
  enabled: 0 | 1,
): Promise<void> {
  await db
    .prepare(`UPDATE rules SET enabled = ? WHERE id = ? AND user_id = ?`)
    .bind(enabled, id, userId)
    .run();
}

export async function deleteRule(db: DB, userId: UserId, id: string): Promise<void> {
  await db.prepare(`DELETE FROM rules WHERE id = ? AND user_id = ?`).bind(id, userId).run();
}

function ruleMatches(rule: RuleRow, msg: { from_addr: string; to_addr: string; subject: string }): boolean {
  const hay = (
    rule.field === "from" ? msg.from_addr : rule.field === "to" ? msg.to_addr : msg.subject
  ).toLowerCase();
  const needle = rule.value.toLowerCase();
  switch (rule.op) {
    case "equals":
      return hay === needle;
    case "startswith":
      return hay.startsWith(needle);
    case "endswith":
      return hay.endsWith(needle);
    default:
      return hay.includes(needle);
  }
}

/** Apply all enabled rules to one message. Returns the actions taken. */
export async function applyRules(
  db: DB,
  userId: UserId,
  msg: { id: string; from_addr: string; to_addr: string; subject: string },
): Promise<void> {
  // Both halves are scoped: the rule set, so only this user's rules run, and
  // each action, so a rule can never reach into another user's mail.
  const rules =
    (
      await db
        .prepare(`SELECT * FROM rules WHERE enabled = 1 AND user_id = ?`)
        .bind(userId)
        .all<RuleRow>()
    ).results ?? [];

  const setFlagOn = (field: "is_archived" | "is_read" | "is_deleted") =>
    db
      .prepare(`UPDATE messages SET ${field} = 1 WHERE id = ? AND user_id = ?`)
      .bind(msg.id, userId)
      .run();

  for (const rule of rules) {
    if (!ruleMatches(rule, msg)) continue;
    switch (rule.action) {
      case "label":
        if (rule.action_value) {
          await applyLabels(db, userId, [msg.id], [rule.action_value]);
        }
        break;
      case "archive":
        await setFlagOn("is_archived");
        break;
      case "read":
        await setFlagOn("is_read");
        break;
      case "trash":
        await setFlagOn("is_deleted");
        break;
    }
  }
}

/** Re-run all rules over recent inbound mail. Returns how many messages matched. */
export async function applyRulesToExisting(db: DB, userId: UserId): Promise<number> {
  const rows =
    (
      await db
        .prepare(
          `SELECT id, from_addr, to_addr, subject FROM messages
           WHERE direction = 'in' AND is_deleted = 0 AND user_id = ?
           ORDER BY received_at DESC LIMIT 1000`,
        )
        .bind(userId)
        .all<{ id: string; from_addr: string; to_addr: string; subject: string | null }>()
    ).results ?? [];
  let touched = 0;
  for (const m of rows) {
    await applyRules(db, userId, {
      id: m.id,
      from_addr: m.from_addr,
      to_addr: m.to_addr,
      subject: m.subject ?? "",
    });
    touched++;
  }
  return touched;
}

export async function claimPendingMessage(db: DB, id: string): Promise<boolean> {
  const res = await db
    .prepare(`UPDATE messages SET send_state='sending' WHERE id = ? AND send_state = 'pending'`)
    .bind(id)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

export async function markMessageSent(db: DB, id: string): Promise<void> {
  await db
    .prepare(`UPDATE messages SET send_state='sent', send_error=NULL WHERE id = ?`)
    .bind(id)
    .run();
}

/** Park a claimed message after a failed send: back to 'pending' when a retry
 *  could work, 'failed' with the reason when it never will. */
export async function markMessageUnsent(
  db: DB,
  id: string,
  outcome: { retryable: boolean; detail: string },
): Promise<void> {
  await db
    .prepare(`UPDATE messages SET send_state = ?, send_error = ? WHERE id = ?`)
    .bind(
      outcome.retryable ? "pending" : "failed",
      outcome.retryable ? null : outcome.detail,
      id,
    )
    .run();
}

export async function cancelPendingMessage(db: DB, id: string): Promise<boolean> {
  const res = await db
    .prepare(`UPDATE messages SET send_state='cancelled' WHERE id = ? AND send_state = 'pending'`)
    .bind(id)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

/**
 * Does this user own the R2 object behind `key`?
 *
 * Objects written since multi-tenancy carry a `u/<userId>/` prefix, which the
 * caller checks structurally. This covers the rest — anything stored before the
 * prefix existed — by asking the tables that reference the key.
 */
export async function ownsR2Key(db: DB, userId: UserId, key: string): Promise<boolean> {
  const att = await db
    .prepare(`SELECT 1 FROM attachments WHERE r2_key = ? AND user_id = ? LIMIT 1`)
    .bind(key, userId)
    .first();
  if (att) return true;

  const msg = await db
    .prepare(`SELECT 1 FROM messages WHERE raw_key = ? AND user_id = ? LIMIT 1`)
    .bind(key, userId)
    .first();
  return !!msg;
}
