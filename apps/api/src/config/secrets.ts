// Credential storage.
//
// TRUST BOUNDARY (also in the README, and shown in the setup wizard):
// the D1 database is the secret store. Anyone who can read D1 — anyone with the
// Cloudflare account, anyone who can deploy this Worker — can read these values.
// That is the same exposure as `wrangler secret`, which anyone who can deploy can
// console.log. Moving secrets into D1 does not widen the blast radius; it makes it
// visible. The controls that actually help are a zone-scoped API token and the
// rotate/revoke UI, not encryption under a key stored beside the ciphertext.
//
// The one exception is CONFIG_ENC_KEY: an optional Worker secret the operator sets
// after deploy. It lives outside D1, so wrapping values under it is a real boundary
// against a leaked D1 export. Off by default.

const WRAPPED = "enc:v1:";

type DB = D1Database;

/** A credential in plaintext. Branded so it reads as deliberate at every use, and
 *  so a reviewer can grep for `reveal(` to find every place one escapes. */
export type SecretValue = string & { readonly __secret: unique symbol };

export type SecretKey =
  | "auth.session_secret"
  | "cf.token"
  | "resend.api_key"
  | "anthropic.api_key"
  | "push.vapid_private_jwk";

/** The only shape a handler may return. Never contains the value. */
export type SecretStatus = {
  key: SecretKey;
  present: boolean;
  masked: string;
  created_at: number | null;
};

export function reveal(v: SecretValue): string {
  return v as string;
}

/** A fingerprint safe to render: keeps enough to recognise which key this is,
 *  never enough to use it. */
export function mask(raw: string): string {
  const v = raw.trim();
  if (v.length <= 8) return "•".repeat(Math.max(v.length, 4));
  return `${v.slice(0, 4)}…${v.slice(-4)}`;
}

const b64 = (b: ArrayBuffer | Uint8Array): string =>
  btoa(String.fromCharCode(...new Uint8Array(b)));
const unb64 = (s: string): Uint8Array =>
  Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function wrappingKey(material: string, keyName: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(material),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new TextEncoder().encode(keyName),
      info: new TextEncoder().encode("driftmail-secret-v1"),
    },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function wrap(material: string, keyName: string, plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await wrappingKey(material, keyName);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plain),
  );
  return `${WRAPPED}${b64(iv)}.${b64(ct)}`;
}

async function unwrap(material: string, keyName: string, stored: string): Promise<string> {
  const [ivPart, ctPart] = stored.slice(WRAPPED.length).split(".");
  if (!ivPart || !ctPart) throw new Error(`Secret ${keyName} is wrapped but malformed`);
  const key = await wrappingKey(material, keyName);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: unb64(ivPart) },
    key,
    unb64(ctPart),
  );
  return new TextDecoder().decode(plain);
}

type EncEnv = { CONFIG_ENC_KEY?: string };

export async function getSecret(
  db: DB,
  env: EncEnv,
  key: SecretKey,
): Promise<SecretValue | null> {
  const row = await db
    .prepare(`SELECT value FROM secrets WHERE key = ?`)
    .bind(key)
    .first<{ value: string }>();
  if (!row) return null;

  if (!row.value.startsWith(WRAPPED)) return row.value as SecretValue;

  const material = env.CONFIG_ENC_KEY?.trim();
  if (!material) {
    // Fail loudly. Returning ciphertext as if it were a token would surface as a
    // baffling "invalid API key" from whichever provider received it.
    throw new Error(
      `Secret "${key}" is encrypted but CONFIG_ENC_KEY is not set on this Worker.`,
    );
  }
  return (await unwrap(material, key, row.value)) as SecretValue;
}

export async function setSecret(
  db: DB,
  env: EncEnv,
  key: SecretKey,
  raw: string,
  opts?: { force?: boolean },
): Promise<void> {
  const value = raw.trim();
  if (!value) throw new Error(`Refusing to store an empty secret for "${key}"`);

  // Rewriting the session secret signs every device out, so it must never happen
  // as a side effect of re-running setup.
  if (key === "auth.session_secret" && !opts?.force) {
    const existing = await db
      .prepare(`SELECT 1 FROM secrets WHERE key = ?`)
      .bind(key)
      .first();
    if (existing) return;
  }

  const material = env.CONFIG_ENC_KEY?.trim();
  const stored = material ? await wrap(material, key, value) : value;
  const now = Date.now();

  await db
    .prepare(
      `INSERT INTO secrets (key, value, masked, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value, masked = excluded.masked, updated_at = excluded.updated_at`,
    )
    .bind(key, stored, mask(value), now, now)
    .run();
}

export async function deleteSecret(db: DB, key: SecretKey): Promise<void> {
  await db.prepare(`DELETE FROM secrets WHERE key = ?`).bind(key).run();
}

export async function hasSecret(db: DB, key: SecretKey): Promise<boolean> {
  return !!(await db.prepare(`SELECT 1 FROM secrets WHERE key = ?`).bind(key).first());
}

/** The read model. This is the only secrets shape any handler may return. */
export async function secretStatus(db: DB, keys: SecretKey[]): Promise<SecretStatus[]> {
  const { results } = await db
    .prepare(`SELECT key, masked, created_at FROM secrets`)
    .all<{ key: string; masked: string; created_at: number }>();
  const byKey = new Map(results.map((r) => [r.key, r]));

  return keys.map((key) => {
    const row = byKey.get(key);
    return {
      key,
      present: !!row,
      masked: row?.masked ?? "",
      created_at: row?.created_at ?? null,
    };
  });
}
