// Per-domain mail policy: which addresses this instance accepts, and how they are
// shaped. Replaces the ALIAS_DOMAINS / ALLOWED_EMAILS / ALIAS_SUFFIX /
// FALLBACK_FORWARD_TO / REPLY_FROM env vars, none of which could vary per domain.
//
// The matching half is deliberately pure and synchronous. It is the one
// security-critical function here — it decides what gets into the database — so it
// stays trivially testable with no I/O in the way.

type DB = D1Database;

export type SendProviderName = "resend" | "cloudflare" | "none";

export type DomainRow = {
  domain: string;
  zone_id: string | null;
  zone_name: string | null;
  zone_type: string | null;
  is_primary: number;
  receive_enabled: number;
  routing_state: "none" | "enabling" | "pending_dns" | "ready" | "error";
  catch_all_worker: string | null;
  routing_error: string | null;
  accept_all: number;
  allowed_pattern: string | null;
  alias_suffix: string | null;
  fallback_forward_to: string | null;
  forward_to: string | null;
  catchall_user_id: string | null;
  send_provider: SendProviderName | null;
  send_state: "none" | "pending_dns" | "verifying" | "verified" | "failed";
  send_identity: string | null;
  send_error: string | null;
  default_from: string | null;
  last_checked_at: number | null;
  created_at: number;
  updated_at: number;
};

/** The subset the matcher needs, as plain data. */
export type DomainPolicy = {
  domain: string;
  acceptAll: boolean;
  allowedPattern: string[];
  aliasSuffix: string;
  fallbackForwardTo: string | null;
  forwardTo: string | null;
  defaultFrom: string | null;
  catchallUserId: string | null;
  isPrimary: boolean;
  sendProvider: SendProviderName | null;
};

// ── glob matching ────────────────────────────────────────────────────────────

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Turn a `*`-glob into an anchored regex (`*` → `.*`, everything else literal).
 *  Anchoring is what stops `hi@evil-example.com` matching a policy for
 *  `example.com`, so it is not optional. */
export function globToRe(glob: string): RegExp {
  const body = glob.split("*").map(escapeRe).join(".*");
  return new RegExp(`^${body}$`, "i");
}

function splitList(raw: string | null | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean);
}

export function toPolicy(row: DomainRow): DomainPolicy {
  return {
    domain: row.domain.toLowerCase(),
    acceptAll: row.accept_all === 1,
    allowedPattern: splitList(row.allowed_pattern).map((e) => e.toLowerCase()),
    aliasSuffix: row.alias_suffix ?? "",
    fallbackForwardTo: row.fallback_forward_to,
    forwardTo: row.forward_to,
    defaultFrom: row.default_from,
    catchallUserId: row.catchall_user_id,
    isPrimary: row.is_primary === 1,
    sendProvider: row.send_provider,
  };
}

/**
 * The policy whose domain glob matches this address, or null.
 *
 * Entries may be globs, so "*" accepts any domain and "*.example.com" accepts
 * every subdomain. Cloudflare only routes mail for zones you own, so "*" still
 * cannot be reached by mail for someone else's domain.
 */
export function matchDomain(policies: DomainPolicy[], address: string): DomainPolicy | null {
  const addr = address.trim().toLowerCase();
  const at = addr.lastIndexOf("@");
  if (at < 1 || at === addr.length - 1) return null;

  const domain = addr.slice(at + 1).replace(/\.$/, "");
  if (!domain || domain.includes("@") || /\s/.test(domain)) return null;

  return (
    policies.find((p) => p.domain === domain) ??
    policies.find((p) => globToRe(p.domain).test(domain)) ??
    null
  );
}

/**
 * Does this instance accept mail for `address`?
 *
 *   1. its domain must have a policy, else no;
 *   2. an accept-all policy takes everything on that domain;
 *   3. otherwise the full address must match one `allowedPattern` entry
 *      (`*` wildcards allowed, so `*.mail@example.com` reproduces a
 *      suffix-style scheme).
 *
 * With no domains configured nothing is accepted — an unconfigured instance must
 * not become an open relay into the database. That invariant is what keeps a
 * freshly deployed, unclaimed Worker inert.
 */
export function isAllowedRecipient(policies: DomainPolicy[], address: string): boolean {
  const policy = matchDomain(policies, address);
  if (!policy) return false;

  const addr = address.trim().toLowerCase();
  if (policy.acceptAll || !policy.allowedPattern.length) return true;
  return policy.allowedPattern.some((entry) => globToRe(entry).test(addr));
}

// ── storage ──────────────────────────────────────────────────────────────────

const COLUMNS = `domain, zone_id, zone_name, zone_type, is_primary, receive_enabled,
  routing_state, catch_all_worker, routing_error, accept_all, allowed_pattern,
  alias_suffix, fallback_forward_to, forward_to, catchall_user_id, send_provider,
  send_state, send_identity, send_error, default_from, last_checked_at, created_at, updated_at`;

export async function listDomains(db: DB): Promise<DomainRow[]> {
  const { results } = await db
    .prepare(`SELECT ${COLUMNS} FROM domains ORDER BY is_primary DESC, domain ASC`)
    .all<DomainRow>();
  return results;
}

