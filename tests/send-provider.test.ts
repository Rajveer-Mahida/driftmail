import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDb, asD1 } from "./fakes/d1.ts";
import { fakeEnv, stubFetch } from "./fakes/env.ts";
import { invalidateConfigCache, setConfig } from "../apps/api/src/config/index.ts";
import { setSecret } from "../apps/api/src/config/secrets.ts";
import { upsertDomain } from "../apps/api/src/config/domains.ts";
import { resolveProvider, sendMail } from "../apps/api/src/send/index.ts";
import { resendProvider } from "../apps/api/src/send/providers/resend.ts";
import { cloudflareProvider } from "../apps/api/src/send/providers/cloudflare.ts";
import { SendError, type OutboundMessage } from "../apps/api/src/send/types.ts";

const db = () => {
  invalidateConfigCache();
  return freshDb();
};

const msg = (over: Partial<OutboundMessage> = {}): OutboundMessage => ({
  from: "me@example.com",
  to: ["you@elsewhere.com"],
  subject: "Hi",
  text: "body",
  ...over,
});

const resendOk = () => [
  { match: (u: string) => u.endsWith("/emails"), respond: () => ({ body: { id: "re-123" } }) },
];

// ── resolution ───────────────────────────────────────────────────────────────

test("a domain's own provider beats the instance default", async () => {
  const d = db();
  const env = fakeEnv(d);
  await setConfig(asD1(d), { "send.provider": "cloudflare" });
  await upsertDomain(asD1(d), "example.com", { send_provider: "resend" });
  await upsertDomain(asD1(d), "other.com", {});
  await setSecret(asD1(d), env, "resend.api_key", "re_test_key");

  assert.equal((await resolveProvider(env as never, "me@example.com")).name, "resend");
  assert.equal((await resolveProvider(env as never, "me@other.com")).name, "cloudflare");
  d.close();
});

test("an unknown sending domain falls back to the instance default", async () => {
  const d = db();
  const env = fakeEnv(d);
  await setConfig(asD1(d), { "send.provider": "cloudflare" });
  assert.equal((await resolveProvider(env as never, "me@nowhere.com")).name, "cloudflare");
  d.close();
});

test("a glob domain resolves the same way inbound matching does", async () => {
  const d = db();
  const env = fakeEnv(d);
  await upsertDomain(asD1(d), "*", { send_provider: "cloudflare" });
  assert.equal((await resolveProvider(env as never, "me@anything.test")).name, "cloudflare");
  d.close();
});

test("with nothing configured, sending fails loudly rather than silently", async () => {
  const d = db();
  const env = fakeEnv(d);
  const provider = await resolveProvider(env as never, "me@example.com");
  assert.equal(provider.name, "none");
  await assert.rejects(
    () => sendMail(env as never, msg()),
    (err: SendError) => {
      assert.equal(err.code, "not_configured");
      assert.equal(err.retryable, false);
      assert.match(err.hint!, /Settings/);
      return true;
    },
  );
  d.close();
});

test("choosing Resend without a key is a configuration error, not a 500", async () => {
  const d = db();
  const env = fakeEnv(d);
  await setConfig(asD1(d), { "send.provider": "resend" });
  await assert.rejects(
    () => resolveProvider(env as never, "me@example.com"),
    (err: SendError) => err.code === "not_configured",
  );
  d.close();
});

// ── Resend payload ───────────────────────────────────────────────────────────

test("the Resend body uses snake_case reply_to and bare base64 attachments", async () => {
  const { calls, restore } = stubFetch(resendOk());
  try {
    const res = await resendProvider("re_key").send(
      msg({
        from: { email: "me@example.com", name: "Me" },
        cc: ["cc@x.com"],
        bcc: ["bcc@x.com"],
        replyTo: "reply@example.com",
        html: "<p>hi</p>",
        inReplyTo: "<parent@x.com>",
        references: ["<a@x.com>", "<b@x.com>"],
        idempotencyKey: "msg-1",
        attachments: [
          {
            content: new TextEncoder().encode("hello").buffer,
            filename: "a.txt",
            type: "text/plain",
          },
        ],
      }),
    );
    assert.deepEqual(res, { messageId: "re-123", provider: "resend" });

    const call = calls[0];
    assert.equal(call.url, "https://api.resend.com/emails");
    assert.equal(call.method, "POST");
    assert.equal(call.headers.authorization, "Bearer re_key");
    assert.equal(call.headers["Idempotency-Key"], "msg-1");

    const body = call.body as Record<string, unknown>;
    assert.equal(body.from, "Me <me@example.com>");
    assert.deepEqual(body.to, ["you@elsewhere.com"]);
    // camelCase replyTo is accepted by the API and then silently ignored.
    assert.equal(body.reply_to, "reply@example.com");
    assert.ok(!("replyTo" in body));
    assert.deepEqual(body.headers, {
      "In-Reply-To": "<parent@x.com>",
      References: "<a@x.com> <b@x.com>",
    });

    const att = (body.attachments as Record<string, unknown>[])[0];
    assert.equal(att.content, Buffer.from("hello").toString("base64"));
    assert.ok(!String(att.content).startsWith("data:"), "a data: URI delivers as corrupt bytes");
    assert.equal(att.content_type, "text/plain");
  } finally {
    restore();
  }
});

