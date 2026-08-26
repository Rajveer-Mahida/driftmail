// Deciding whose inbox an incoming address belongs to.
//
// The instance accepts every address on its domains — that is the point of a
// catch-all — so this is not an allow/deny check so much as an ownership lookup.

import { globToRe, loadPolicies, type DomainPolicy } from "./config/domains.ts";

type DB = D1Database;

export type RouteReason =
  | "alias"
  | "alias_base"
  | "handle"
  | "email"
  | "subaddress"
  | "catchall";

export type RejectCode =
  | "bad_address"
  | "unknown_domain"
  | "disabled_alias"
  | "disabled_owner"
  | "no_owner";

export type Resolution =
  | {
      kind: "deliver";
      userId: string;
      reason: RouteReason;
      /** Whatever matched — the alias, the handle, or the domain. */
      matched: string;
      /** The full normalized address, including any +tag. Stored as to_addr. */
      recipient: string;
      /** Plus-tag stripped. This is what gets a row in `aliases`, so that
       *  foo+a@, foo+b@ and foo+c@ don't each become a separate alias. */
      baseAddress: string;
      policy: DomainPolicy;
    }
  | { kind: "reject"; code: RejectCode; recipient: string; policy?: DomainPolicy };

/** One step of the decision, for the admin's "where would this land?" preview. */
export type RouteStep = { rule: string; hit: boolean; detail?: string };

export type Normalized = {
  recipient: string;
  local: string;
  base: string;
  domain: string;
  baseAddress: string;
};

/**
 * Canonicalize an address for routing.
 *
 * Note that dots are NOT collapsed the way Gmail does: here a dot is a
 * sub-address separator, so `a.b@` and `ab@` are different addresses.
 */
export function normalizeAddress(raw: string): Normalized | null {
  let addr = raw.trim();
  // A recipient often arrives as `Name <a@b.com>` or just `<a@b.com>`.
  const angled = addr.match(/<([^>]*)>\s*$/);
  if (angled) addr = angled[1].trim();
  addr = addr.toLowerCase();

  // Split at the LAST @: a local part may legally contain one.
  const at = addr.lastIndexOf("@");
  if (at < 1 || at === addr.length - 1) return null;

  const local = addr.slice(0, at);
  // A trailing dot is a legal fully-qualified name on the wire.
  const domain = addr.slice(at + 1).replace(/\.$/, "");
  if (!domain || domain.includes("@") || /\s/.test(domain)) return null;

  const plus = local.indexOf("+");
  const base = plus === -1 ? local : local.slice(0, plus);
  if (!base) return null;

  return { recipient: `${local}@${domain}`, local, base, domain, baseAddress: `${base}@${domain}` };
}

/** The separators a handle can be joined to a tag with. `+` is included so
 *  `handle+tag@` resolves even though the tag was already stripped. */
const SEPARATORS = /[.\-+]/;

export function splitSegments(base: string): string[] {
  return base.split(SEPARATORS).filter(Boolean);
}

function matchPolicy(policies: DomainPolicy[], domain: string): DomainPolicy | null {
  return (
    policies.find((p) => p.domain === domain) ??
    policies.find((p) => globToRe(p.domain).test(domain)) ??
    null
  );
}

type AliasHit = { user_id: string | null; disabled: number };
type UserHit = { id: string; handle: string; disabled: number };

async function aliasOwner(db: DB, address: string): Promise<AliasHit | null> {
  return db
    .prepare(`SELECT user_id, disabled FROM aliases WHERE address = ?`)
    .bind(address)
    .first<AliasHit>();
}

async function userByHandleOrEmail(
  db: DB,
  handle: string,
  email: string,
): Promise<UserHit | null> {
  return db
    .prepare(`SELECT id, handle, disabled FROM users WHERE handle = ? OR email = ?`)
    .bind(handle, email)
    .first<UserHit>();
}

/**
 * Find the handle a sub-address names.
 *
 * Every segment is tested, not just the last: `tejash.aws@` has to reach tejash,
 * and so does `aws.tejash@`. When more than one segment names a handle — say two
 * users are called `meera` and `rajveer` and mail arrives for
 * `meera.rajveer@` — the FIRST segment wins, because the leading name is the one
 * a sender writes when they mean a person.
 *
 * Handles cannot contain `.`, `-` or `+` (see users.ts), which is what makes this
 * decidable rather than ambiguous.
 */
async function subAddressOwner(db: DB, base: string): Promise<UserHit | null> {
  const segments = splitSegments(base);
  // A single segment is not a sub-address; it was already tried as a handle.
  if (segments.length < 2) return null;

  for (const segment of segments) {
    const hit = await db
      .prepare(`SELECT id, handle, disabled FROM users WHERE handle = ?`)
      .bind(segment)
      .first<UserHit>();
    if (hit) return hit;
  }
  return null;
}

async function catchAllOwner(db: DB, policy: DomainPolicy): Promise<UserHit | null> {
  if (!policy.catchallUserId) return null;
  return db
    .prepare(`SELECT id, handle, disabled FROM users WHERE id = ?`)
    .bind(policy.catchallUserId)
    .first<UserHit>();
}