export async function loadPolicies(db: DB): Promise<DomainPolicy[]> {
  const rows = await listDomains(db);
  return rows.filter((r) => r.receive_enabled === 1).map(toPolicy);
}

export async function getDomain(db: DB, domain: string): Promise<DomainRow | null> {
  return db
    .prepare(`SELECT ${COLUMNS} FROM domains WHERE domain = ?`)
    .bind(domain.toLowerCase())
    .first<DomainRow>();
}

export async function getPrimaryDomain(db: DB): Promise<DomainRow | null> {
  return db
    .prepare(`SELECT ${COLUMNS} FROM domains WHERE is_primary = 1`)
    .first<DomainRow>();
}

export type DomainInput = Partial<Omit<DomainRow, "domain" | "created_at" | "updated_at">>;

export async function upsertDomain(
  db: DB,
  domain: string,
  input: DomainInput,
): Promise<DomainRow> {
  const name = domain.trim().toLowerCase();
  const now = Date.now();

  // The partial unique index allows only one primary, so demote the incumbent
  // first rather than letting the insert fail.
  if (input.is_primary === 1) {
    await db.prepare(`UPDATE domains SET is_primary = 0 WHERE domain <> ?`).bind(name).run();
  }

  const existing = await getDomain(db, name);
  if (!existing) {
    await db
      .prepare(`INSERT INTO domains (domain, created_at, updated_at) VALUES (?, ?, ?)`)
      .bind(name, now, now)
      .run();
  }

  const fields = Object.entries(input).filter(([, v]) => v !== undefined);
  if (fields.length) {
    const set = fields.map(([k]) => `${k} = ?`).join(", ");
    await db
      .prepare(`UPDATE domains SET ${set}, updated_at = ? WHERE domain = ?`)
      .bind(...fields.map(([, v]) => v as never), now, name)
      .run();
  }

  const row = await getDomain(db, name);
  if (!row) throw new Error(`Domain ${name} vanished during upsert`);
  return row;
}

export async function deleteDomain(db: DB, domain: string): Promise<void> {
  await db.prepare(`DELETE FROM domains WHERE domain = ?`).bind(domain.toLowerCase()).run();
}

export async function setDomainCatchall(
  db: DB,
  domain: string,
  userId: string | null,
): Promise<void> {
  await db
    .prepare(`UPDATE domains SET catchall_user_id = ?, updated_at = ? WHERE domain = ?`)
    .bind(userId, Date.now(), domain.toLowerCase())
    .run();
}

// ── DNS record snapshots ─────────────────────────────────────────────────────

export type DnsPurpose = "routing" | "sending";
export type DnsStatus = "pending" | "written" | "live" | "conflict" | "failed";

export type DomainDnsRow = {
  domain: string;
  purpose: DnsPurpose;
  type: string;
  name: string;
  content: string;
  priority: number | null;
  status: DnsStatus;
  managed: number;
  detail: string | null;
  updated_at: number;
};

export async function listDns(
  db: DB,
  domain: string,
  purpose?: DnsPurpose,
): Promise<DomainDnsRow[]> {
  const sql = purpose
    ? `SELECT * FROM domain_dns WHERE domain = ? AND purpose = ? ORDER BY purpose, type, name`
    : `SELECT * FROM domain_dns WHERE domain = ? ORDER BY purpose, type, name`;
  const stmt = purpose
    ? db.prepare(sql).bind(domain.toLowerCase(), purpose)
    : db.prepare(sql).bind(domain.toLowerCase());
  const { results } = await stmt.all<DomainDnsRow>();
  return results;
}

export async function recordDns(
  db: DB,
  domain: string,
  purpose: DnsPurpose,
  records: Array<{
    type: string;
    name: string;
    content: string;
    priority?: number | null;
    status?: DnsStatus;
    managed?: boolean;
    detail?: string | null;
  }>,
): Promise<void> {
  const now = Date.now();
  for (const r of records) {
    await db
      .prepare(
        `INSERT INTO domain_dns (domain, purpose, type, name, content, priority, status, managed, detail, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(domain, purpose, type, name, content) DO UPDATE SET
           priority = excluded.priority, status = excluded.status,
           managed = excluded.managed, detail = excluded.detail,
           updated_at = excluded.updated_at`,
      )
      .bind(
        domain.toLowerCase(),
        purpose,
        r.type,
        r.name,
        r.content,
        r.priority ?? null,
        r.status ?? "pending",
        r.managed ? 1 : 0,
        r.detail ?? null,
        now,
      )
      .run();
  }
}

export async function clearDns(db: DB, domain: string, purpose: DnsPurpose): Promise<void> {
  await db
    .prepare(`DELETE FROM domain_dns WHERE domain = ? AND purpose = ?`)
    .bind(domain.toLowerCase(), purpose)
    .run();
}

// ── unrouted mail ────────────────────────────────────────────────────────────

export async function recordUnrouted(
  db: DB,
  entry: { address: string; from_addr?: string | null; subject?: string | null; reason: string },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO unrouted (id, address, from_addr, subject, reason, received_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      entry.address,
      entry.from_addr ?? null,
      entry.subject ?? null,
      entry.reason,
      Date.now(),
    )
    .run();
}
