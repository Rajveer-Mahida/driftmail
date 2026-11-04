// Replies land in their conversation, including replies to our own replies.
import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDb, asD1 } from "./fakes/d1.ts";
import { createFirstAdmin, suggestHandle } from "../apps/api/src/users.ts";
import {
  baseSubject,
  messageIdsIn,
  referencesFor,
  resolveThreadId,
  rfcMessageId,
} from "../apps/api/src/db.ts";
import { asUserId, type MessageRow } from "../packages/shared/src/index.ts";

const PW = "a-long-enough-password";

async function setup() {
  const d = freshDb();
  const admin = await createFirstAdmin(asD1(d), { email: "hello@example.com", handle: "hello", password: PW });
  const owner = asUserId(admin.id);
  const now = Date.now();
  // Gmail → us: the conversation's first message.
  d.exec(`INSERT INTO messages (id, user_id, message_id, thread_id, direction, from_addr, to_addr, subject, text, received_at)
          VALUES ('m1', '${admin.id}', '<root@mail.gmail.com>', '<root@mail.gmail.com>', 'in',
                  'friend@gmail.com', 'hello@example.com', 'fdfs', 'fsfs', ${now - 60_000})`);
  // Us → Gmail: sent through a provider that chose its own Message-ID, so we never stored one.
  d.exec(`INSERT INTO messages (id, user_id, message_id, in_reply_to, thread_id, direction, from_addr, to_addr, subject, text, received_at)
          VALUES ('m2', '${admin.id}', NULL, '<root@mail.gmail.com>', '<root@mail.gmail.com>', 'out',
                  'hello@example.com', 'friend@gmail.com', 'Re: fdfs', 'dadad', ${now - 30_000})`);
  return { d, owner, now };
}

test("a reply to our reply joins the conversation through References", async () => {
  const { d, owner, now } = await setup();
  const thread = await resolveThreadId(asD1(d), owner, {
    messageId: "<reply2@mail.gmail.com>",
    inReplyTo: "<0100abc@email.amazonses.com>",
    references: "<root@mail.gmail.com> <0100abc@email.amazonses.com>",
    subject: "Re: fdfs",
    fromAddr: "friend@gmail.com",
    fallbackId: "m3",
    now,
  });
  assert.equal(thread, "<root@mail.gmail.com>");
  d.close();
});

test("with no usable headers, a Re: subject from the same person still threads", async () => {
  const { d, owner, now } = await setup();
  const r = (subject: string, fromAddr = "friend@gmail.com") =>
    resolveThreadId(asD1(d), owner, {
      messageId: "<x@y>",
      inReplyTo: "<unknown@elsewhere>",
      subject,
      fromAddr,
      fallbackId: "m3",
      now,
    });
  assert.equal(await r("Re: fdfs"), "<root@mail.gmail.com>");
  assert.equal(await r("RE: Fwd: FDFS"), "<root@mail.gmail.com>");
  assert.equal(await r("fdfs"), "<x@y>", "no reply prefix: a new conversation");
  assert.equal(await r("Re: fdfs", "stranger@other.com"), "<x@y>", "someone else's Re: is not ours");
  assert.equal(await r("Re: something else"), "<x@y>");
  d.close();
});

test("a brand new message starts its own conversation", async () => {
  const { d, owner, now } = await setup();
  assert.equal(
    await resolveThreadId(asD1(d), owner, { messageId: "<new@a>", subject: "Hi", fromAddr: "a@b.com", fallbackId: "m9", now }),
    "<new@a>",
  );
  assert.equal(
    await resolveThreadId(asD1(d), owner, { subject: "Hi", fromAddr: "a@b.com", fallbackId: "m9", now }),
    "m9",
  );
  d.close();
});

test("References for a reply carry the whole chain", () => {
  const parent = {
    thread_id: "<root@a>",
    in_reply_to: "<mid@a>",
    message_id: "<parent@a>",
  } as MessageRow;
  assert.deepEqual(referencesFor(parent), ["<root@a>", "<mid@a>", "<parent@a>"]);
  assert.deepEqual(referencesFor({ thread_id: "m1", in_reply_to: null, message_id: "<p@a>" } as MessageRow), ["<p@a>"]);
  assert.deepEqual(referencesFor(null), []);
  assert.deepEqual(messageIdsIn("<a@b> <c@d>", "<a@b>"), ["<a@b>", "<c@d>"]);
});

test("helpers: subjects, provider ids, handles", () => {
  assert.equal(baseSubject("Re: Fwd:  Hello   World"), "hello world");
  assert.equal(rfcMessageId("abc@host"), "<abc@host>");
  assert.equal(rfcMessageId("<abc@host>"), "<abc@host>");
  assert.equal(rfcMessageId("4ef9a417-02e9-4d39-ad75-9611e0fcc33c"), null, "Resend's API id");
  assert.equal(suggestHandle("rajveer.mahida"), "rajveer_mahida");
  assert.equal(suggestHandle("Rajveer-Mahida+x"), "rajveer_mahida_x");
  assert.equal(suggestHandle(".a."), "a");
});
