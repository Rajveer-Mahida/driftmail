import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { freshDb } from "./fakes/d1.ts";

const DIR = fileURLToPath(new URL("../apps/api/migrations", import.meta.url));
const FILES = readdirSync(DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();

/** A database with every migration up to, but not including, `stop` applied. */
function upTo(stop: string): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const f of FILES.filter((f) => f < stop)) db.exec(readFileSync(join(DIR, f), "utf8"));
  return db;
}

const apply = (db: DatabaseSync, file: string) =>
  db.exec(readFileSync(join(DIR, file), "utf8"));

const count = (db: DatabaseSync, sql: string) =>
  (db.prepare(sql).get() as { n: number }).n;

/** user_id is a real foreign key, so owners have to exist before rows can name
 *  them — which is itself worth exercising. */
function seedUsers(db: DatabaseSync, ...ids: string[]): void {
  for (const id of ids) {
    db.exec(
      `INSERT INTO users (id,email,handle,pw_salt,pw_hash,pw_iterations,created_at)
         VALUES ('${id}','${id}@x.com','${id}','s','h',1,1)`,
    );
  }
}

test("every migration applies cleanly in filename order", () => {
  const d = freshDb();
  const tables = d
    .query<{ name: string }>(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
    .map((r) => r.name);
  for (const expected of [
    "aliases",
    "attachments",
    "config",
    "domain_dns",
    "domains",
    "drafts",
    "labels",
    "login_attempts",
    "message_labels",
    "messages",
    "push_subscriptions",
    "rules",
    "secrets",
    "unrouted",
    "user_settings",
    "users",
  ]) {
    assert.ok(tables.includes(expected), `missing table ${expected}`);
  }
  d.close();
});

test("the labels rebuild preserves every label assignment", () => {
  // message_labels.label_id is ON DELETE CASCADE, so dropping `labels` naively
  // makes SQLite run an implicit DELETE that empties the join table. This is the
  // regression test for that ordering.
  const db = upTo("0011");
  db.exec(`INSERT INTO messages (id, direction, from_addr, to_addr, subject, text, received_at)
             VALUES ('m1','in','a@b.com','c@d.com','Hello world','body',1)`);
  db.exec(`INSERT INTO labels (id, name, color, created_at) VALUES ('l1','Work','#fff',1)`);
  db.exec(`INSERT INTO message_labels (message_id, label_id) VALUES ('m1','l1')`);

  apply(db, "0011_user_scoping.sql");

  assert.equal(count(db, `SELECT COUNT(*) n FROM message_labels`), 1, "label assignments lost");
  assert.equal(count(db, `SELECT COUNT(*) n FROM labels`), 1);
  db.close();
});

test("two users may each own a label of the same name", () => {
  const db = upTo("0011");
  apply(db, "0011_user_scoping.sql");
  seedUsers(db, "ua", "ub");

  db.exec(`INSERT INTO labels (id,user_id,name,color,created_at) VALUES ('l2','ua','Work','#fff',1)`);
  db.exec(`INSERT INTO labels (id,user_id,name,color,created_at) VALUES ('l3','ub','Work','#fff',1)`);
  // …but not the same name twice for one user.
  assert.throws(
    () =>
      db.exec(`INSERT INTO labels (id,user_id,name,color,created_at) VALUES ('l4','ua','Work','#fff',1)`),
    /UNIQUE/,
  );
  db.close();
});

test("full-text search filters by owner inside the index", () => {
  const db = upTo("0011");
  db.exec(`INSERT INTO messages (id, direction, from_addr, to_addr, subject, text, received_at)
             VALUES ('m1','in','a@b.com','c@d.com','Hello world','body',1)`);
  apply(db, "0011_user_scoping.sql");
  seedUsers(db, "ua", "ub");
  db.exec(`UPDATE messages SET user_id='ua' WHERE id='m1'`);

  const search = (match: string) =>
    db
      .prepare(
        `SELECT m.id FROM messages m JOIN messages_fts f ON f.rowid = m.rowid
           WHERE messages_fts MATCH ?`,
      )
      .all(match);

  const cols = `{subject from_addr snippet text}`;
  assert.equal(search(`user_id : ua AND ${cols} : ("world"*)`).length, 1);
  assert.equal(search(`user_id : ub AND ${cols} : ("world"*)`).length, 0, "owner filter leaked");
  // The column filter set is what stops free text matching the user_id column —
  // without it, searching another user's id string returns their messages.
  assert.equal(search(`user_id : ub AND ${cols} : ("ua"*)`).length, 0);
  db.close();
});

test("adopting a row re-indexes it for search", () => {
  // The AFTER UPDATE trigger is what makes adoptOrphanRows() reindex for free.
  const db = upTo("0011");
  db.exec(`INSERT INTO messages (id, direction, from_addr, to_addr, subject, text, received_at)
             VALUES ('m1','in','a@b.com','c@d.com','Quarterly report','body',1)`);
  apply(db, "0011_user_scoping.sql");
  seedUsers(db, "ua", "ub");

  const search = (uid: string) =>
    db
      .prepare(
        `SELECT m.id FROM messages m JOIN messages_fts f ON f.rowid = m.rowid
           WHERE messages_fts MATCH ?`,
      )
      .all(`user_id : ${uid} AND {subject from_addr snippet text} : ("quarterly"*)`);

  assert.equal(search("ua").length, 0, "unadopted mail must be invisible");
  db.exec(`UPDATE messages SET user_id='ua' WHERE id='m1'`);
  assert.equal(search("ua").length, 1);
  db.exec(`UPDATE messages SET user_id='ub' WHERE id='m1'`);
  assert.equal(search("ua").length, 0, "the previous owner must stop matching");
  assert.equal(search("ub").length, 1);
  db.close();
});

test("deleting a message leaves no orphan posting behind", () => {
  const db = upTo("0011");
  apply(db, "0011_user_scoping.sql");
  seedUsers(db, "ua");
  db.exec(`INSERT INTO messages (id, direction, from_addr, to_addr, subject, text, received_at, user_id)
             VALUES ('m1','in','a@b.com','c@d.com','Unique token here','body',1,'ua')`);
  db.exec(`DELETE FROM messages WHERE id='m1'`);

  const rows = db
    .prepare(`SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?`)
    .all(`{subject from_addr snippet text} : ("unique"*)`);
  assert.equal(rows.length, 0);
  db.close();
});
