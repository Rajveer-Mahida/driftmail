// Database migrations, applied by the Worker itself.
//
// Deploying is `build + wrangler deploy` and nothing else. The schema is brought
// up to date from inside the app instead:
//
//   - an EMPTY database is initialized automatically on first use (ensureSchema),
//     so a fresh deploy goes straight to /setup with no migration command;
//   - an existing database with pending migrations shows an "Update database"
//     card to admins (routes/admin.ts → /api/admin/migrations).
//
// The ledger is the same `d1_migrations` table `wrangler d1 migrations apply`
// writes, with the same file names, so databases migrated by Wrangler before
// this existed are recognized as up to date rather than re-migrated.

import bundle from "./bundle.json" with { type: "json" };

type DB = D1Database;

export type Migration = { name: string; statements: string[] };

export type MigrationStatus = {
  /** False when the database has no application tables at all. */
  initialized: boolean;
  /** False when tables exist but there is no ledger: something we didn't create. */
  managed: boolean;
  applied: string[];
  pending: string[];
};

export const MIGRATIONS: Migration[] = (bundle as { migrations: Migration[] }).migrations;

const LEDGER = "d1_migrations";
const CREATE_LEDGER =
  `CREATE TABLE IF NOT EXISTS ${LEDGER} (id INTEGER PRIMARY KEY AUTOINCREMENT, ` +
  `name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)`;

export class UnmanagedDatabaseError extends Error {
  constructor() {
    super(
      "This database already has tables but no migration history, so Driftmail won't touch it. " +
        "Point the Worker at an empty D1 database, or apply migrations with Wrangler.",
    );
    this.name = "UnmanagedDatabaseError";
  }
}

export class MigrationFailedError extends Error {
  readonly migration: string;
  constructor(migration: string, cause: unknown) {
    super(`Migration ${migration} failed: ${(cause as Error)?.message ?? String(cause)}`);
    this.name = "MigrationFailedError";
    this.migration = migration;
  }
}

async function userTables(db: DB): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table'
         AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != ?`,
    )
    .bind(LEDGER)
    .all<{ name: string }>();
  return results.map((r) => r.name);
}

async function hasLedger(db: DB): Promise<boolean> {
  const row = await db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .bind(LEDGER)
    .first<{ name: string }>();
  return row !== null;
}

export async function getMigrationStatus(
  db: DB,
  migrations: Migration[] = MIGRATIONS,
): Promise<MigrationStatus> {
  const tables = await userTables(db);
  const ledger = await hasLedger(db);
  const applied = ledger
    ? (await db.prepare(`SELECT name FROM ${LEDGER} ORDER BY id`).all<{ name: string }>()).results.map(
        (r) => r.name,
      )
    : [];
  const done = new Set(applied);
  return {
    initialized: tables.length > 0,
    managed: ledger || tables.length === 0,
    applied,
    pending: migrations.map((m) => m.name).filter((n) => !done.has(n)),
  };
}

/**
 * Apply every pending migration, in order. Each migration and its ledger row go
 * in one D1 batch, which D1 runs as a transaction: a failure rolls that
 * migration back entirely and stops, leaving earlier ones applied.
 */
export async function applyPendingMigrations(
  db: DB,
  migrations: Migration[] = MIGRATIONS,
): Promise<{ applied: string[] }> {
  const status = await getMigrationStatus(db, migrations);
  if (!status.managed) throw new UnmanagedDatabaseError();
  if (status.pending.length === 0) return { applied: [] };

  await db.prepare(CREATE_LEDGER).run();

  const pending = new Set(status.pending);
  const applied: string[] = [];
  for (const m of migrations) {
    if (!pending.has(m.name)) continue;
    try {
      await db.batch([
        ...m.statements.map((s) => db.prepare(s)),
        db.prepare(`INSERT INTO ${LEDGER} (name) VALUES (?)`).bind(m.name),
      ]);
    } catch (err) {
      throw new MigrationFailedError(m.name, err);
    }
    applied.push(m.name);
  }
  return { applied };
}

const ready = new WeakMap<object, Promise<void>>();

/**
 * Initialize an empty database, once per isolate. A database that already has
 * tables is left alone: pending migrations on a live instance are an admin's
 * decision (the Update database card), not something a request triggers.
 */
export function ensureSchema(db: DB, migrations: Migration[] = MIGRATIONS): Promise<void> {
  let p = ready.get(db);
  if (!p) {
    p = (async () => {
      const status = await getMigrationStatus(db, migrations);
      if (status.initialized) return;
      try {
        await applyPendingMigrations(db, migrations);
      } catch (err) {
        // Another isolate may have initialized it at the same moment; its batch
        // won and ours rolled back. That is success, not an error.
        const after = await getMigrationStatus(db, migrations);
        if (after.initialized && after.pending.length === 0) return;
        throw err;
      }
    })();
    ready.set(db, p);
    p.catch(() => ready.delete(db));
  }
  return p;
}
