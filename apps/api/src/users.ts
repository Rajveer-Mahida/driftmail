// Users: identity, password hashing, and the admin operations on both.

import type { PublicUser, SessionUser, UserRole } from "@email/shared";
import { timingSafeEqual } from "./auth.ts";

type DB = D1Database;

export type UserRow = {
  id: string;
  email: string;
  handle: string;
  name: string | null;
  pw_algo: string;
  pw_salt: string;
  pw_hash: string;
  pw_iterations: number;
  role: UserRole;
  token_version: number;
  disabled: number;
  must_change_pw: number;
  created_at: number;
  last_login_at: number | null;
};

// ── identity rules ───────────────────────────────────────────────────────────

/**
 * User ids contain only [a-z0-9] — deliberately, and not for looks.
 *
 * The FTS5 index carries `user_id` as an indexed column so a search can be
 * filtered inside the inverted index. A hyphenated UUID tokenizes into five
 * separate terms under unicode61, which breaks that filter; without hyphens it
 * is a single token.
 */
export function newUserId(): string {
  return `u${crypto.randomUUID().replace(/-/g, "")}`;
}

/**
 * Handles may not contain `.`, `-` or `+`.
 *
 * Those three are the sub-address separators the router splits on, so excluding
 * them from handles makes address resolution unambiguous by construction rather
 * than by tie-breaking after the fact.
 */
const HANDLE_RE = /^[a-z0-9](?:[a-z0-9_]{0,62}[a-z0-9])?$/;

/** Addresses every mail system expects to reach a human or a role account, so no
 *  user may claim them as a personal handle. Hyphenated forms (`no-reply`,
 *  `mailer-daemon`) are absent deliberately: a handle cannot contain a hyphen at
 *  all, so listing them here would be unreachable. */
const RESERVED_HANDLES = new Set([
  "postmaster",
  "abuse",
  "admin",
  "root",
  "noreply",
  "hostmaster",
  "webmaster",
  "security",
  "reply",
  "support",
]);

export function normalizeHandle(raw: string): string {
  return raw.trim().toLowerCase();
}

/** A valid handle from an address's local part: `rajveer.mahida` → `rajveer_mahida`. */
export function suggestHandle(local: string): string {
  return local
    .toLowerCase()
    .replace(/[.+\-\s]+/g, "_")
    .replace(/[^a-z0-9_]/g, "")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export function validateHandle(
  raw: string,
): { ok: true; handle: string } | { ok: false; error: string } {
  const handle = normalizeHandle(raw);
  if (!handle) return { ok: false, error: "A handle is required" };
  if (!HANDLE_RE.test(handle)) {
    return {
      ok: false,
      error:
        "Handles use lowercase letters, numbers and underscores, and can't contain " +
        "'.', '-' or '+' — those separate a handle from its sub-address tag.",
    };
  }
  if (RESERVED_HANDLES.has(handle)) {
    return { ok: false, error: `"${handle}" is reserved for mail system use` };
  }
  return { ok: true, handle };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateEmail(
  raw: string,
): { ok: true; email: string } | { ok: false; error: string } {
  const email = normalizeEmail(raw);
  if (!EMAIL_RE.test(email)) return { ok: false, error: "That doesn't look like an email address" };
  return { ok: true, email };
}

/** Length is the only password rule worth enforcing: composition requirements
 *  push people toward predictable substitutions without adding real entropy. */
export const MIN_PASSWORD_LENGTH = 12;

export function validatePassword(raw: string): { ok: true } | { ok: false; error: string } {
  if (raw.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, error: `Use at least ${MIN_PASSWORD_LENGTH} characters` };
  }
  return { ok: true };
}

// ── password hashing ─────────────────────────────────────────────────────────

/**
 * 100,000 is the ceiling, not a choice.
 *
 * Cloudflare Workers rejects PBKDF2 above 100,000 iterations outright
 * ("iteration counts above 100000 are not supported"), and Workers has no argon2
 * or bcrypt. That is below OWASP's 600,000 recommendation for PBKDF2-SHA-256, so
 * the compensating controls carry real weight here: the 12-character minimum
 * above and the login throttle below. `pw_iterations` is stored per row, so
 * raising this later needs no migration and no forced password reset.
 */
export const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const KEY_BITS = 256;

const b64 = (b: ArrayBuffer | Uint8Array): string =>
  btoa(String.fromCharCode(...new Uint8Array(b)));
const unb64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    // NFKC so a password typed on a different keyboard still matches.
    new TextEncoder().encode(password.normalize("NFKC")),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as unknown as BufferSource, iterations },
    key,
    KEY_BITS,
  );
  return b64(bits);
}

