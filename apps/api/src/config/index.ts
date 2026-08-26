// Reading and writing instance configuration.
//
// Replaces the env-var readers in the old settings.ts. One SELECT loads the whole
// config; there are ~20 keys, so a per-key query would be pure overhead.

import {
  CONFIG_KEYS,
  decode,
  defaults,
  encode,
  type ConfigKey,
  type ConfigShape,
} from "./schema.ts";

type DB = D1Database;

/** Isolate-local cache. The inbound mail path reads config on every message, so a
 *  D1 round-trip per message would be the hot cost; 5s is short enough that a
 *  settings change feels immediate and long enough to absorb a burst. Writes in
 *  this isolate invalidate it eagerly, so the TTL only matters across isolates. */
let cache: { value: ConfigShape; at: number } | null = null;
const TTL_MS = 5_000;

export function invalidateConfigCache(): void {
  cache = null;
}

export async function loadConfig(db: DB, opts?: { fresh?: boolean }): Promise<ConfigShape> {
  if (!opts?.fresh && cache && Date.now() - cache.at < TTL_MS) return cache.value;

  const { results } = await db.prepare(`SELECT key, value FROM config`).all<{
    key: string;
    value: string;
  }>();

  const stored = new Map(results.map((r) => [r.key, r.value]));
  const out = defaults();
  for (const key of CONFIG_KEYS) {
    (out as Record<string, unknown>)[key] = decode(key, stored.get(key) ?? null);
  }

  cache = { value: out, at: Date.now() };
  return out;
}

export async function getConfig<K extends ConfigKey>(db: DB, key: K): Promise<ConfigShape[K]> {
  return (await loadConfig(db))[key];
}

export async function setConfig(db: DB, patch: Partial<ConfigShape>): Promise<void> {
  const now = Date.now();
  const entries = Object.entries(patch) as [ConfigKey, ConfigShape[ConfigKey]][];
  if (!entries.length) return;

  for (const [key, value] of entries) {
    await db
      .prepare(
        `INSERT INTO config (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .bind(key, encode(key, value), now)
      .run();
  }
  invalidateConfigCache();
}

/**
 * Claim this instance, atomically.
 *
 * Two people can race to `/api/setup/claim`; a SELECT-then-INSERT would let both
 * win. A conditional insert makes the database the arbiter — exactly one caller
 * sees changes === 1, and the loser must write nothing at all.
 */
export async function claimInstance(db: DB, at = Date.now()): Promise<boolean> {
  const res = await db
    .prepare(
      `INSERT INTO config (key, value, updated_at)
         SELECT 'instance.claimed_at', ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM config WHERE key = 'instance.claimed_at')`,
    )
    .bind(String(at), at)
    .run();

  const won = res.meta.changes === 1;
  if (won) invalidateConfigCache();
  return won;
}

export async function isClaimed(db: DB): Promise<boolean> {
  return (await getConfig(db, "instance.claimed_at")) !== null;
}

/** Records when this deployment first served a request, so an abandoned instance
 *  can stop accepting the weaker SETUP_TOKEN claim after a day. */
export async function markFirstSeen(db: DB): Promise<number> {
  const existing = await getConfig(db, "instance.first_seen_at");
  if (existing !== null) return existing;
  const now = Date.now();
  await setConfig(db, { "instance.first_seen_at": now });
  return now;
}

export type { ConfigShape, ConfigKey };