async function isDisabled(db: DB, userId: string): Promise<boolean> {
  const row = await db
    .prepare(`SELECT disabled FROM users WHERE id = ?`)
    .bind(userId)
    .first<{ disabled: number }>();
  // A missing user is treated as disabled: an alias pointing at a deleted account
  // must not deliver into nothing.
  return !row || row.disabled === 1;
}

/**
 * Resolve `rawAddress` to the mailbox that owns it.
 *
 * Rules, first match wins:
 *   R0  the domain must be one this instance handles
 *   R1  an exact alias
 *   R1b the alias for the plus-stripped address
 *   R2  a user's handle, or their login email
 *   R3  a handle appearing as a segment of the local part
 *   R5  the domain's catch-all owner
 *   R6  nobody — reject, and record why
 *
 * Every rule is backed by a globally unique column, so no two rules can both
 * match and disagree.
 */
export async function resolveRecipient(
  db: DB,
  rawAddress: string,
  policies?: DomainPolicy[],
): Promise<Resolution> {
  const n = normalizeAddress(rawAddress);
  if (!n) return { kind: "reject", code: "bad_address", recipient: rawAddress.trim().toLowerCase() };

  const all = policies ?? (await loadPolicies(db));
  const policy = matchPolicy(all, n.domain);
  if (!policy) return { kind: "reject", code: "unknown_domain", recipient: n.recipient };

  const deliver = async (
    userId: string,
    reason: RouteReason,
    matched: string,
  ): Promise<Resolution> => {
    if (await isDisabled(db, userId)) {
      return { kind: "reject", code: "disabled_owner", recipient: n.recipient, policy };
    }
    return {
      kind: "deliver",
      userId,
      reason,
      matched,
      recipient: n.recipient,
      baseAddress: n.baseAddress,
      policy,
    };
  };

  // R1 / R1b — an explicit alias, exact first, then plus-stripped.
  for (const [address, reason] of [
    [n.recipient, "alias"],
    [n.baseAddress, "alias_base"],
  ] as const) {
    const alias = await aliasOwner(db, address);
    if (alias) {
      // A burned alias bounces before anything is parsed or stored.
      if (alias.disabled === 1) {
        return { kind: "reject", code: "disabled_alias", recipient: n.recipient, policy };
      }
      if (alias.user_id) return deliver(alias.user_id, reason, address);
    }
    if (n.recipient === n.baseAddress) break;
  }

  // R2 — the whole local part is someone's handle, or the address is their login.
  const direct = await userByHandleOrEmail(db, n.base, n.baseAddress);
  if (direct) {
    return deliver(direct.id, direct.handle === n.base ? "handle" : "email", n.base);
  }

  // R3 — a handle appears as one segment of the local part.
  const sub = await subAddressOwner(db, n.base);
  if (sub) return deliver(sub.id, "subaddress", sub.handle);

  // R5 — the domain's catch-all owner takes everything else.
  const owner = await catchAllOwner(db, policy);
  if (owner) return deliver(owner.id, "catchall", policy.domain);

  // R6 — never guess an inbox.
  return { kind: "reject", code: "no_owner", recipient: n.recipient, policy };
}

/** The same rules, reporting every step, for the admin's routing preview. */
export async function explainRecipient(
  db: DB,
  rawAddress: string,
): Promise<{ normalized: Normalized | null; result: Resolution; trace: RouteStep[] }> {
  const trace: RouteStep[] = [];
  const n = normalizeAddress(rawAddress);
  trace.push({
    rule: "normalize",
    hit: !!n,
    detail: n ? `${n.base} @ ${n.domain}` : "not a usable address",
  });

  const result = await resolveRecipient(db, rawAddress);

  if (n) {
    const policies = await loadPolicies(db);
    const policy = matchPolicy(policies, n.domain);
    trace.push({
      rule: "domain",
      hit: !!policy,
      detail: policy ? `matched "${policy.domain}"` : `no policy for ${n.domain}`,
    });

    if (policy) {
      const exact = await aliasOwner(db, n.recipient);
      trace.push({ rule: "alias", hit: !!exact, detail: exact ? n.recipient : undefined });

      if (!exact && n.recipient !== n.baseAddress) {
        const base = await aliasOwner(db, n.baseAddress);
        trace.push({ rule: "alias (plus-stripped)", hit: !!base, detail: n.baseAddress });
      }

      const direct = await userByHandleOrEmail(db, n.base, n.baseAddress);
      trace.push({ rule: "handle or login email", hit: !!direct, detail: n.base });

      const sub = await subAddressOwner(db, n.base);
      trace.push({
        rule: "sub-address",
        hit: !!sub,
        detail: sub ? `segment "${sub.handle}"` : splitSegments(n.base).join(" / "),
      });

      trace.push({
        rule: "domain catch-all",
        hit: !!policy.catchallUserId,
        detail: policy.catchallUserId ?? "no catch-all owner set",
      });
    }
  }

  return { normalized: n, result, trace };
}
