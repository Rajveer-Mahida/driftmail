import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDb, asD1 } from "./fakes/d1.ts";
import { fakeEnv } from "./fakes/env.ts";
import {
  createSessionToken,
  verifySessionToken,
  ensureAuthSecret,
  authSecret,
  invalidateAuthSecretCache,
} from "../apps/api/src/auth.ts";
import { getSecret, reveal, setSecret } from "../apps/api/src/config/secrets.ts";

const SECRET = "0123456789abcdef0123456789abcdef";

const sign = (uid = "uabc", tv = 1, now = Date.now()) =>
  createSessionToken(SECRET, uid, tv, now);

test("a token round-trips its claims", async () => {
  const token = await sign("uabc", 7);
  const claims = await verifySessionToken(SECRET, token);
  assert.equal(claims?.uid, "uabc");
  assert.equal(claims?.tv, 7);
  assert.ok(claims!.exp > Date.now());
});

test("every rejection returns null, never a truthy value", async () => {
  const token = await sign("uabc", 1);
  const [v, uid, tv, exp, sig] = token.split(".");

  const bad: Array<[string, string]> = [
    ["no signing key at all", token],
    ["tampered user id", [v, "uevil", tv, exp, sig].join(".")],
    ["tampered token version", [v, uid, "99", exp, sig].join(".")],
    ["extended expiry", [v, uid, tv, String(Date.now() + 10 ** 12), sig].join(".")],
    ["forged signature", [v, uid, tv, exp, "AAAA"].join(".")],
    ["truncated", token.slice(0, -10)],
    ["garbage", "not-a-token"],
    ["empty", ""],
    // The pre-multi-user format. Rejecting it is what signs out every existing
    // session on deploy, which is intended.
    ["a v1 token", `${Date.now() + 100000}.somesignature`],
    ["a future version", [v.replace("v2", "v3"), uid, tv, exp, sig].join(".")],
  ];

  for (const [label, candidate] of bad) {
    const secret = label === "no signing key at all" ? null : SECRET;
    const result = await verifySessionToken(secret, candidate);
    assert.equal(result, null, label);
  }
});

test("a token signed with a different key does not verify", async () => {
  const token = await sign();
  assert.equal(await verifySessionToken("a-different-signing-key", token), null);
});

test("an expired token is refused", async () => {
  // Issued 31 days ago, against a 30-day lifetime.
  const token = await sign("uabc", 1, Date.now() - 31 * 24 * 60 * 60 * 1000);
  assert.equal(await verifySessionToken(SECRET, token), null);
});

test("the signing key is generated once and never silently rotated", async () => {
  // Rewriting it signs every device out, so re-running setup must not do it.
  const d = freshDb();
  const env = fakeEnv(d);
  invalidateAuthSecretCache();

  await ensureAuthSecret(env as never);
  const first = reveal((await getSecret(asD1(d), env, "auth.session_secret"))!);
  assert.match(first, /^[0-9a-f]{64}$/);

  await ensureAuthSecret(env as never);
  const second = reveal((await getSecret(asD1(d), env, "auth.session_secret"))!);
  assert.equal(second, first);
  d.close();
});

test("an unconfigured instance has no key, so nothing verifies", async () => {
  const d = freshDb();
  const env = fakeEnv(d);
  invalidateAuthSecretCache();

  assert.equal(await authSecret(env as never), null);
  // There is deliberately no fallback constant: one in a public repo would let
  // anyone forge a session against every deployment.
  assert.equal(await verifySessionToken(await authSecret(env as never), await sign()), null);
  d.close();
});

test("the key is read back through the cache", async () => {
  const d = freshDb();
  const env = fakeEnv(d);
  invalidateAuthSecretCache();

  await setSecret(asD1(d), env, "auth.session_secret", SECRET);
  assert.equal(await authSecret(env as never), SECRET);

  // Cached, so a direct database change is not picked up until it expires —
  // which is the tradeoff being made, and worth pinning down.
  await setSecret(asD1(d), env, "auth.session_secret", "rotated", { force: true });
  assert.equal(await authSecret(env as never), SECRET);

  invalidateAuthSecretCache();
  assert.equal(await authSecret(env as never), "rotated");
  d.close();
});
