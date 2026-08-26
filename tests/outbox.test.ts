import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDb, asD1, type FakeD1 } from "./fakes/d1.ts";
import { fakeEnv, stubFetch } from "./fakes/env.ts";
import { invalidateConfigCache, setConfig } from "../apps/api/src/config/index.ts";
import { upsertDomain } from "../apps/api/src/config/domains.ts";
import { setSecret } from "../apps/api/src/config/secrets.ts";
import { duePending, flushPending } from "../apps/api/src/send/outbox.ts";
import { runScheduled } from "../apps/api/src/scheduled.ts";
import type { SendError } from "../apps/api/src/send/types.ts";

type Pending = { id: string; send_state: string | null; send_error: string | null };

async function seed(over: Partial<Record<string, unknown>> = {}): Promise<FakeD1> {
  invalidateConfigCache();
  const d = freshDb();
  await setConfig(asD1(d), { "send.provider": "cloudflare" });
  await upsertDomain(asD1(d), "example.com", { is_primary: 1 });

  const row = {
    id: "m1",
    to_addr: "you@elsewhere.com, second@elsewhere.com",
    cc: "cc@x.com",
    bcc: null,
    from_addr: "me@example.com",
    subject: "Scheduled",
    text: "body",
    send_after: 1,
    send_state: "pending",
    ...over,
  } as Record<string, unknown>;

  await asD1(d)
    .prepare(
      `INSERT INTO messages (id, direction, from_addr, to_addr, cc, bcc, subject, text, received_at, send_after, send_state)
         VALUES (?, 'out', ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    )
    .bind(
      row.id,
      row.from_addr,
      row.to_addr,
      row.cc,
      row.bcc,
      row.subject,
      row.text,
      row.send_after,
      row.send_state,
    )
    .run();
  return d;
}

const state = (d: FakeD1, id = "m1") =>
  d.query<Pending>(`SELECT id, send_state, send_error FROM messages WHERE id = ?`, id)[0];

test("a successful flush sends once and marks the row sent", async () => {
  const d = await seed();
  const env = fakeEnv(d);

  const res = await flushPending(env as never, "m1");
  assert.equal(res.provider, "cloudflare");
  assert.equal(env.EMAIL.sent.length, 1);

  const sent = env.EMAIL.sent[0];
  assert.deepEqual(sent.to, ["you@elsewhere.com", "second@elsewhere.com"]);
  assert.deepEqual(sent.cc, ["cc@x.com"]);
  assert.equal(sent.bcc, undefined, "an empty bcc must not be sent as an empty list");

  assert.equal(state(d).send_state, "sent");
  assert.equal(state(d).send_error, null);
  d.close();
});

test("a retryable failure goes back to pending, with no error recorded", async () => {
  const d = await seed();
  const env = fakeEnv(d);
  env.EMAIL.fail = Object.assign(new Error("E_RATE_LIMIT_EXCEEDED"), {
    code: "E_RATE_LIMIT_EXCEEDED",
  });

  await assert.rejects(() => flushPending(env as never, "m1"));
  assert.equal(state(d).send_state, "pending");
  assert.equal(state(d).send_error, null);
  d.close();
});

test("a permanent failure lands in 'failed' instead of retrying forever", async () => {
  // The old behaviour reverted to 'pending' on ANY error, so a rejected message
  // was resent every minute by the cron and displayed as merely waiting.
  const d = await seed();
  const env = fakeEnv(d);
  env.EMAIL.fail = Object.assign(new Error("E_RECIPIENT_NOT_ALLOWED"), {
    code: "E_RECIPIENT_NOT_ALLOWED",
  });

  await assert.rejects(
    () => flushPending(env as never, "m1"),
    (err: SendError) => err.code === "recipient_not_allowed",
  );

  assert.equal(state(d).send_state, "failed");
  assert.match(state(d).send_error!, /E_RECIPIENT_NOT_ALLOWED/);

  // And the cron leaves it alone from then on.
  assert.deepEqual(await duePending(env as never, 10), []);
  await runScheduled(env as never);
  assert.equal(env.EMAIL.sent.length, 0);
  d.close();
});

test("a claimed message is not sent twice", async () => {
  const d = await seed();
  const env = fakeEnv(d);

  const [a, b] = await Promise.allSettled([
    flushPending(env as never, "m1"),
    flushPending(env as never, "m1"),
  ]);
  const outcomes = [a.status, b.status].sort();
  assert.deepEqual(outcomes, ["fulfilled", "rejected"]);
  assert.equal(env.EMAIL.sent.length, 1, "exactly one delivery");

  const loser = (a.status === "rejected" ? a.reason : (b as PromiseRejectedResult).reason) as SendError;
  assert.equal(loser.code, "already_sending");
  d.close();
});

test("duePending only returns elapsed, undeleted, still-pending rows", async () => {
  const d = await seed({ send_after: 5_000 });
  const env = fakeEnv(d);

  assert.deepEqual(await duePending(env as never, 1_000), [], "not yet due");
  assert.deepEqual(await duePending(env as never, 10_000), ["m1"]);

  d.exec(`UPDATE messages SET is_deleted = 1 WHERE id = 'm1'`);
  assert.deepEqual(await duePending(env as never, 10_000), [], "a trashed message must not send");
  d.close();
});

test("the cron flushes what is due and swallows the failure", async () => {
  const d = await seed();
  const env = fakeEnv(d);
  await runScheduled(env as never);
  assert.equal(state(d).send_state, "sent");

  const d2 = await seed();
  const env2 = fakeEnv(d2);
  env2.EMAIL.fail = Object.assign(new Error("E_SENDER_NOT_VERIFIED"), {
    code: "E_SENDER_NOT_VERIFIED",
  });
  // A failing message must not take the whole tick down with it.
  await runScheduled(env2 as never);
  assert.equal(state(d2).send_state, "failed");
  d.close();
  d2.close();
});

test("stored attachments are pulled back from R2 and attached", async () => {
  const d = await seed();
  const env = fakeEnv(d);
  env.EMAIL_CACHE.put("uploads/a.txt", "attached bytes");

  await asD1(d)
    .prepare(
      `INSERT INTO attachments (id, message_id, filename, mime_type, r2_key, size_bytes)
         VALUES ('a1', 'm1', 'a.txt', 'text/plain', 'uploads/a.txt', 14)`,
    )
    .run();

  await flushPending(env as never, "m1");
  const atts = env.EMAIL.sent[0].attachments as Array<Record<string, unknown>>;
  assert.equal(atts.length, 1);
  assert.equal(atts[0].filename, "a.txt");
  assert.equal(new TextDecoder().decode(atts[0].content as ArrayBuffer), "attached bytes");
  d.close();
});

test("an attachment whose blob is gone is skipped, not fatal", async () => {
  // Losing one attachment is better than losing the message.
  const d = await seed();
  const env = fakeEnv(d);
  await asD1(d)
    .prepare(
      `INSERT INTO attachments (id, message_id, filename, mime_type, r2_key, size_bytes)
         VALUES ('a1', 'm1', 'gone.txt', 'text/plain', 'uploads/gone.txt', 1)`,
    )
    .run();

  await flushPending(env as never, "m1");
  assert.equal(state(d).send_state, "sent");
  assert.equal(env.EMAIL.sent[0].attachments, undefined);
  d.close();
});

test("the row id reaches the provider as an idempotency key", async () => {
  // A retry after a timeout reuses it, so the provider recognises the duplicate
  // instead of delivering twice. Asserted through Resend, which is the provider
  // that actually transmits the key.
  const d = await seed();
  const env = fakeEnv(d);
  await upsertDomain(asD1(d), "example.com", { is_primary: 1, send_provider: "resend" });
  await setSecret(asD1(d), env, "resend.api_key", "re_key");

  const { calls, restore } = stubFetch([
    { match: (u) => u.endsWith("/emails"), respond: () => ({ body: { id: "re-1" } }) },
  ]);
  try {
    await flushPending(env as never, "m1");
    assert.equal(calls[0].headers["Idempotency-Key"], "m1");
  } finally {
    restore();
  }
  d.close();
});
