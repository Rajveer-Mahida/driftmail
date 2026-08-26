-- Configuration moves out of Worker env vars and into the database, so the whole
-- instance can be set up from the browser instead of the wrangler CLI.
--
-- Three concerns, three tables:
--   config   non-secret settings   — safe to return from any API
--   secrets  credentials           — never serialized; see the trust boundary note
--   domains  per-domain mail policy — replaces ALIAS_DOMAINS / ALLOWED_EMAILS /
--                                     ALIAS_SUFFIX / FALLBACK_FORWARD_TO / REPLY_FROM,
--                                     none of which could differ per domain

CREATE TABLE IF NOT EXISTS config (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Deliberately a separate table from `config` so that "never serialize this" is a
-- rule enforced in exactly one place rather than remembered at every call site.
--
-- TRUST BOUNDARY: values here may be plaintext. With no Worker secret left, any
-- key used to encrypt them would live in this same database, behind the same
-- access control — obfuscation, not a boundary. Anyone who can read D1 can read
-- these, which is the same exposure as `wrangler secret` (readable by anyone who
-- can deploy the Worker). The real controls are zone-scoped tokens and rotation.
-- If the operator sets the optional CONFIG_ENC_KEY Worker secret, values are
-- stored as `enc:v1:<b64 iv>.<b64 ct>` under a key that does NOT live in D1.
CREATE TABLE IF NOT EXISTS secrets (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  masked     TEXT NOT NULL,          -- safe-to-display fingerprint, e.g. "re_ab…9f"
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS domains (
  domain              TEXT PRIMARY KEY,   -- lowercase; may be a glob ("*", "*.example.com")
  zone_id             TEXT,               -- NULL when the zone is not in this CF account
  zone_name           TEXT,
  zone_type           TEXT,               -- 'full' | 'partial' | 'secondary' | NULL
  is_primary          INTEGER NOT NULL DEFAULT 0,

  -- Inbound
  receive_enabled     INTEGER NOT NULL DEFAULT 1,
  routing_state       TEXT NOT NULL DEFAULT 'none'
                        CHECK (routing_state IN ('none','enabling','pending_dns','ready','error')),
  catch_all_worker    TEXT,               -- worker the catch-all currently targets
  routing_error       TEXT,
  accept_all          INTEGER NOT NULL DEFAULT 1,
  allowed_pattern     TEXT,               -- comma-separated globs; NULL/'' = accept all
  alias_suffix        TEXT,
  fallback_forward_to TEXT,
  forward_to          TEXT,

  -- Owner of every address that no alias, handle or sub-address claims.
  -- No REFERENCES clause on purpose: `users` is created by a later migration, and
  -- a forward FK would resolve only at INSERT time. The relationship is enforced
  -- in deleteUser(), which nulls this column.
  catchall_user_id    TEXT,

  -- Outbound
  send_provider       TEXT CHECK (send_provider IN ('resend','cloudflare','none')),
  send_state          TEXT NOT NULL DEFAULT 'none'
                        CHECK (send_state IN ('none','pending_dns','verifying','verified','failed')),
  send_identity       TEXT,               -- Resend domain id, or the CF sending subdomain
  send_error          TEXT,
  default_from        TEXT,

  last_checked_at     INTEGER,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

-- Exactly one primary domain, enforced by a partial unique index.
CREATE UNIQUE INDEX IF NOT EXISTS idx_domains_primary ON domains(is_primary) WHERE is_primary = 1;
CREATE INDEX IF NOT EXISTS idx_domains_zone ON domains(zone_id);

-- Snapshot of the DNS records each integration expects, so the wizard can show a
-- copyable table and poll per-record status without re-hitting the provider.
CREATE TABLE IF NOT EXISTS domain_dns (
  domain     TEXT NOT NULL REFERENCES domains(domain) ON DELETE CASCADE,
  purpose    TEXT NOT NULL CHECK (purpose IN ('routing','sending')),
  type       TEXT NOT NULL,
  name       TEXT NOT NULL,
  content    TEXT NOT NULL,
  priority   INTEGER,
  status     TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','written','live','conflict','failed')),
  managed    INTEGER NOT NULL DEFAULT 0,   -- 1 = we created it, so we may update it
  detail     TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (domain, purpose, type, name, content)
);

-- Mail that reached the Worker but matched no owner. Without this the failure is
-- invisible: Cloudflare accepted the message and nothing shows it was dropped.
CREATE TABLE IF NOT EXISTS unrouted (
  id          TEXT PRIMARY KEY,
  address     TEXT NOT NULL,
  from_addr   TEXT,
  subject     TEXT,
  reason      TEXT NOT NULL,
  received_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_unrouted_received ON unrouted(received_at DESC);
