// Session tokens.
//
// The token carries who you are, which version of your credentials it was issued
// against, and when it expires — all covered by one HMAC. The signing key lives
// in the database now rather than in a Worker secret, so that the whole instance
// can be configured from the browser.

import { getSecret, reveal, setSecret } from "./config/secrets.ts";

const COOKIE = "dm_session";
const MAX_AGE = 60 * 60 * 24 * 30; // 30 days
const VERSION = "v2";

type DB = D1Database;
type SecretEnv = { DB: D1Database; CONFIG_ENC_KEY?: string };

export type SessionClaims = {
  /** User id. */
  uid: string;
  /** The user's token_version at issue time; a mismatch means revoked. */
  tv: number;
  /** Expiry, epoch milliseconds. */
  exp: number;
};

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const buf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

/** Length-independent constant-time comparison of two strings. */
export function timingSafeEqual(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  // Compare lengths without an early return, then fold the result in.
  let diff = ab.length ^ bb.length;
  const n = Math.max(ab.length, bb.length);
  for (let i = 0; i < n; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

// ── the signing key ──────────────────────────────────────────────────────────

/** Isolate-local cache. Every authenticated request needs the key, so reading it
 *  from D1 each time would put a round-trip in front of the whole API. */
let cached: { secret: string | null; at: number } | null = null;
const KEY_TTL_MS = 60_000;

export function invalidateAuthSecretCache(): void {
  cached = null;
}

/**
 * The session signing key, or null when the instance has not been set up.
 *
 * There is deliberately no default: a fallback constant in a public repo means
 * anyone can forge a session, so an unconfigured instance fails closed instead.
 */
export async function authSecret(env: SecretEnv): Promise<string | null> {
  if (cached && Date.now() - cached.at < KEY_TTL_MS) return cached.secret;
  const value = await getSecret(env.DB, env, "auth.session_secret");
  const secret = value ? reveal(value).trim() || null : null;
  cached = { secret, at: Date.now() };
  return secret;
}

/** Generate the signing key, once, when the instance is claimed. setSecret
 *  refuses to overwrite it unless forced, because rewriting it signs everyone
 *  out of every device. */
export async function ensureAuthSecret(env: SecretEnv): Promise<void> {
  const existing = await getSecret(env.DB, env, "auth.session_secret");
  if (existing) return;
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  await setSecret(env.DB, env, "auth.session_secret", hex);
  invalidateAuthSecretCache();
}

// ── tokens ───────────────────────────────────────────────────────────────────

/**
 * `v2.<uid>.<tokenVersion>.<expMs>.<signature>`
 *
 * Dotted rather than base64-encoded JSON: every field is already token-safe (the
 * id is [a-z0-9] by construction, the rest are integers), so there is no
 * encode/decode step to get subtly wrong.
 *
 * The role is deliberately absent. The middleware reads the user row anyway, to
 * check token_version and disabled, so role comes free from that read — and a
 * demotion takes effect on the very next request rather than in thirty days.
 */
export async function createSessionToken(
  secret: string,
  uid: string,
  tokenVersion: number,
  now = Date.now(),
): Promise<string> {
  const exp = now + MAX_AGE * 1000;
  const payload = `${VERSION}.${uid}.${tokenVersion}.${exp}`;
  return `${payload}.${await hmac(secret, payload)}`;
}

/**
 * Verify and decode, or return null.
 *
 * Never throws and never returns a bare `true`: every rejection path — missing
 * key, wrong version, malformed, expired, bad signature — returns null, so a
 * caller cannot accidentally treat a falsy-but-not-false result as success.
 */
export async function verifySessionToken(
  secret: string | null,
  token: string,
): Promise<SessionClaims | null> {
  if (!secret) return null;

  const parts = token.split(".");
  // Five parts exactly. A v1 token (`exp.sig`) is rejected here, which is what
  // signs out every pre-multi-user session on deploy.
  if (parts.length !== 5) return null;

  const [version, uid, tvRaw, expRaw, sig] = parts;
  if (version !== VERSION || !uid) return null;

  const tv = Number(tvRaw);
  const exp = Number(expRaw);
  if (!Number.isInteger(tv) || !Number.isInteger(exp)) return null;
  if (exp <= Date.now()) return null;

  const expected = await hmac(secret, `${version}.${uid}.${tvRaw}.${expRaw}`);
  if (!timingSafeEqual(sig, expected)) return null;

  return { uid, tv, exp };
}

export const cookieName = () => COOKIE;
export const cookieMaxAge = () => MAX_AGE;

/** Convenience for callers that have the env rather than the key. */
export async function issueSession(
  env: SecretEnv,
  uid: string,
  tokenVersion: number,
): Promise<string | null> {
  const secret = await authSecret(env);
  if (!secret) return null;
  return createSessionToken(secret, uid, tokenVersion);
}

export type { DB };
