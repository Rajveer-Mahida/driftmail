import { test } from "node:test";
import assert from "node:assert/strict";
import { asUserId, VIEWS, type UserId } from "../packages/shared/src/index.ts";
import { freshDb, asD1, type FakeD1 } from "./fakes/d1.ts";
import { createFirstAdmin, createUser } from "../apps/api/src/users.ts";
import {
  listMessages,
  getMessage,
  getThread,
  getViewCounts,
  getLabelCounts,
  getAttachments,
  attachmentsForMessages,
  getAttachmentByCid,
  labelsForMessages,
  markRead,
  softDelete,
  setFlag,
  setSnooze,
  markAllRead,
  permanentDeleteMessages,
  listLabels,
  createLabel,
  deleteLabel,
  applyLabels,
  removeLabel,
  listDrafts,
  getDraft,
  upsertDraft,
  deleteDraft,
  draftCount,
  listAliases,
  createAlias,
  deleteAlias,
  listRules,
  createRule,
  applyRules,
  applyRulesToExisting,
  ownsR2Key,
} from "../apps/api/src/db.ts";

const PW = "a-long-enough-password";

type World = {
  d: FakeD1;
  a: UserId;
  b: UserId;
  /** One message, one label, one draft, one alias and one rule per user. */
  ids: Record<"a" | "b", { msg: string; label: string; draft: string; alias: string }>;
};

/**
 * Two users with an identical set of belongings, including a label of the same
 * name and mail arriving at the same address — the cases where a missing scope
 * would go unnoticed with dissimilar fixtures.
 */
async function world(): Promise<World> {
  const d = freshDb();
  const admin = await createFirstAdmin(asD1(d), {
    email: "a@example.com",
    handle: "aa",
    password: PW,
  });
  const other = await createUser(asD1(d), {
    email: "b@example.com",
    handle: "bb",
    password: PW,
  });

  const ids = {} as World["ids"];
  for (const [key, user] of [
    ["a", admin],
    ["b", other],
  ] as const) {
    const uid = asUserId(user.id);
    const msg = `m-${key}`;

    await asD1(d)
      .prepare(
        `INSERT INTO messages (id, user_id, message_id, thread_id, direction, from_addr, to_addr,
                               subject, snippet, text, raw_key, received_at, is_read)
           VALUES (?,?,?,?,'in','sender@out.com','shared@example.com',
                   'Quarterly report','snip','confidential body',?,1,0)`,
      )
      .bind(msg, uid, `<${msg}@x>`, `t-${key}`, `u/${uid}/emails/${msg}.eml`)
      .run();

    await asD1(d)
      .prepare(
        `INSERT INTO attachments (id, user_id, message_id, filename, mime_type, r2_key, content_id)
           VALUES (?,?,?,'secret.pdf','application/pdf',?,'cid-shared')`,
      )
      .bind(`att-${key}`, uid, msg, `u/${uid}/attachments/att-${key}.pdf`)
      .run();

    // Deliberately the same label name for both users.
    const label = await createLabel(asD1(d), uid, "Work", "#fff");
    await applyLabels(asD1(d), uid, [msg], [label.id]);

    const draft = await upsertDraft(asD1(d), uid, { to_addr: `draft-${key}@x.com` });
    await createAlias(asD1(d), uid, `alias-${key}@example.com`, null, null);

    ids[key] = { msg, label: label.id, draft: draft.id, alias: `alias-${key}@example.com` };
  }

  return { d, a: asUserId(admin.id), b: asUserId(other.id), ids };
}

/** B's world, exactly as it stands — for asserting nothing about it moved. */
const snapshotB = (d: FakeD1) =>
  JSON.stringify([
    d.query(`SELECT * FROM messages WHERE user_id LIKE '%' ORDER BY id`),
    d.query(`SELECT * FROM message_labels ORDER BY message_id, label_id`),
    d.query(`SELECT * FROM drafts ORDER BY id`),
    d.query(`SELECT * FROM aliases ORDER BY address`),
  ]);

// ── reads ────────────────────────────────────────────────────────────────────

test("no view ever lists another user's mail", async () => {
  const { d, a, ids } = await world();
  for (const view of VIEWS) {
    const rows = await listMessages(asD1(d), a, { view });
    assert.ok(
      rows.every((m) => m.id !== ids.b.msg),
      `${view} leaked`,
    );
  }
  // Including the trash and snoozed views, which use different predicates.
  await setFlag(asD1(d), a, [ids.a.msg], "is_deleted", 1);
  const trash = await listMessages(asD1(d), a, { view: "trash" });
  assert.deepEqual(trash.map((m) => m.id), [ids.a.msg]);
  d.close();
});