test("caller-supplied threading headers are not overwritten", async () => {
  const { calls, restore } = stubFetch(resendOk());
  try {
    await resendProvider("re_key").send(
      msg({ headers: { "In-Reply-To": "<explicit@x.com>" }, inReplyTo: "<derived@x.com>" }),
    );
    const body = calls[0].body as { headers: Record<string, string> };
    assert.equal(body.headers["In-Reply-To"], "<explicit@x.com>");
  } finally {
    restore();
  }
});

// ── Resend errors ────────────────────────────────────────────────────────────

const resendFails = (status: number, message: string) => [
  {
    match: (u: string) => u.endsWith("/emails"),
    respond: () => ({ status, body: { statusCode: status, message } }),
  },
];

test("Resend 429 is retryable, 422 is not", async () => {
  for (const [status, retryable] of [
    [429, true],
    [422, false],
    [400, false],
    [503, true],
  ] as const) {
    const { restore } = stubFetch(resendFails(status, "nope"));
    try {
      await assert.rejects(
        () => resendProvider("re_key").send(msg()),
        (err: SendError) => {
          assert.equal(err.retryable, retryable, `status ${status}`);
          assert.equal(err.status, status);
          return true;
        },
      );
    } finally {
      restore();
    }
  }
});

test("a rejected Resend key says to replace the key, not to fix DNS", async () => {
  const { restore } = stubFetch(resendFails(401, "API key is invalid"));
  try {
    await assert.rejects(
      () => resendProvider("re_key").send(msg()),
      (err: SendError) => {
        assert.equal(err.code, "provider_error");
        assert.match(err.hint!, /API key/);
        return true;
      },
    );
  } finally {
    restore();
  }
});

test("a Resend 403 naming the domain is a verification problem", async () => {
  const { restore } = stubFetch(resendFails(403, "The example.com domain is not verified"));
  try {
    await assert.rejects(
      () => resendProvider("re_key").send(msg()),
      (err: SendError) => {
        assert.equal(err.code, "sender_not_verified");
        assert.match(err.hint!, /DNS/);
        return true;
      },
    );
  } finally {
    restore();
  }
});

test("oversized attachments throw before fetch is ever called", async () => {
  // The point is not allocating: base64 in a JS string costs ~2.7x the bytes
  // against a Worker's 128 MB budget, so the check must precede the encode.
  const { calls, restore } = stubFetch(resendOk());
  try {
    await assert.rejects(
      () =>
        resendProvider("re_key").send(
          msg({
            attachments: [
              {
                content: new ArrayBuffer(21 * 1024 * 1024),
                filename: "big.bin",
              },
            ],
          }),
        ),
      (err: SendError) => err.code === "too_large",
    );
    assert.equal(calls.length, 0, "no request should have been attempted");
  } finally {
    restore();
  }
});

test("too many recipients is caught before dispatch", async () => {
  const { calls, restore } = stubFetch(resendOk());
  try {
    const many = Array.from({ length: 51 }, (_, i) => `p${i}@x.com`);
    await assert.rejects(
      () => resendProvider("re_key").send(msg({ to: many })),
      (err: SendError) => err.code === "too_many_recipients",
    );
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});

// ── Cloudflare error mapping ─────────────────────────────────────────────────

async function cfFailure(code: string) {
  const env = fakeEnv(freshDb());
  env.EMAIL.fail = Object.assign(new Error(code), { code });
  try {
    await cloudflareProvider(env.EMAIL as never).send(msg());
    assert.fail("should have thrown");
  } catch (err) {
    return err as SendError;
  }
}

test("the unverified-destination failure names the actual fix", async () => {
  // This was the app's most common error and it explained nothing.
  const err = await cfFailure("E_RECIPIENT_NOT_ALLOWED");
  assert.equal(err.code, "recipient_not_allowed");
  assert.equal(err.retryable, false);
  assert.match(err.hint!, /Workers Paid/);
  assert.match(err.hint!, /Resend/);
});

test("Cloudflare error codes map to the right retry decision", async () => {
  assert.equal((await cfFailure("E_SENDER_NOT_VERIFIED")).code, "sender_not_verified");
  assert.equal((await cfFailure("E_SENDER_NOT_VERIFIED")).retryable, false);
  assert.equal((await cfFailure("E_TOO_MANY_RECIPIENTS")).code, "too_many_recipients");
  assert.equal((await cfFailure("E_CONTENT_TOO_LARGE")).code, "too_large");
  assert.equal((await cfFailure("E_RATE_LIMIT_EXCEEDED")).retryable, true);
  assert.equal((await cfFailure("E_DAILY_LIMIT_EXCEEDED")).retryable, true);
  // An unrecognised failure is assumed transient: dropping a message that could
  // have gone out is worse than retrying one that cannot.
  assert.equal((await cfFailure("E_SOMETHING_NEW")).retryable, true);
});

test("the Cloudflare provider forwards threading headers and a formatted from", async () => {
  const env = fakeEnv(freshDb());
  await cloudflareProvider(env.EMAIL as never).send(
    msg({ from: { email: "me@example.com", name: "Me" }, inReplyTo: "<p@x.com>" }),
  );
  const sent = env.EMAIL.sent[0];
  assert.equal(sent.from, "Me <me@example.com>");
  assert.deepEqual(sent.headers, { "In-Reply-To": "<p@x.com>" });
});
