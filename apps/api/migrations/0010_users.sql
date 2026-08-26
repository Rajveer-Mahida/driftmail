-- Identities. Nothing existing is touched here, so this file is safe to apply to
-- a running instance before any of the scoping work lands.

CREATE TABLE IF NOT EXISTS users (
  id             TEXT PRIMARY KEY,          -- "u" + uuid without hyphens; see users.ts
  email          TEXT NOT NULL,             -- login identity, stored normalized
  handle         TEXT NOT NULL,             -- routing handle: [a-z0-9_], no . - +
  name           TEXT,

  pw_algo        TEXT NOT NULL DEFAULT 'pbkdf2-sha256',
  pw_salt        TEXT NOT NULL,             -- base64, 16 random bytes
  pw_hash        TEXT NOT NULL,             -- base64, 32 derived bytes
  pw_iterations  INTEGER NOT NULL,          -- per row, so the cost can rise later

  role           TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user')),
  token_version  INTEGER NOT NULL DEFAULT 1, -- bump to revoke every session at once
  disabled       INTEGER NOT NULL DEFAULT 0,
  must_change_pw INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  last_login_at  INTEGER
);

-- Uniqueness is on the normalized values; normalizeEmail/normalizeHandle in
-- users.ts are the only writers, which is what makes the routing rules in
-- routing.ts collision-free by construction rather than by tie-breaking.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email  ON users(email);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_handle ON users(handle);
CREATE INDEX        IF NOT EXISTS idx_users_role   ON users(role) WHERE disabled = 0;

-- Per-user preferences, as opposed to the instance-wide `config` table.
CREATE TABLE IF NOT EXISTS user_settings (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key     TEXT NOT NULL,
  value   TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
) WITHOUT ROWID;

-- Login throttle. One row per normalized email, plus one per client IP, so a
-- lockout costs no key derivation.
CREATE TABLE IF NOT EXISTS login_attempts (
  key          TEXT PRIMARY KEY,
  fails        INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL,
  locked_until INTEGER
);