test("search cannot reach another user's mail, by content or by id", async () => {
  const { d, a, b, ids } = await world();

  // Both users hold a message containing this word.
  const mine = await listMessages(asD1(d), a, { view: "inbox", q: "confidential" });
  assert.deepEqual(mine.map((m) => m.id), [ids.a.msg]);

  const theirs = await listMessages(asD1(d), b, { view: "inbox", q: "confidential" });
  assert.deepEqual(theirs.map((m) => m.id), [ids.b.msg]);

  // Searching for the literal text of another user's id must not match either —
  // this is what the {column set} in the MATCH expression prevents.
  assert.deepEqual(await listMessages(asD1(d), a, { view: "inbox", q: b }), []);
  d.close();
});

test("fetching by id returns nothing rather than someone else's row", async () => {
  const { d, a, ids } = await world();
  // null, not a 403 — anything that distinguishes "not yours" from "not found"
  // confirms the row exists.
  assert.equal(await getMessage(asD1(d), a, ids.b.msg), null);
  assert.deepEqual(await getThread(asD1(d), a, "t-b"), []);
  assert.deepEqual(await getAttachments(asD1(d), a, ids.b.msg), []);
  assert.deepEqual(await attachmentsForMessages(asD1(d), a, [ids.b.msg]), {});
  assert.equal(await getAttachmentByCid(asD1(d), a, ids.b.msg, "cid-shared"), null);
  assert.equal((await labelsForMessages(asD1(d), a, [ids.b.msg])).size, 0);
  assert.equal(await getDraft(asD1(d), a, ids.b.draft), null);
  d.close();
});

test("counts and lists are the caller's own, despite identical names", async () => {
  const { d, a, ids } = await world();

  const counts = await getViewCounts(asD1(d), a);
  assert.equal(counts.inbox, 1);
  assert.equal(counts.unread, 1);

  const labels = await listLabels(asD1(d), a);
  assert.deepEqual(labels.map((l) => l.id), [ids.a.label]);

  // Both users have a label called "Work" with one message on it. A missing
  // scope on the message join shows up here as a count of 2.
  const labelCounts = await getLabelCounts(asD1(d), a);
  assert.equal(labelCounts.length, 1);
  assert.equal(labelCounts[0].count, 1);

  assert.deepEqual((await listDrafts(asD1(d), a)).map((x) => x.id), [ids.a.draft]);
  assert.equal(await draftCount(asD1(d), a), 1);
  assert.deepEqual((await listAliases(asD1(d), a)).map((x) => x.address), [ids.a.alias]);
  d.close();
});

test("alias mail counts do not include another user's mail at the same address", async () => {
  const { d, a } = await world();
  // Both users received mail addressed to shared@example.com in the fixture.
  await createAlias(asD1(d), a, "shared@example.com", null, null);
  const aliases = await listAliases(asD1(d), a);
  const shared = aliases.find((x) => x.address === "shared@example.com")!;
  assert.equal(shared.mail_count, 1, "counted the other user's mail");
  assert.equal(shared.unread_count, 1);
  d.close();
});

// ── writes ───────────────────────────────────────────────────────────────────

test("every write against another user's id is a no-op", async () => {
  const { d, a, ids } = await world();
  const before = snapshotB(d);

  await markRead(asD1(d), a, ids.b.msg, true);
  await softDelete(asD1(d), a, ids.b.msg);
  await setFlag(asD1(d), a, [ids.b.msg], "is_starred", 1);
  await setSnooze(asD1(d), a, [ids.b.msg], 99_999);
  await permanentDeleteMessages(asD1(d), a, [ids.b.msg]);
  await deleteLabel(asD1(d), a, ids.b.label);
  await removeLabel(asD1(d), a, ids.b.msg, ids.b.label);
  await deleteDraft(asD1(d), a, ids.b.draft);
  await deleteAlias(asD1(d), a, ids.b.alias);

  assert.equal(snapshotB(d), before, "a cross-user write changed something");
  d.close();
});

test("mark-all-read stops at the caller's own mail", async () => {
  const { d, a, ids } = await world();
  await markAllRead(asD1(d), a, { view: "inbox" });
  const read = (id: string) =>
    d.query<{ is_read: number }>(`SELECT is_read FROM messages WHERE id = ?`, id)[0].is_read;
  assert.equal(read(ids.a.msg), 1);
  assert.equal(read(ids.b.msg), 0);

  // And the by-label form, which takes a different code path.
  const { d: d2, a: a2, ids: ids2 } = await world();
  await markAllRead(asD1(d2), a2, { view: "inbox", labelId: ids2.b.label });
  assert.equal(
    d2.query<{ is_read: number }>(`SELECT is_read FROM messages WHERE id = ?`, ids2.b.msg)[0]
      .is_read,
    0,
  );
  d.close();
  d2.close();
});

