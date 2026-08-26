import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDb, asD1 } from "./fakes/d1.ts";
import {
  loadConfig,
  setConfig,
  getConfig,
  claimInstance,
  isClaimed,
  invalidateConfigCache,
} from "../apps/api/src/config/index.ts";
import { decode, defaults, CONFIG_KEYS } from "../apps/api/src/config/schema.ts";
import {
  setSecret,
  getSecret,
  secretStatus,
  hasSecret,
  deleteSecret,
  mask,
  reveal,
} from "../apps/api/src/config/secrets.ts";
import {
  upsertDomain,
  getDomain,
  listDomains,
  loadPolicies,
  recordDns,
  listDns,
  recordUnrouted,
} from "../apps/api/src/config/domains.ts";

const db = () => {
  invalidateConfigCache();
  return freshDb();
};

test("every key falls back to its registered default", async () => {
  const d = db();
  const cfg = await loadConfig(asD1(d));
  assert.deepEqual(cfg, defaults());
  // Exhaustive rather than spot-checked: a new key with a bad default fails here.
  for (const key of CONFIG_KEYS) assert.ok(key in cfg, key);
  d.close();
});

test("booleans, ints and lists coerce, and garbage falls back", async () => {
  assert.equal(decode("mail.compose_enabled", "1"), true);
  assert.equal(decode("mail.compose_enabled", "true"), true);
  assert.equal(decode("mail.compose_enabled", "0"), false);
  assert.equal(decode("mail.compose_enabled", ""), false);
  assert.equal(decode("mail.compose_enabled", "garbage"), false);

  assert.equal(decode("instance.claimed_at", "1700000000000"), 1700000000000);
  assert.equal(decode("instance.claimed_at", "not-a-number"), null);

  assert.deepEqual(decode("ui.image_allowlist", '["a@b.com"]'), ["a@b.com"]);
  // Malformed JSON must not take the instance down.
  assert.deepEqual(decode("ui.image_allowlist", "{not json"), []);
  // Nor must a well-formed value of the wrong shape.
  assert.deepEqual(decode("ui.image_allowlist", '"a string"'), []);
  assert.deepEqual(decode("ui.image_allowlist", '[1, "ok", null]'), ["ok"]);
});

test("setConfig upserts and round-trips through the declared type", async () => {
  const d = db();
  await setConfig(asD1(d), {
    "mail.reply_enabled": true,
    "ui.image_allowlist": ["a@b.com", "c@d.com"],
    "instance.claimed_at": 42,
    "ai.model": "claude-opus-5",
  });

  const cfg = await loadConfig(asD1(d), { fresh: true });
  assert.equal(cfg["mail.reply_enabled"], true);
  assert.deepEqual(cfg["ui.image_allowlist"], ["a@b.com", "c@d.com"]);
  assert.equal(cfg["instance.claimed_at"], 42);
  assert.equal(cfg["ai.model"], "claude-opus-5");

  await setConfig(asD1(d), { "mail.reply_enabled": false });
  assert.equal(await getConfig(asD1(d), "mail.reply_enabled"), false);
  d.close();
});

test("an unknown config key is rejected at both boundaries", async () => {
  const d = db();
  // Compile-time: tsc fails the build if this key were actually valid, so the
  // registry really is the only source of keys.
  // @ts-expect-error — not a registered config key.
  await assert.rejects(() => setConfig(asD1(d), { "nope.not.a.key": "x" }), /Unknown config key/);
  // Runtime: a hand-written key arriving in a request body says so, rather than
  // failing later with a TypeError on undefined.
  await assert.rejects(
    () => setConfig(asD1(d), { "also.bogus": 1 } as never),
    /Unknown config key/,
  );
  d.close();
});

test("claiming is atomic: exactly one concurrent caller wins", async () => {
  const d = db();
  assert.equal(await isClaimed(asD1(d)), false);

  const results = await Promise.all([
    claimInstance(asD1(d), 1),
    claimInstance(asD1(d), 2),
    claimInstance(asD1(d), 3),
  ]);
  assert.equal(results.filter(Boolean).length, 1, "exactly one claim may succeed");
  assert.equal(await isClaimed(asD1(d)), true);

  // And a later claim never reopens it.
  assert.equal(await claimInstance(asD1(d), 4), false);
  d.close();
});

test("secrets round-trip, mask safely, and never appear in the read model", async () => {
  const d = db();
  const env = {};
  const KEY = "re_abcdefghijklmnop_9f8e7d";

  await setSecret(asD1(d), env, "resend.api_key", KEY);
  assert.equal(reveal((await getSecret(asD1(d), env, "resend.api_key"))!), KEY);
  assert.equal(await hasSecret(asD1(d), "resend.api_key"), true);

  const status = await secretStatus(asD1(d), ["resend.api_key", "cf.token"]);
  // The one assertion that actually enforces "never serialize a secret": scan the
  // serialized read model for the plaintext rather than trusting the shape.
  assert.ok(!JSON.stringify(status).includes(KEY), "read model leaked the secret");
  assert.equal(status[0].present, true);
  assert.equal(status[0].masked, `${KEY.slice(0, 4)}\u2026${KEY.slice(-4)}`);
  assert.equal(status[1].present, false);

  await deleteSecret(asD1(d), "resend.api_key");
  assert.equal(await getSecret(asD1(d), env, "resend.api_key"), null);
  d.close();
});

