// A D1Database-shaped adapter over node:sqlite, so tests can exercise real SQL
// against the real migration files.
//
// Backing this with SQLite rather than a hand-rolled query interpreter means the
// migrations themselves are under test: the CHECK constraints, the partial unique
// indexes and the FTS5 triggers are load-bearing, and nothing else exercises them
// before production.
//
// Node 24 ships node:sqlite behind an ExperimentalWarning but otherwise unflagged.

import { DatabaseSync, type StatementSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../apps/api/migrations", import.meta.url));

type Row = Record<string, unknown>;

/** node:sqlite returns null-prototype rows; D1 returns plain objects, and the
 *  difference shows up as a deepStrictEqual failure on values that look equal. */
function plain<T>(row: T): T {
  return row === undefined || row === null ? row : ({ ...row } as T);
}

/** D1 coerces bound values; node:sqlite is stricter, so normalize here. */
function toSqlite(v: unknown): null | number | bigint | string | Uint8Array {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number" || typeof v === "bigint" || typeof v === "string") return v;
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  return String(v);
}

class FakePreparedStatement {
  #stmt: StatementSync;
  #args: unknown[];

  constructor(stmt: StatementSync, args: unknown[] = []) {
    this.#stmt = stmt;
    this.#args = args;
  }

  bind(...args: unknown[]): FakePreparedStatement {
    return new FakePreparedStatement(this.#stmt, args);
  }

  async first<T = Row>(column?: string): Promise<T | null> {
    const row = this.#stmt.get(...this.#args.map(toSqlite)) as Row | undefined;
    if (row === undefined) return null;
    if (column !== undefined) return (row[column] ?? null) as T;
    return plain(row) as T;
  }

  async all<T = Row>(): Promise<{ results: T[]; success: true; meta: Record<string, unknown> }> {
    const results = (this.#stmt.all(...this.#args.map(toSqlite)) as T[]).map(plain);
    return { results, success: true, meta: { changes: 0, duration: 0, rows_read: results.length } };
  }

  async run(): Promise<{ success: true; meta: { changes: number; last_row_id: number } }> {
    const info = this.#stmt.run(...this.#args.map(toSqlite));
    return {
      success: true,
      meta: {
        changes: Number(info.changes ?? 0),
        last_row_id: Number(info.lastInsertRowid ?? 0),
      },
    };
  }

  async raw<T = unknown[]>(): Promise<T[]> {
    const rows = this.#stmt.all(...this.#args.map(toSqlite)) as Row[];
    return rows.map((r) => Object.values(r)) as T[];
  }
}

export class FakeD1 {
  readonly sqlite: DatabaseSync;

  constructor() {
    this.sqlite = new DatabaseSync(":memory:");
    // D1 enforces foreign keys; node:sqlite does not by default, and the labels
    // rebuild in 0010 depends on the FK cascade behaving the same way.
    this.sqlite.exec("PRAGMA foreign_keys = ON");
  }

  prepare(sql: string): FakePreparedStatement {
    return new FakePreparedStatement(this.sqlite.prepare(sql));
  }

  /** Apply every migration file in filename order, the same order wrangler uses. */
  migrate(): this {
    for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
      this.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
    }
    return this;
  }

  /** Escape hatch for fixtures and assertions — not part of the D1 surface. */
  exec(sql: string): void {
    this.sqlite.exec(sql);
  }

  query<T = Row>(sql: string, ...args: unknown[]): T[] {
    return (this.sqlite.prepare(sql).all(...args.map(toSqlite)) as T[]).map(plain);
  }

  /**
   * A snapshot of every user table, for "nothing was written" assertions.
   *
   * `except` exists for tables a rejected request is *expected* to touch — the
   * rate-limit counter being the obvious one.
   */
  snapshot(except: string[] = []): string {
    const skip = new Set(except);
    const tables = this.query<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'
         AND name NOT LIKE '%_fts%' ORDER BY name`,
    ).filter((t) => !skip.has(t.name));
    return JSON.stringify(
      tables.map((t) => [t.name, this.query(`SELECT * FROM "${t.name}"`)]),
    );
  }

  close(): void {
    this.sqlite.close();
  }
}

/** A migrated in-memory database, typed as D1 for code under test. */
export function freshDb(): FakeD1 {
  return new FakeD1().migrate();
}

/** Cast helper — the fake implements the subset of D1Database the app uses. */
export function asD1(db: FakeD1): never {
  return db as never;
}