test("a label cannot be attached to someone else's message, or vice versa", async () => {
  const { d, a, ids } = await world();
  const links = () => d.query(`SELECT * FROM message_labels`).length;
  const before = links();

  // Their message, my label.
  await applyLabels(asD1(d), a, [ids.b.msg], [ids.a.label]);
  // My message, their label.
  await applyLabels(asD1(d), a, [ids.a.msg], [ids.b.label]);
  // Both theirs.
  await applyLabels(asD1(d), a, [ids.b.msg], [ids.b.label]);

  assert.equal(links(), before, "a cross-user label link was created");
  d.close();
});

test("a rule never fires against another user's mail", async () => {
  const { d, a, b, ids } = await world();
  // A's rule matches the subject BOTH messages share.
  await createRule(asD1(d), a, {
    field: "subject",
    op: "contains",
    value: "quarterly",
    action: "archive",
  });

  assert.deepEqual((await listRules(asD1(d), b)).length, 0, "B must not see A's rule");

  // Running A's rules over B's message id changes nothing, because the action
  // itself is scoped as well as the rule set.
  await applyRules(asD1(d), a, {
    id: ids.b.msg,
    from_addr: "sender@out.com",
    to_addr: "shared@example.com",
    subject: "Quarterly report",
  });
  const archived = (id: string) =>
    d.query<{ is_archived: number }>(`SELECT is_archived FROM messages WHERE id = ?`, id)[0]
      .is_archived;
  assert.equal(archived(ids.b.msg), 0);

  // And the backfill only walks the owner's own mail.
  assert.equal(await applyRulesToExisting(asD1(d), a), 1);
  assert.equal(archived(ids.a.msg), 1);
  assert.equal(archived(ids.b.msg), 0);
  d.close();
});

test("a draft cannot be overwritten by another user reusing its id", async () => {
  const { d, a, ids } = await world();
  await upsertDraft(asD1(d), a, { id: ids.b.draft, to_addr: "hijacked@x.com" });
  const row = d.query<{ to_addr: string; user_id: string }>(
    `SELECT to_addr, user_id FROM drafts WHERE id = ?`,
    ids.b.draft,
  )[0];
  assert.equal(row.to_addr, "draft-b@x.com");
  d.close();
});

// ── stored objects ───────────────────────────────────────────────────────────

test("R2 keys are only claimable by the row that owns them", async () => {
  const { d, a, b, ids } = await world();
  const theirEml = `u/${b}/emails/${ids.b.msg}.eml`;
  const theirPdf = `u/${b}/attachments/att-b.pdf`;

  assert.equal(await ownsR2Key(asD1(d), a, theirEml), false);
  assert.equal(await ownsR2Key(asD1(d), a, theirPdf), false);
  assert.equal(await ownsR2Key(asD1(d), b, theirEml), true);
  assert.equal(await ownsR2Key(asD1(d), b, theirPdf), true);
  assert.equal(await ownsR2Key(asD1(d), a, "emails/does-not-exist.eml"), false);
  d.close();
});

test("an empty mailbox counts zero, not null", async () => {
  // SUM() over zero rows returns NULL in SQLite, which would render as "null"
  // in the sidebar for every new account.
  const d = freshDb();
  const user = await createUser(asD1(d), {
    email: "solo@example.com",
    handle: "solo",
    password: PW,
  });
  const counts = await getViewCounts(asD1(d), asUserId(user.id));
  assert.deepEqual(counts, {
    inbox: 0,
    unread: 0,
    starred: 0,
    snoozed: 0,
    archived: 0,
    trash: 0,
    sent: 0,
  });
  d.close();
});

// ── thread-collapsed list ────────────────────────────────────────────────────

/** Insert an inbound message row with a chosen thread_id. */
async function insertThreaded(
  d: FakeD1,
  uid: UserId,
  id: string,
  threadId: string,
  opts: { receivedAt: number; isRead?: 0 | 1; direction?: "in" | "out" } = { receivedAt: 1 },
) {
  await asD1(d)
    .prepare(
      `INSERT INTO messages (id, user_id, message_id, thread_id, direction, from_addr, to_addr,
                             subject, snippet, text, raw_key, received_at, is_read)
         VALUES (?,?,?,?,?,'sender@out.com','x@example.com','Groovy','snip','body',?,?,?)`,
    )
    .bind(
      id,
      uid,
      `<${id}@x>`,
      threadId,
      opts.direction ?? "in",
      `u/${uid}/emails/${id}.eml`,
      opts.receivedAt,
      opts.isRead ?? 0,
    )
    .run();
}