export type PasswordFields = Pick<UserRow, "pw_algo" | "pw_salt" | "pw_hash" | "pw_iterations">;

export async function hashPassword(password: string): Promise<PasswordFields> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  return {
    pw_algo: "pbkdf2-sha256",
    pw_salt: b64(salt),
    pw_hash: await derive(password, salt, PBKDF2_ITERATIONS),
    pw_iterations: PBKDF2_ITERATIONS,
  };
}

export async function verifyPassword(row: PasswordFields, password: string): Promise<boolean> {
  // Fail closed on an algorithm this build doesn't know, rather than guessing.
  if (row.pw_algo !== "pbkdf2-sha256") return false;
  const got = await derive(password, unb64(row.pw_salt), row.pw_iterations);
  // base64 is a bijection of the bytes, so comparing the strings is equivalent to
  // comparing the digests — and reuses the audited constant-time helper.
  return timingSafeEqual(got, row.pw_hash);
}

const DUMMY_SALT = new Uint8Array(SALT_BYTES);

/** Burn the same work an unknown email would have cost, so response time doesn't
 *  reveal whether an account exists. */
export async function dummyVerify(password: string): Promise<void> {
  await derive(password, DUMMY_SALT, PBKDF2_ITERATIONS);
}

// ── login throttle ───────────────────────────────────────────────────────────

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 10;

/** Checked BEFORE any key derivation, so a locked-out attacker costs no CPU. */
export async function checkLoginAllowed(
  db: DB,
  keys: string[],
  now = Date.now(),
): Promise<{ allowed: true } | { allowed: false; retryAfter: number }> {
  for (const key of keys) {
    const row = await db
      .prepare(`SELECT locked_until FROM login_attempts WHERE key = ?`)
      .bind(key)
      .first<{ locked_until: number | null }>();
    if (row?.locked_until && row.locked_until > now) {
      return { allowed: false, retryAfter: Math.ceil((row.locked_until - now) / 1000) };
    }
  }
  return { allowed: true };
}

export async function recordLoginFailure(db: DB, keys: string[], now = Date.now()): Promise<void> {
  for (const key of keys) {
    const row = await db
      .prepare(`SELECT fails, window_start FROM login_attempts WHERE key = ?`)
      .bind(key)
      .first<{ fails: number; window_start: number }>();

    const fresh = !row || now - row.window_start > WINDOW_MS;
    const fails = fresh ? 1 : row.fails + 1;
    const windowStart = fresh ? now : row.window_start;
    const lockedUntil = fails >= MAX_FAILS ? now + WINDOW_MS : null;

    await db
      .prepare(
        `INSERT INTO login_attempts (key, fails, window_start, locked_until) VALUES (?, ?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET
             fails = excluded.fails, window_start = excluded.window_start,
             locked_until = excluded.locked_until`,
      )
      .bind(key, fails, windowStart, lockedUntil)
      .run();
  }
}

export async function clearLoginFailures(db: DB, keys: string[]): Promise<void> {
  for (const key of keys) {
    await db.prepare(`DELETE FROM login_attempts WHERE key = ?`).bind(key).run();
  }
}

// ── reads ────────────────────────────────────────────────────────────────────

const COLUMNS = `id, email, handle, name, pw_algo, pw_salt, pw_hash, pw_iterations,
  role, token_version, disabled, must_change_pw, created_at, last_login_at`;

export function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    email: row.email,
    handle: row.handle,
    name: row.name,
    role: row.role,
    disabled: row.disabled,
    created_at: row.created_at,
    last_login_at: row.last_login_at,
  };
}