test("mask keeps a short secret unreadable", () => {
  assert.equal(mask("abc"), "••••");
  assert.equal(mask("abcdefghij"), "abcd…ghij");
});

test("the session secret is write-once unless forced", async () => {
  const d = db();
  const env = {};
  await setSecret(asD1(d), env, "auth.session_secret", "first-secret-value");
  await setSecret(asD1(d), env, "auth.session_secret", "second-secret-value");
  assert.equal(
    reveal((await getSecret(asD1(d), env, "auth.session_secret"))!),
    "first-secret-value",
    "re-running setup must not sign everyone out",
  );

  await setSecret(asD1(d), env, "auth.session_secret", "rotated-value", { force: true });
  assert.equal(reveal((await getSecret(asD1(d), env, "auth.session_secret"))!), "rotated-value");
  d.close();
});

test("CONFIG_ENC_KEY wraps at rest and unwraps transparently", async () => {
  const d = db();
  const env = { CONFIG_ENC_KEY: "a-key-that-lives-outside-d1" };
  await setSecret(asD1(d), env, "cf.token", "cf-token-plaintext");

  const stored = d.query<{ value: string }>(`SELECT value FROM secrets WHERE key='cf.token'`)[0];
  assert.ok(stored.value.startsWith("enc:v1:"), "value should be wrapped on disk");
  assert.ok(!stored.value.includes("cf-token-plaintext"));

  assert.equal(reveal((await getSecret(asD1(d), env, "cf.token"))!), "cf-token-plaintext");

  // Losing the key must fail loudly. Returning ciphertext as if it were a token
  // would surface as a baffling "invalid API key" from Cloudflare.
  await assert.rejects(() => getSecret(asD1(d), {}, "cf.token"), /CONFIG_ENC_KEY is not set/);
  d.close();
});

test("an empty secret is refused", async () => {
  const d = db();
  await assert.rejects(() => setSecret(asD1(d), {}, "cf.token", "   "), /empty secret/);
  d.close();
});

test("domains upsert, and only one may be primary", async () => {
  const d = db();
  await upsertDomain(asD1(d), "Example.COM", { is_primary: 1, zone_id: "z1" });
  await upsertDomain(asD1(d), "alt.com", { is_primary: 1, zone_id: "z2" });

  const rows = await listDomains(asD1(d));
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.filter((r) => r.is_primary === 1).map((r) => r.domain),
    ["alt.com"],
    "the incumbent primary must be demoted, not collide",
  );

  const ex = await getDomain(asD1(d), "example.com");
  assert.equal(ex?.zone_id, "z1");
  assert.equal(ex?.routing_state, "none");
  assert.equal(ex?.accept_all, 1);
  d.close();
});

test("a disabled domain drops out of the receive policy", async () => {
  const d = db();
  await upsertDomain(asD1(d), "on.com", {});
  await upsertDomain(asD1(d), "off.com", { receive_enabled: 0 });
  const policies = await loadPolicies(asD1(d));
  assert.deepEqual(
    policies.map((p) => p.domain),
    ["on.com"],
  );
  d.close();
});

test("invalid enum values are rejected by the schema, not by code", async () => {
  const d = db();
  await upsertDomain(asD1(d), "example.com", {});
  assert.throws(
    () => d.exec(`UPDATE domains SET routing_state = 'bogus' WHERE domain='example.com'`),
    /CHECK constraint/,
  );
  d.close();
});

test("dns snapshots upsert per record and cascade with their domain", async () => {
  const d = db();
  await upsertDomain(asD1(d), "example.com", {});
  await recordDns(asD1(d), "example.com", "routing", [
    { type: "MX", name: "example.com", content: "route1.mx.cloudflare.net", priority: 1 },
    { type: "TXT", name: "example.com", content: "v=spf1 include:_spf.mx.cloudflare.net ~all" },
  ]);
  await recordDns(asD1(d), "example.com", "routing", [
    { type: "MX", name: "example.com", content: "route1.mx.cloudflare.net", priority: 1, status: "live" },
  ]);

  const rows = await listDns(asD1(d), "example.com", "routing");
  assert.equal(rows.length, 2, "the same record must update, not duplicate");
  assert.equal(rows.find((r) => r.type === "MX")?.status, "live");

  d.exec(`DELETE FROM domains WHERE domain='example.com'`);
  assert.equal((await listDns(asD1(d), "example.com")).length, 0);
  d.close();
});

test("unrouted mail is recorded with its reason", async () => {
  const d = db();
  await recordUnrouted(asD1(d), {
    address: "nobody@example.com",
    from_addr: "sender@elsewhere.com",
    subject: "hi",
    reason: "no_owner",
  });
  const rows = d.query<{ address: string; reason: string }>(`SELECT * FROM unrouted`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].reason, "no_owner");
  d.close();
});