test("one send to two aliases collapses to one list row with counts", async () => {
  const { d, a } = await world();
  await insertThreaded(d, a, "c1", "t-shared", { receivedAt: 100, isRead: 1 });
  await insertThreaded(d, a, "c2", "t-shared", { receivedAt: 200, isRead: 0 });

  const rows = await listMessages(asD1(d), a, { view: "inbox" });
  const thread = rows.filter((r) => r.thread_id === "t-shared");
  assert.equal(thread.length, 1, "one row per thread");
  assert.equal(thread[0].id, "c2", "representative is the latest message");
  assert.equal(thread[0].thread_count, 2);
  assert.equal(thread[0].thread_unread, 1);
});

test("identical thread_id never merges across users", async () => {
  const { d, a, b } = await world();
  await insertThreaded(d, a, "xa", "t-cross", { receivedAt: 10 });
  await insertThreaded(d, b, "xb", "t-cross", { receivedAt: 20 });

  const rowsA = await listMessages(asD1(d), a, { view: "inbox" });
  const mine = rowsA.filter((r) => r.thread_id === "t-cross");
  assert.equal(mine.length, 1);
  assert.equal(mine[0].id, "xa", "A's representative is A's own row, not B's newer one");
  assert.equal(mine[0].thread_count, 1);
});

test("sent view groups only outbound copies of a thread", async () => {
  const { d, a } = await world();
  await insertThreaded(d, a, "in1", "t-mixed", { receivedAt: 10, direction: "in" });
  await insertThreaded(d, a, "out1", "t-mixed", { receivedAt: 20, direction: "out" });
  await insertThreaded(d, a, "out2", "t-mixed", { receivedAt: 30, direction: "out" });

  const sent = (await listMessages(asD1(d), a, { view: "sent" })).filter(
    (r) => r.thread_id === "t-mixed",
  );
  assert.equal(sent.length, 1);
  assert.equal(sent[0].thread_count, 2, "counts outbound only");

  const inbox = (await listMessages(asD1(d), a, { view: "inbox" })).filter(
    (r) => r.thread_id === "t-mixed",
  );
  assert.equal(inbox[0].thread_count, 1, "counts inbound only");
});

test("markRead clears every copy in the thread, and only that user's", async () => {
  const { d, a, b } = await world();
  await insertThreaded(d, a, "r1", "t-read", { receivedAt: 10, isRead: 0 });
  await insertThreaded(d, a, "r2", "t-read", { receivedAt: 20, isRead: 0 });
  await insertThreaded(d, b, "rb", "t-read", { receivedAt: 30, isRead: 0 });

  await markRead(asD1(d), a, "r1", true);
  const readA = d.query(`SELECT id, is_read FROM messages WHERE thread_id = 't-read'`);
  assert.deepEqual(
    Object.fromEntries(readA.map((r: any) => [r.id, r.is_read])),
    { r1: 1, r2: 1, rb: 0 },
  );
});

test("byThread flag archives all copies; without it only the named id", async () => {
  const { d, a } = await world();
  await insertThreaded(d, a, "f1", "t-flag", { receivedAt: 10 });
  await insertThreaded(d, a, "f2", "t-flag", { receivedAt: 20 });

  await setFlag(asD1(d), a, ["f2"], "is_starred", 1);
  let rows = d.query(`SELECT id, is_starred FROM messages WHERE thread_id = 't-flag'`);
  assert.deepEqual(
    Object.fromEntries(rows.map((r: any) => [r.id, r.is_starred])),
    { f1: 0, f2: 1 },
    "per-message without byThread",
  );

  await setFlag(asD1(d), a, ["f2"], "is_archived", 1, { byThread: true });
  rows = d.query(`SELECT id, is_archived FROM messages WHERE thread_id = 't-flag'`);
  assert.deepEqual(
    Object.fromEntries(rows.map((r: any) => [r.id, r.is_archived])),
    { f1: 1, f2: 1 },
    "whole thread with byThread",
  );
  const inbox = (await listMessages(asD1(d), a, { view: "inbox" })).filter(
    (r) => r.thread_id === "t-flag",
  );
  assert.equal(inbox.length, 0, "archived thread does not resurface");
});

test("view counts are per-thread, not per-message", async () => {
  const { d, a } = await world();
  const before = await getViewCounts(asD1(d), a);
  await insertThreaded(d, a, "v1", "t-count", { receivedAt: 10, isRead: 0 });
  await insertThreaded(d, a, "v2", "t-count", { receivedAt: 20, isRead: 0 });

  const after = await getViewCounts(asD1(d), a);
  assert.equal(after.inbox, before.inbox + 1, "two copies count as one inbox thread");
  assert.equal(after.unread, before.unread + 1);
});