export function toSessionUser(row: UserRow): SessionUser {
  return { ...toPublicUser(row), must_change_pw: row.must_change_pw === 1 };
}

export async function getUserById(db: DB, id: string): Promise<UserRow | null> {
  return db.prepare(`SELECT ${COLUMNS} FROM users WHERE id = ?`).bind(id).first<UserRow>();
}

export async function getUserByEmail(db: DB, email: string): Promise<UserRow | null> {
  return db
    .prepare(`SELECT ${COLUMNS} FROM users WHERE email = ?`)
    .bind(normalizeEmail(email))
    .first<UserRow>();
}

export async function getUserByHandle(db: DB, handle: string): Promise<UserRow | null> {
  return db
    .prepare(`SELECT ${COLUMNS} FROM users WHERE handle = ?`)
    .bind(normalizeHandle(handle))
    .first<UserRow>();
}

export async function listUsers(db: DB): Promise<UserRow[]> {
  const { results } = await db
    .prepare(`SELECT ${COLUMNS} FROM users ORDER BY created_at ASC`)
    .all<UserRow>();
  return results;
}

export async function countUsers(db: DB): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM users`).first<{ n: number }>();
  return row?.n ?? 0;
}

export async function countAdmins(db: DB): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0`)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// ── writes ───────────────────────────────────────────────────────────────────

export type CreateUserInput = {
  email: string;
  handle: string;
  password: string;
  name?: string | null;
  role?: UserRole;
  mustChangePassword?: boolean;
};

export class UserError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "UserError";
    this.status = status;
  }
}

export async function createUser(db: DB, input: CreateUserInput): Promise<UserRow> {
  const email = validateEmail(input.email);
  if (!email.ok) throw new UserError(email.error);
  const handle = validateHandle(input.handle);
  if (!handle.ok) throw new UserError(handle.error);
  const password = validatePassword(input.password);
  if (!password.ok) throw new UserError(password.error);

  if (await getUserByEmail(db, email.email)) {
    throw new UserError("Someone already signs in with that email address", 409);
  }
  if (await getUserByHandle(db, handle.handle)) {
    throw new UserError(`The handle "${handle.handle}" is already taken`, 409);
  }

  const pw = await hashPassword(input.password);
  const id = newUserId();
  const now = Date.now();

  await db
    .prepare(
      `INSERT INTO users (id, email, handle, name, pw_algo, pw_salt, pw_hash, pw_iterations,
                          role, token_version, disabled, must_change_pw, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`,
    )
    .bind(
      id,
      email.email,
      handle.handle,
      input.name?.trim() || null,
      pw.pw_algo,
      pw.pw_salt,
      pw.pw_hash,
      pw.pw_iterations,
      input.role ?? "user",
      input.mustChangePassword ? 1 : 0,
      now,
    )
    .run();

  const row = await getUserById(db, id);
  if (!row) throw new UserError("Failed to create the account", 500);
  return row;
}

/**
 * Create the very first administrator.
 *
 * Refuses if any user exists. The caller is still responsible for the atomic
 * instance claim — this is the belt to that braces, not a substitute for it.
 */
export async function createFirstAdmin(
  db: DB,
  input: Omit<CreateUserInput, "role">,
): Promise<UserRow> {
  if ((await countUsers(db)) > 0) {
    throw new UserError("This instance already has an account", 409);
  }
  return createUser(db, { ...input, role: "admin" });
}

/** Invalidate every existing session for this user. */
export async function bumpTokenVersion(db: DB, id: string): Promise<void> {
  await db
    .prepare(`UPDATE users SET token_version = token_version + 1 WHERE id = ?`)
    .bind(id)
    .run();
}

export async function setPassword(
  db: DB,
  id: string,
  password: string,
  opts?: { mustChange?: boolean },
): Promise<void> {
  const check = validatePassword(password);
  if (!check.ok) throw new UserError(check.error);

  const pw = await hashPassword(password);
  await db
    .prepare(
      `UPDATE users SET pw_algo = ?, pw_salt = ?, pw_hash = ?, pw_iterations = ?,
                        must_change_pw = ?, token_version = token_version + 1
         WHERE id = ?`,
    )
    .bind(pw.pw_algo, pw.pw_salt, pw.pw_hash, pw.pw_iterations, opts?.mustChange ? 1 : 0, id)
    .run();
}

