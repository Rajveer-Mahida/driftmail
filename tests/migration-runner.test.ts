import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FakeD1, asD1 } from "./fakes/d1.ts";
import {
  MIGRATIONS,
  applyPendingMigrations,
  ensureSchema,
  getMigrationStatus,
  MigrationFailedError,
  UnmanagedDatabaseError,
  type Migration,
} from "../apps/api/src/migrations/runner.ts";
// @ts-expect-error -- plain .mjs script, no type declarations
import { buildBundle, splitSql } from "../scripts/bundle-migrations.mjs";

const DIR = fileURLToPath(new URL("../apps/api/migrations", import.meta.url));
const BUNDLE = fileURLToPath(new URL("../apps/api/src/migrations/bundle.json", import.meta.url));

const tables = (d: FakeD1) =>
  d
    .query<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    )
    .map((r) => r.name);

test("the committed bundle matches apps/api/migrations (run `pnpm db:bundle`)", () => {
  assert.equal(readFileSync(BUNDLE, "utf8"), buildBundle(`${DIR}/`));
});

test("the bundle lists every migration file, in order", () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
  assert.deepEqual(MIGRATIONS.map((m) => m.name), files);
});

test("trigger bodies survive statement splitting", () => {
  const parts = splitSql(`
    CREATE TABLE t (a TEXT); -- comment; with a semicolon
    CREATE TRIGGER t_ai AFTER INSERT ON t BEGIN
      INSERT INTO t (a) VALUES ('x;y');
      SELECT CASE WHEN 1 THEN 2 END;
    END;
    INSERT INTO t VALUES ('end;');
  `) as string[];
  assert.equal(parts.length, 3);
  assert.match(parts[1], /^CREATE TRIGGER[\s\S]*END;$/);
  assert.match(parts[2], /'end;'/);
});

test("an empty database is initialized by ensureSchema", async () => {
  const d = new FakeD1();
  assert.equal((await getMigrationStatus(asD1(d))).initialized, false);

  await ensureSchema(asD1(d));

  const status = await getMigrationStatus(asD1(d));
  assert.equal(status.initialized, true);
  assert.deepEqual(status.pending, []);
  assert.deepEqual(status.applied, MIGRATIONS.map((m) => m.name));
  for (const t of ["users", "messages", "domains", "config", "d1_migrations"]) {
    assert.ok(tables(d).includes(t), `missing ${t}`);
  }
  // The FTS triggers work, i.e. they were created whole.
  d.exec(`INSERT INTO users (id,email,handle,pw_salt,pw_hash,pw_iterations,created_at)
            VALUES ('u1','u1@x.com','u1','s','h',1,1)`);
  d.exec(`INSERT INTO messages (id, direction, from_addr, to_addr, subject, text, received_at, user_id)
            VALUES ('m1','in','a@b.com','c@d.com','Hello world','body',1,'u1')`);
  assert.equal(
    d.query(`SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'hello'`).length,
    1,
  );
  d.close();
});

test("a database already migrated by Wrangler is left alone", async () => {
  // What `wrangler d1 migrations apply` leaves behind: the tables plus its ledger.
  const d = new FakeD1().migrate();
  d.exec(`CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE,
            applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)`);
  for (const m of MIGRATIONS) d.exec(`INSERT INTO d1_migrations (name) VALUES ('${m.name}')`);
  const before = d.snapshot();

  await ensureSchema(asD1(d));
  assert.deepEqual(await applyPendingMigrations(asD1(d)), { applied: [] });
  assert.equal(d.snapshot(), before);
  d.close();
});

test("only pending migrations are applied, and recorded", async () => {
  const d = new FakeD1();
  const first = MIGRATIONS.slice(0, 3);
  await applyPendingMigrations(asD1(d), first);

  const status = await getMigrationStatus(asD1(d));
  assert.deepEqual(status.pending, MIGRATIONS.slice(3).map((m) => m.name));

  // ensureSchema never migrates a database that already has tables.
  await ensureSchema(asD1(d));
  assert.equal((await getMigrationStatus(asD1(d))).pending.length, MIGRATIONS.length - 3);

  const { applied } = await applyPendingMigrations(asD1(d));
  assert.deepEqual(applied, MIGRATIONS.slice(3).map((m) => m.name));
  d.close();
});

test("a failing migration rolls back and stops", async () => {
  const d = new FakeD1();
  const broken: Migration[] = [
    { name: "0001_ok.sql", statements: ["CREATE TABLE a (x INTEGER)"] },
    {
      name: "0002_bad.sql",
      statements: ["CREATE TABLE b (x INTEGER)", "INSERT INTO nope VALUES (1)"],
    },
    { name: "0003_never.sql", statements: ["CREATE TABLE c (x INTEGER)"] },
  ];
  await assert.rejects(applyPendingMigrations(asD1(d), broken), (err: unknown) => {
    assert.ok(err instanceof MigrationFailedError);
    assert.equal(err.migration, "0002_bad.sql");
    return true;
  });
  assert.deepEqual(tables(d), ["a", "d1_migrations"]);
  const status = await getMigrationStatus(asD1(d), broken);
  assert.deepEqual(status.applied, ["0001_ok.sql"]);
  assert.deepEqual(status.pending, ["0002_bad.sql", "0003_never.sql"]);
  d.close();
});

test("tables without a ledger are refused, not overwritten", async () => {
  const d = new FakeD1();
  d.exec(`CREATE TABLE someone_elses (x INTEGER)`);
  await assert.rejects(applyPendingMigrations(asD1(d)), UnmanagedDatabaseError);
  assert.deepEqual(tables(d), ["someone_elses"]);
  d.close();
});
