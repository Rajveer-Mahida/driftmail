-- Every user-owned row gains an owner.
--
-- READ THE ORDERING BEFORE EDITING. Step 1 exists because
-- message_labels.label_id is declared ON DELETE CASCADE: dropping `labels`
-- directly makes SQLite run an implicit DELETE that silently empties
-- message_labels, losing every label assignment in the database.

PRAGMA defer_foreign_keys = true;

-- ── 1. labels must be rebuilt, so park the join rows somewhere with no FK ─────
--
-- labels.name is declared NOT NULL UNIQUE, and that implicit index cannot be
-- dropped — but two users must each be able to own a label called "Work".

CREATE TABLE _ml_bak AS SELECT message_id, label_id FROM message_labels;
DROP TABLE message_labels;

CREATE TABLE labels_new (
  id         TEXT PRIMARY KEY,
  user_id    TEXT REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  color      TEXT NOT NULL DEFAULT '#888888',
  created_at INTEGER NOT NULL
);
INSERT INTO labels_new (id, user_id, name, color, created_at)
  SELECT id, NULL, name, color, created_at FROM labels;
DROP TABLE labels;
ALTER TABLE labels_new RENAME TO labels;

CREATE UNIQUE INDEX idx_labels_user_name ON labels(user_id, name);

-- Restored with the same shape it had. message_labels deliberately gets no
-- user_id of its own: both parents are scoped, and every write goes through a
-- guarded INSERT…SELECT that checks both sides.
CREATE TABLE message_labels (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  label_id   TEXT NOT NULL REFERENCES labels(id)   ON DELETE CASCADE,
  PRIMARY KEY (message_id, label_id)
);
INSERT INTO message_labels (message_id, label_id) SELECT message_id, label_id FROM _ml_bak;
DROP TABLE _ml_bak;
CREATE INDEX idx_ml_label ON message_labels(label_id);

-- ── 2. owner columns ─────────────────────────────────────────────────────────
--
-- Nullable on purpose. NULL means "not yet adopted", and a NULL is invisible to
-- every `user_id = ?` query — so pre-existing mail is fail-closed rather than
-- exposed to whoever claims the instance. adoptOrphanRows() fills them in when
-- the first administrator is created.

ALTER TABLE messages           ADD COLUMN user_id TEXT REFERENCES users(id);
ALTER TABLE attachments        ADD COLUMN user_id TEXT REFERENCES users(id);
ALTER TABLE drafts             ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE aliases            ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE rules              ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE push_subscriptions ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE CASCADE;

-- messages and attachments get NO cascade, deliberately: deleting a user has to
-- sweep their R2 objects first, so deletion is an explicit routine rather than an
-- FK side effect that would strand every blob.
--
-- domains.catchall_user_id has no foreign key at all (see 0008), so a deleted
-- owner can linger there. resolveRecipient() treats a missing user as disabled
-- rather than delivering into nothing.

-- ── 3. indexes become (user_id, …) composites ────────────────────────────────

DROP INDEX IF EXISTS idx_messages_received;
DROP INDEX IF EXISTS idx_messages_thread;
DROP INDEX IF EXISTS idx_messages_to;
DROP INDEX IF EXISTS idx_messages_deleted;
DROP INDEX IF EXISTS idx_msg_starred;
DROP INDEX IF EXISTS idx_msg_archived;
DROP INDEX IF EXISTS idx_msg_snooze;
DROP INDEX IF EXISTS idx_drafts_updated;
DROP INDEX IF EXISTS idx_rules_enabled;
-- idx_msg_pending(send_state, send_after) is KEPT unscoped: the cron is
-- instance-wide by design and must see every user's outbox.

CREATE INDEX idx_msg_user_received ON messages(user_id, received_at DESC);
CREATE INDEX idx_msg_user_thread   ON messages(user_id, thread_id);
CREATE INDEX idx_msg_user_to       ON messages(user_id, to_addr, received_at DESC);
CREATE INDEX idx_msg_user_raw      ON messages(user_id, raw_key);
CREATE INDEX idx_msg_user_inbox    ON messages(user_id, received_at DESC)
  WHERE is_deleted = 0 AND is_archived = 0 AND direction = 'in';
CREATE INDEX idx_msg_user_unread   ON messages(user_id)
  WHERE is_read = 0 AND is_deleted = 0 AND is_archived = 0 AND direction = 'in';
CREATE INDEX idx_msg_user_starred  ON messages(user_id, received_at DESC)
  WHERE is_starred = 1 AND is_deleted = 0;
CREATE INDEX idx_msg_user_archived ON messages(user_id, received_at DESC)
  WHERE is_archived = 1 AND is_deleted = 0;
CREATE INDEX idx_msg_user_trash    ON messages(user_id, received_at DESC) WHERE is_deleted = 1;
CREATE INDEX idx_msg_user_snooze   ON messages(user_id, snooze_until);
CREATE INDEX idx_msg_user_sent     ON messages(user_id, received_at DESC) WHERE direction = 'out';

CREATE INDEX idx_att_user_key       ON attachments(user_id, r2_key);
CREATE INDEX idx_drafts_user_upd    ON drafts(user_id, updated_at DESC);
CREATE INDEX idx_aliases_user       ON aliases(user_id);
CREATE INDEX idx_rules_user_enabled ON rules(user_id, enabled);
CREATE INDEX idx_push_user          ON push_subscriptions(user_id);

-- ── 4. full-text search has to know the owner ────────────────────────────────
--
-- Filtering in the outer WHERE is correct but slow: FTS5 walks every user's
-- matching documents and the join then discards them. Carrying user_id as an
-- INDEXED column instead turns the filter into a posting-list intersection
-- inside the index.
--
-- A virtual table's columns cannot be ALTERed, so the table and its three
-- triggers are rebuilt. user_id must already exist on `messages` (step 2)
-- because external-content FTS resolves column values by name.

DROP TRIGGER IF EXISTS messages_ai;
DROP TRIGGER IF EXISTS messages_ad;
DROP TRIGGER IF EXISTS messages_au;
DROP TABLE   IF EXISTS messages_fts;

CREATE VIRTUAL TABLE messages_fts USING fts5(
  subject,
  from_addr,
  snippet,
  text,
  user_id,
  content='messages',
  content_rowid='rowid'
);

CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, subject, from_addr, snippet, text, user_id)
  VALUES (new.rowid, new.subject, new.from_addr, new.snippet, new.text, new.user_id);
END;

CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, subject, from_addr, snippet, text, user_id)
  VALUES('delete', old.rowid, old.subject, old.from_addr, old.snippet, old.text, old.user_id);
END;

-- Re-indexing on UPDATE is what makes adoptOrphanRows() reindex for free when it
-- fills in user_id.
CREATE TRIGGER messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, subject, from_addr, snippet, text, user_id)
  VALUES('delete', old.rowid, old.subject, old.from_addr, old.snippet, old.text, old.user_id);
  INSERT INTO messages_fts(rowid, subject, from_addr, snippet, text, user_id)
  VALUES (new.rowid, new.subject, new.from_addr, new.snippet, new.text, new.user_id);
END;

INSERT INTO messages_fts(messages_fts) VALUES('rebuild');