export async function recordLogin(db: DB, id: string, now = Date.now()): Promise<void> {
  await db.prepare(`UPDATE users SET last_login_at = ? WHERE id = ?`).bind(now, id).run();
}

/** Re-hash on login when a row predates a raised iteration count, so the cost
 *  can rise without forcing anyone to reset their password. */
export async function upgradeHashIfStale(db: DB, row: UserRow, password: string): Promise<void> {
  if (row.pw_iterations >= PBKDF2_ITERATIONS) return;
  const pw = await hashPassword(password);
  await db
    .prepare(
      `UPDATE users SET pw_algo = ?, pw_salt = ?, pw_hash = ?, pw_iterations = ? WHERE id = ?`,
    )
    .bind(pw.pw_algo, pw.pw_salt, pw.pw_hash, pw.pw_iterations, row.id)
    .run();
}

export type UpdateUserInput = {
  name?: string | null;
  handle?: string;
  role?: UserRole;
  disabled?: boolean;
};

export async function updateUser(db: DB, id: string, input: UpdateUserInput): Promise<UserRow> {
  const target = await getUserById(db, id);
  if (!target) throw new UserError("No such user", 404);

  const sets: string[] = [];
  const args: unknown[] = [];
  // Each of these three changes what a session is allowed to do or where mail
  // goes, so it takes effect now rather than whenever the token happens to expire.
  let revoke = false;

  if (input.name !== undefined) {
    sets.push("name = ?");
    args.push(input.name?.trim() || null);
  }
  if (input.handle !== undefined) {
    const handle = validateHandle(input.handle);
    if (!handle.ok) throw new UserError(handle.error);
    const clash = await getUserByHandle(db, handle.handle);
    if (clash && clash.id !== id) {
      throw new UserError(`The handle "${handle.handle}" is already taken`, 409);
    }
    sets.push("handle = ?");
    args.push(handle.handle);
    revoke = true;
  }
  if (input.role !== undefined && input.role !== target.role) {
    if (target.role === "admin" && (await countAdmins(db)) <= 1) {
      throw new UserError("This is the only administrator — promote someone else first", 409);
    }
    sets.push("role = ?");
    args.push(input.role);
    revoke = true;
  }
  if (input.disabled !== undefined && (input.disabled ? 1 : 0) !== target.disabled) {
    if (input.disabled && target.role === "admin" && (await countAdmins(db)) <= 1) {
      throw new UserError("This is the only administrator — promote someone else first", 409);
    }
    sets.push("disabled = ?");
    args.push(input.disabled ? 1 : 0);
    revoke = true;
  }

  if (sets.length) {
    if (revoke) sets.push("token_version = token_version + 1");
    await db
      .prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`)
      .bind(...(args as never[]), id)
      .run();
  }

  const row = await getUserById(db, id);
  if (!row) throw new UserError("No such user", 404);
  return row;
}

/**
 * Adopt every row that predates multi-tenancy.
 *
 * `user_id` is nullable and NULL is invisible to every `user_id = ?` query, so
 * existing mail is fail-closed rather than exposed. This hands it to the first
 * administrator when the instance is claimed.
 */
export async function adoptOrphanRows(db: DB, userId: string): Promise<Record<string, number>> {
  const tables = [
    "messages",
    "attachments",
    "drafts",
    "aliases",
    "rules",
    "labels",
    "push_subscriptions",
  ];
  const adopted: Record<string, number> = {};

  for (const table of tables) {
    const res = await db
      .prepare(`UPDATE ${table} SET user_id = ? WHERE user_id IS NULL`)
      .bind(userId)
      .run();
    adopted[table] = res.meta?.changes ?? 0;
  }

  // The UPDATE above fires messages_au, which re-indexes each row; this compacts
  // the result and covers any row the triggers could not reach.
  await db.prepare(`INSERT INTO messages_fts(messages_fts) VALUES('rebuild')`).run();
  return adopted;
}
