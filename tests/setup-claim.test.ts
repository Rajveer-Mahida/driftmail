import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDb, asD1, type FakeD1 } from "./fakes/d1.ts";
import { fakeEnv, stubFetch } from "./fakes/env.ts";
import { invalidateConfigCache, isClaimed, markFirstSeen, setConfig } from "../apps/api/src/config/index.ts";
import { invalidateAuthSecretCache } from "../apps/api/src/auth.ts";
import { countUsers } from "../apps/api/src/users.ts";
import { identifyWorker } from "../apps/api/src/cloudflare.ts";

const PW = "a-long-enough-password";
const TOKEN = "cf-token-value";

const ok = (body: unknown) => ({ body: { success: true, result: body } });
const denied = (status = 403, code = 10000) => ({
  status,
  body: { success: false, errors: [{ code, message: "Authentication error" }] },
});

/** A Cloudflare account that owns `hostname` via a Worker custom domain. */
function customDomainAccount(hostname: string, service: string, account = "acct-1") {
  return [
    { match: (u: string) => u.endsWith("/accounts?per_page=50"), respond: () => ok([{ id: account, name: "Acme" }]) },
    {
      match: (u: string) => u.includes("/workers/domains?hostname="),
      respond: (u: string) =>
        u.includes(encodeURIComponent(hostname))
          ? ok([{ id: "d1", zone_id: "z1", zone_name: "example.com", hostname, service }])
          : ok([]),
    },
    { match: (u: string) => u.endsWith("/workers/subdomain"), respond: () => ok({ subdomain: "acme" }) },
  ];
}

// ── worker identification, which is also the ownership proof ─────────────────

test("a custom domain identifies the account and the script name", async () => {
  const { restore } = stubFetch(customDomainAccount("mail.example.com", "driftmail"));
  try {
    const id = await identifyWorker(TOKEN, "mail.example.com");
    assert.equal(id?.workerName, "driftmail");
    assert.equal(id?.source, "custom_domain");
    assert.equal(id?.accountId, "acct-1");
    // The serving zone comes free, and makes a sensible default at the next step.
    assert.equal(id?.zoneId, "z1");
  } finally {
    restore();
  }
});

test("a workers.dev hostname identifies the script by its label", async () => {
  const { restore } = stubFetch([
    { match: (u) => u.endsWith("/accounts?per_page=50"), respond: () => ok([{ id: "a1", name: "Acme" }]) },
    { match: (u) => u.includes("/workers/domains?"), respond: () => ok([]) },
    { match: (u) => u.endsWith("/workers/subdomain"), respond: () => ok({ subdomain: "acme" }) },
    {
      match: (u) => u.includes("/workers/scripts/driftmail"),
      respond: () => ok({ id: "driftmail" }),
    },
  ]);
  try {
    const id = await identifyWorker(TOKEN, "driftmail.acme.workers.dev");
    assert.equal(id?.workerName, "driftmail");
    assert.equal(id?.source, "workers_dev");
  } finally {
    restore();
  }
});

test("a version preview URL resolves to the real script, not the label", async () => {
  // Preview URLs are <prefix>-<script>.<subdomain>.workers.dev. Accepting
  // "abc123-driftmail" would point the catch-all at a Worker that does not
  // exist: Cloudflare would accept the mail and deliver it nowhere, silently.
  const { restore } = stubFetch([
    { match: (u) => u.endsWith("/accounts?per_page=50"), respond: () => ok([{ id: "a1", name: "Acme" }]) },
    { match: (u) => u.includes("/workers/domains?"), respond: () => ok([]) },
    { match: (u) => u.endsWith("/workers/subdomain"), respond: () => ok({ subdomain: "acme" }) },
    {
      match: (u) => u.includes("/workers/scripts/abc123-driftmail"),
      respond: () => ({ status: 404, body: { success: false, errors: [{ code: 10007, message: "not found" }] } }),
    },
    { match: (u) => u.includes("/workers/scripts/driftmail"), respond: () => ok({ id: "driftmail" }) },
  ]);
  try {
    const id = await identifyWorker(TOKEN, "abc123-driftmail.acme.workers.dev");
    assert.equal(id?.workerName, "driftmail");
  } finally {
    restore();
  }
});

test("an unverifiable name is refused rather than guessed", async () => {
  const { restore } = stubFetch([
    { match: (u) => u.endsWith("/accounts?per_page=50"), respond: () => ok([{ id: "a1", name: "Acme" }]) },
    { match: (u) => u.includes("/workers/domains?"), respond: () => ok([]) },
    { match: (u) => u.endsWith("/workers/subdomain"), respond: () => ok({ subdomain: "acme" }) },
    { match: (u) => u.includes("/workers/scripts/"), respond: () => ({ status: 404, body: { success: false } }) },
  ]);
  try {
    assert.equal(await identifyWorker(TOKEN, "mystery.acme.workers.dev"), null);
  } finally {
    restore();
  }
});

test("a token from another account cannot claim this Worker", async () => {
  const { restore } = stubFetch(customDomainAccount("someone-else.example.com", "theirs"));
  try {
    // The token is perfectly valid — just not for the account running this host.
    assert.equal(await identifyWorker(TOKEN, "mail.example.com"), null);
  } finally {
    restore();
  }
});

test("a zone-scoped token that cannot list accounts still identifies with an explicit id", async () => {
  // This branch is the difference between "works" and "works for me": a tightly
  // scoped token is refused GET /accounts.
  const { restore } = stubFetch([
    { match: (u) => u.endsWith("/accounts?per_page=50"), respond: () => denied(403, 10000) },
    {
      match: (u) => u.includes("/workers/domains?hostname="),
      respond: () => ok([{ id: "d1", zone_id: "z1", zone_name: "example.com", hostname: "mail.example.com", service: "driftmail" }]),
    },
    { match: (u) => u.endsWith("/workers/subdomain"), respond: () => ok({ subdomain: "acme" }) },
  ]);
  try {
    await assert.rejects(() => identifyWorker(TOKEN, "mail.example.com"));
    const id = await identifyWorker(TOKEN, "mail.example.com", ["acct-explicit"]);
    assert.equal(id?.workerName, "driftmail");
    assert.equal(id?.accountId, "acct-explicit");
  } finally {
    restore();
  }
});

// ── the claim itself ─────────────────────────────────────────────────────────

async function claimApp() {
  invalidateConfigCache();
  invalidateAuthSecretCache();
  const d = freshDb();
  const env = fakeEnv(d);
  const { default: app } = await import("../apps/api/src/index.ts");
  return { d, env, app };
}

const claimReq = (body: unknown, ip = "203.0.113.1") =>
  new Request("https://mail.example.com/api/setup/claim", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip },
    body: JSON.stringify(body),
  });

const ADMIN = { email: "rajveer@example.com", handle: "rajveer", password: PW };

test("an unclaimed instance answers only the setup endpoints", async () => {
  const { d, env, app } = await claimApp();
  const get = (path: string) =>
    app.fetch(new Request(`https://mail.example.com${path}`), env as never);

  assert.equal((await get("/api/messages")).status, 409, "must not 401 — that bounces to /login");
  assert.equal((await get("/api/counts")).status, 409);
  assert.equal((await get("/api/setup/status")).status, 200);
  assert.equal((await get("/api/health")).status, 200);

  const status = (await (await get("/api/setup/status")).json()) as Record<string, unknown>;
  // Nothing about the deployment leaks before it is claimed.
  assert.equal(status.claimed, false);
  assert.ok(!("email" in status));
  assert.ok(!("zones" in status));
  d.close();
});

test("a failed claim leaves the database byte-identical", async () => {
  const { d, env, app } = await claimApp();
  await markFirstSeen(asD1(d));
  // login_attempts is excluded on purpose: recording the failed attempt is the
  // rate limiter doing its job, and is the one write a rejected claim should make.
  const snap = () => d.snapshot(["login_attempts"]);
  const before = snap();

  const { restore } = stubFetch(customDomainAccount("someone-else.example.com", "theirs"));
  try {
    const res = await app.fetch(claimReq({ cfToken: TOKEN, ...ADMIN }), env as never);
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as { error: string }).error, "not_owner");
  } finally {
    restore();
  }

  assert.equal(snap(), before, "a rejected claim wrote something");
  assert.equal(await countUsers(asD1(d)), 0);
  assert.equal(await isClaimed(asD1(d)), false);
  d.close();
});

test("no proof at all is refused, and says how to provide one", async () => {
  const { d, env, app } = await claimApp();
  const res = await app.fetch(claimReq(ADMIN), env as never);
  assert.equal(res.status, 403);
  const body = (await res.json()) as { error: string; detail: string };
  assert.equal(body.error, "proof_required");
  assert.match(body.detail, /Cloudflare API token/);
  assert.match(body.detail, /SETUP_TOKEN/);
  assert.equal(await countUsers(asD1(d)), 0);
  d.close();
});

test("a valid claim creates exactly one admin and signs them in", async () => {
  const { d, env, app } = await claimApp();
  const { restore } = stubFetch(customDomainAccount("mail.example.com", "driftmail"));
  try {
    const res = await app.fetch(claimReq({ cfToken: TOKEN, ...ADMIN }), env as never);
    assert.equal(res.status, 200);

    const body = (await res.json()) as { worker: { name: string }; nextStep: string };
    assert.equal(body.worker.name, "driftmail");
    assert.equal(body.nextStep, "domain");
    assert.match(res.headers.get("set-cookie") ?? "", /dm_session=v2\./);

    assert.equal(await countUsers(asD1(d)), 1);
    const user = d.query<{ role: string; email: string }>(`SELECT role, email FROM users`)[0];
    assert.equal(user.role, "admin");
    assert.equal(user.email, "rajveer@example.com");

    // The token and a freshly generated signing key are both stored, and the
    // stored token is not the plaintext of anything the response returned.
    const secrets = d.query<{ key: string }>(`SELECT key FROM secrets ORDER BY key`);
    assert.deepEqual(secrets.map((s) => s.key), ["auth.session_secret", "cf.token"]);
  } finally {
    restore();
  }
  d.close();
});

test("only one of two concurrent claims can win", async () => {
  const { d, env, app } = await claimApp();
  const { restore } = stubFetch(customDomainAccount("mail.example.com", "driftmail"));
  try {
    const results = await Promise.all([
      app.fetch(claimReq({ cfToken: TOKEN, ...ADMIN }), env as never),
      app.fetch(
        claimReq({ cfToken: TOKEN, email: "evil@example.com", handle: "evil", password: PW }, "198.51.100.9"),
        env as never,
      ),
    ]);
    const statuses = results.map((r) => r.status).sort();
    assert.deepEqual(statuses, [200, 409]);
    assert.equal(await countUsers(asD1(d)), 1);
    // And the loser's account was never created.
    assert.equal(d.query(`SELECT 1 FROM users WHERE email = 'evil@example.com'`).length, 0);
  } finally {
    restore();
  }
  d.close();
});

test("a claimed instance cannot be re-claimed", async () => {
  const { d, env, app } = await claimApp();
  const { restore } = stubFetch(customDomainAccount("mail.example.com", "driftmail"));
  try {
    assert.equal((await app.fetch(claimReq({ cfToken: TOKEN, ...ADMIN }), env as never)).status, 200);
    const second = await app.fetch(
      claimReq({ cfToken: TOKEN, email: "b@example.com", handle: "bb", password: PW }, "198.51.100.9"),
      env as never,
    );
    assert.equal(second.status, 409);
    assert.equal(await countUsers(asD1(d)), 1);
  } finally {
    restore();
  }
  d.close();
});

test("weak credentials are rejected before any proof is even fetched", async () => {
  const { d, env, app } = await claimApp();
  const { calls, restore } = stubFetch(customDomainAccount("mail.example.com", "driftmail"));
  try {
    const res = await app.fetch(
      claimReq({ cfToken: TOKEN, email: "rajveer@example.com", handle: "rajveer", password: "short" }),
      env as never,
    );
    assert.equal(res.status, 400);
    assert.equal(calls.length, 0, "no Cloudflare call should have been made");
  } finally {
    restore();
  }
  d.close();
});

// ── the SETUP_TOKEN escape hatch ─────────────────────────────────────────────

test("SETUP_TOKEN claims work, and only with the right value", async () => {
  const { d, app } = await claimApp();
  const env = fakeEnv(d, { SETUP_TOKEN: "shared-setup-secret" });

  const wrong = await app.fetch(claimReq({ setupToken: "guess", ...ADMIN }), env as never);
  assert.equal(wrong.status, 403);
  assert.equal(await countUsers(asD1(d)), 0);

  const right = await app.fetch(
    claimReq({ setupToken: "shared-setup-secret", ...ADMIN }, "198.51.100.7"),
    env as never,
  );
  assert.equal(right.status, 200);
  // No Worker step any more: the fixed default name ("driftmail") is used.
  const rightBody = (await right.json()) as { nextStep: string; worker: { name: string } };
  assert.equal(rightBody.nextStep, "domain");
  assert.equal(rightBody.worker.name, "driftmail");
  d.close();
});

test("the SETUP_TOKEN path closes after a day, the token path does not", async () => {
  // An abandoned deployment must stop being claimable by a shared secret.
  const { d, app } = await claimApp();
  const env = fakeEnv(d, { SETUP_TOKEN: "shared-setup-secret" });
  await setConfig(asD1(d), { "instance.first_seen_at": Date.now() - 25 * 60 * 60 * 1000 });

  const late = await app.fetch(claimReq({ setupToken: "shared-setup-secret", ...ADMIN }), env as never);
  assert.equal(late.status, 403);
  assert.equal(((await late.json()) as { error: string }).error, "setup_token_expired");

  const { restore } = stubFetch(customDomainAccount("mail.example.com", "driftmail"));
  try {
    const viaToken = await app.fetch(
      claimReq({ cfToken: TOKEN, ...ADMIN }, "198.51.100.8"),
      env as never,
    );
    assert.equal(viaToken.status, 200, "a Cloudflare token is self-authenticating and never expires");
  } finally {
    restore();
  }
  d.close();
});

test("claim attempts are rate limited per client", async () => {
  const { d, app } = await claimApp();
  const env = fakeEnv(d, { SETUP_TOKEN: "shared-setup-secret" });

  for (let i = 0; i < 5; i++) {
    const res = await app.fetch(claimReq({ setupToken: "wrong", ...ADMIN }), env as never);
    assert.equal(res.status, 403, `attempt ${i + 1}`);
  }
  const blocked = await app.fetch(claimReq({ setupToken: "wrong", ...ADMIN }), env as never);
  assert.equal(blocked.status, 429);

  // A different client is unaffected.
  const other = await app.fetch(claimReq({ setupToken: "wrong", ...ADMIN }, "198.51.100.2"), env as never);
  assert.equal(other.status, 403);
  d.close();
});

// ── the local-development bypass ─────────────────────────────────────────────

/** A token that is valid, but owns no Worker serving this hostname. */
const validTokenElsewhere = () => [
  { match: (u: string) => u.endsWith("/accounts?per_page=50"), respond: () => ok([{ id: "acct-1", name: "Acme" }]) },
  { match: (u: string) => u.includes("/workers/domains?"), respond: () => ok([]) },
  { match: (u: string) => u.endsWith("/workers/subdomain"), respond: () => ok({ subdomain: "acme" }) },
];

const localClaimReq = (body: unknown) =>
  new Request("http://localhost:5173/api/setup/claim", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "127.0.0.1" },
    body: JSON.stringify(body),
  });

test("on localhost WITHOUT the opt-in, a Cloudflare token is still refused", async () => {
  // The hostname alone must never be enough: Host is client-controlled, so a
  // deployed Worker could be sent `Host: localhost`.
  const { d, env, app } = await claimApp();
  const { restore } = stubFetch(validTokenElsewhere());
  try {
    const res = await app.fetch(localClaimReq({ cfToken: TOKEN, ...ADMIN }), env as never);
    assert.equal(res.status, 403);
    const body = (await res.json()) as { error: string; detail: string };
    assert.equal(body.error, "not_owner");
    // …and the message points at the way out, rather than leaving you stuck.
    assert.match(body.detail, /DEV_UNSAFE_SKIP_OWNERSHIP/);
    assert.equal(await countUsers(asD1(d)), 0);
  } finally {
    restore();
  }
  d.close();
});

test("the opt-in alone does not help on a real hostname", async () => {
  // Set in production by mistake, it must still refuse a token that owns nothing.
  const { d, app } = await claimApp();
  const env = fakeEnv(d, { DEV_UNSAFE_SKIP_OWNERSHIP: "1" });
  const { restore } = stubFetch(validTokenElsewhere());
  try {
    const res = await app.fetch(claimReq({ cfToken: TOKEN, ...ADMIN }), env as never);
    assert.equal(res.status, 403, "mail.example.com is not a loopback host");
    assert.equal(await countUsers(asD1(d)), 0);
  } finally {
    restore();
  }
  d.close();
});

test("localhost plus the opt-in claims, and stores the token", async () => {
  const { d, app } = await claimApp();
  const env = fakeEnv(d, { DEV_UNSAFE_SKIP_OWNERSHIP: "1" });
  const { restore } = stubFetch(validTokenElsewhere());
  try {
    const res = await app.fetch(localClaimReq({ cfToken: TOKEN, ...ADMIN }), env as never);
    assert.equal(res.status, 200);

    const body = (await res.json()) as { worker: { source: string }; nextStep: string };
    assert.equal(body.worker.source, "local");
    // The Worker's name can't be detected locally; the default is used instead
    // of asking, so the wizard goes straight to the domain.
    assert.equal(body.nextStep, "domain");

    // The point of this path over SETUP_TOKEN: the token IS stored, so the
    // domain and DNS steps work against real Cloudflare while developing.
    const secrets = d.query<{ key: string }>(`SELECT key FROM secrets ORDER BY key`);
    assert.deepEqual(secrets.map((s) => s.key), ["auth.session_secret", "cf.token"]);

    const cfg = d.query<{ key: string; value: string }>(
      `SELECT key, value FROM config WHERE key IN ('instance.worker_name','instance.cf_account_id')`,
    );
    const byKey = Object.fromEntries(cfg.map((r) => [r.key, r.value]));
    assert.equal(byKey["instance.cf_account_id"], "acct-1");
    // Not blanked: the catch-all rule points at whatever name this holds.
    assert.ok(!("instance.worker_name" in byKey) || byKey["instance.worker_name"].length > 0);
  } finally {
    restore();
  }
  d.close();
});

test("a token that sees no account is rejected even locally", async () => {
  // Validation still happens — a typo'd token fails here rather than being
  // stored and failing confusingly at the domain step.
  const { d, app } = await claimApp();
  const env = fakeEnv(d, { DEV_UNSAFE_SKIP_OWNERSHIP: "1" });
  const { restore } = stubFetch([
    { match: (u) => u.endsWith("/accounts?per_page=50"), respond: () => ok([]) },
  ]);
  try {
    const res = await app.fetch(localClaimReq({ cfToken: TOKEN, ...ADMIN }), env as never);
    assert.equal(res.status, 422);
    assert.equal(((await res.json()) as { error: string }).error, "account_undetermined");
    assert.equal(await countUsers(asD1(d)), 0);
  } finally {
    restore();
  }
  d.close();
});

test("a token that can't read Workers says so, instead of blaming ownership", async () => {
  // The failure that actually happens in the field: the token belongs to the
  // right account, but lacks Workers Scripts:Read. Reporting that as "your
  // account doesn't run this Worker" sends people to check the wrong thing.
  const { restore } = stubFetch([
    { match: (u) => u.endsWith("/accounts?per_page=50"), respond: () => ok([{ id: "a1", name: "Acme" }]) },
    { match: (u) => u.includes("/workers/domains?"), respond: () => denied(403, 10000) },
    { match: (u) => u.endsWith("/workers/subdomain"), respond: () => denied(403, 10000) },
  ]);
  try {
    await assert.rejects(
      () => identifyWorker(TOKEN, "driftmail.acme.workers.dev"),
      (err: Error & { codes?: number[] }) => {
        assert.match(err.message, /can't read Workers/);
        assert.ok(err.codes?.includes(10000));
        return true;
      },
    );
  } finally {
    restore();
  }
});

test("the claim turns that into a permissions message, naming the scope", async () => {
  const { d, env, app } = await claimApp();
  const { restore } = stubFetch([
    { match: (u) => u.endsWith("/accounts?per_page=50"), respond: () => ok([{ id: "a1", name: "Acme" }]) },
    { match: (u) => u.includes("/workers/domains?"), respond: () => denied(403, 10000) },
    { match: (u) => u.endsWith("/workers/subdomain"), respond: () => denied(403, 10000) },
  ]);
  try {
    const res = await app.fetch(claimReq({ cfToken: TOKEN, ...ADMIN }), env as never);
    assert.equal(res.status, 403);
    const body = (await res.json()) as { error: string; hint?: string };
    assert.notEqual(body.error, "not_owner", "a permission problem is not an ownership problem");
    assert.match(body.hint ?? "", /Workers Scripts/);
    assert.equal(await countUsers(asD1(d)), 0);
  } finally {
    restore();
  }
  d.close();
});

test("a genuinely foreign token still reports not_owner", async () => {
  // The distinction only matters if the real case still works.
  const { d, env, app } = await claimApp();
  const { restore } = stubFetch(customDomainAccount("someone-else.example.com", "theirs"));
  try {
    const res = await app.fetch(claimReq({ cfToken: TOKEN, ...ADMIN }), env as never);
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as { error: string }).error, "not_owner");
  } finally {
    restore();
  }
  d.close();
});

// ── the permission probe ─────────────────────────────────────────────────────

const probeReq = (body: unknown) =>
  new Request("https://mail.example.com/api/setup/check-token", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.44" },
    body: JSON.stringify(body),
  });

/** Every probe passes except the ones named. */
const probeRoutes = (deny: string[] = []) => {
  const blocked = (u: string) => deny.some((d) => u.includes(d));
  const respond = (u: string) => (blocked(u) ? denied(403, 10000) : ok([{ id: "z1", name: "example.com" }]));
  return [
    { match: (u: string) => u.includes("/zones?"), respond },
    { match: (u: string) => u.endsWith("/accounts?per_page=50"), respond: () => ok([{ id: "a1", name: "Acme" }]) },
    { match: (u: string) => u.endsWith("/workers/subdomain"), respond },
    { match: (u: string) => u.includes("/email/routing/addresses"), respond },
    { match: (u: string) => u.includes("/email/routing"), respond },
    { match: (u: string) => u.includes("/dns_records"), respond },
  ];
};

test("the probe names exactly which permission is missing", async () => {
  // The real-world failure: everything works except Workers Scripts:Read.
  const { d, env, app } = await claimApp();
  const { restore } = stubFetch(probeRoutes(["/workers/subdomain"]));
  try {
    const res = await app.fetch(probeReq({ cfToken: TOKEN }), env as never);
    assert.equal(res.status, 200);

    const body = (await res.json()) as {
      ok: boolean;
      missingRequired: string[];
      capabilities: Array<{ id: string; ok: boolean; permission: string; group: string }>;
    };
    assert.equal(body.ok, false);
    assert.deepEqual(body.missingRequired, ["workers.read"]);

    const failed = body.capabilities.filter((cap) => !cap.ok);
    assert.equal(failed.length, 1);
    assert.equal(failed[0].group, "Account");
    assert.equal(failed[0].permission, "Workers Scripts");
  } finally {
    restore();
  }
  d.close();
});

test("a fully-scoped token passes every check", async () => {
  const { d, env, app } = await claimApp();
  const { restore } = stubFetch(probeRoutes());
  try {
    const body = (await (await app.fetch(probeReq({ cfToken: TOKEN }), env as never)).json()) as {
      ok: boolean;
      capabilities: Array<{ ok: boolean; level: string; detail?: string }>;
    };
    assert.equal(body.ok, true);
    assert.ok(body.capabilities.every((cap) => cap.ok));
    // An Edit permission can only be probed as far as its read half, and the
    // result says so rather than implying the write was verified.
    const edits = body.capabilities.filter((cap) => cap.level === "Edit");
    assert.ok(edits.length > 0);
    assert.ok(edits.every((cap) => /write is attempted/.test(cap.detail ?? "")));
  } finally {
    restore();
  }
  d.close();
});

test("missing an optional permission doesn't block setup", async () => {
  // Without DNS:Edit you add the records by hand — annoying, not fatal.
  const { d, env, app } = await claimApp();
  const { restore } = stubFetch(probeRoutes(["/dns_records"]));
  try {
    const body = (await (await app.fetch(probeReq({ cfToken: TOKEN }), env as never)).json()) as {
      ok: boolean;
      missingRequired: string[];
      capabilities: Array<{ id: string; ok: boolean; required: boolean }>;
    };
    assert.equal(body.ok, true, "an optional gap must not read as failure");
    assert.deepEqual(body.missingRequired, []);
    assert.equal(body.capabilities.find((cap) => cap.id === "dns.read")?.ok, false);
  } finally {
    restore();
  }
  d.close();
});

test("the probe closes once the instance is claimed", async () => {
  const { d, env, app } = await claimApp();
  const { restore } = stubFetch(customDomainAccount("mail.example.com", "driftmail"));
  try {
    await app.fetch(claimReq({ cfToken: TOKEN, ...ADMIN }), env as never);
    const res = await app.fetch(probeReq({ cfToken: TOKEN }), env as never);
    assert.equal(res.status, 409);
  } finally {
    restore();
  }
  d.close();
});

test("a zone-scoped token isn't reported as missing zone permissions", async () => {
  // The false negative worth guarding: Zone:Read across the whole account, but
  // Email Routing scoped to one domain. Probing only the first zone would call
  // that "missing Email Routing" and send someone to widen a correct token.
  const { d, env, app } = await claimApp();
  const { restore } = stubFetch([
    {
      match: (u) => u.includes("/zones?"),
      respond: () =>
        ok([
          { id: "z1", name: "other.com", status: "active", type: "full" },
          { id: "z2", name: "mine.com", status: "active", type: "full" },
        ]),
    },
    { match: (u) => u.endsWith("/accounts?per_page=50"), respond: () => ok([{ id: "a1", name: "Acme" }]) },
    { match: (u) => u.endsWith("/workers/subdomain"), respond: () => ok({ subdomain: "acme" }) },
    // Permitted on z2 only.
    {
      match: (u) => u.includes("/zones/z1/"),
      respond: () => denied(403, 10000),
    },
    { match: (u) => u.includes("/zones/z2/"), respond: () => ok({ enabled: true }) },
  ]);
  try {
    const body = (await (await app.fetch(probeReq({ cfToken: TOKEN }), env as never)).json()) as {
      ok: boolean;
      missingRequired: string[];
      capabilities: Array<{ id: string; ok: boolean; detail?: string }>;
    };
    assert.equal(body.ok, true, "one permitted zone is enough");
    assert.deepEqual(body.missingRequired, []);

    // …and it says which domain it actually covers, so the next step is informed.
    const routing = body.capabilities.find((cap) => cap.id === "email_routing.read")!;
    assert.equal(routing.ok, true);
    assert.match(routing.detail ?? "", /1 of 2 domains: mine\.com/);
  } finally {
    restore();
  }
  d.close();
});

test("denied on every zone is still reported as missing", async () => {
  const { d, env, app } = await claimApp();
  const { restore } = stubFetch([
    {
      match: (u) => u.includes("/zones?"),
      respond: () => ok([{ id: "z1", name: "other.com", status: "active", type: "full" }]),
    },
    { match: (u) => u.endsWith("/accounts?per_page=50"), respond: () => ok([{ id: "a1", name: "Acme" }]) },
    { match: (u) => u.endsWith("/workers/subdomain"), respond: () => ok({ subdomain: "acme" }) },
    { match: (u) => u.includes("/zones/z1/"), respond: () => denied(403, 10000) },
  ]);
  try {
    const body = (await (await app.fetch(probeReq({ cfToken: TOKEN }), env as never)).json()) as {
      ok: boolean;
      missingRequired: string[];
    };
    assert.equal(body.ok, false);
    assert.deepEqual(body.missingRequired, ["email_routing.read"]);
  } finally {
    restore();
  }
  d.close();
});

test("a Worker script is recognised even though that endpoint isn't JSON", async () => {
  // GET /workers/scripts/{name} returns 200 with the script bundle as
  // multipart/form-data. Parsing it as JSON threw, and the throw was read as
  // "no such script" — so a real, findable Worker was discarded and the claim
  // reported not_owner.
  const { restore } = stubFetch([
    { match: (u) => u.endsWith("/accounts?per_page=50"), respond: () => ok([{ id: "a1", name: "Acme" }]) },
    { match: (u) => u.includes("/workers/domains?"), respond: () => ok([]) },
    { match: (u) => u.endsWith("/workers/subdomain"), respond: () => ok({ subdomain: "spidydev" }) },
    {
      match: (u) => u.includes("/workers/scripts/rajveerz-qzz-io-driftmail"),
      respond: () => ({ text: '--boundary\r\nContent-Disposition: form-data; name="index.js"\r\n\r\nvar _a;' }),
    },
  ]);
  try {
    const id = await identifyWorker(TOKEN, "rajveerz-qzz-io-driftmail.spidydev.workers.dev");
    assert.equal(id?.workerName, "rajveerz-qzz-io-driftmail");
    assert.equal(id?.source, "workers_dev");
  } finally {
    restore();
  }
});

test("a 404 from the script endpoint still means not found", async () => {
  const { restore } = stubFetch([
    { match: (u) => u.endsWith("/accounts?per_page=50"), respond: () => ok([{ id: "a1", name: "Acme" }]) },
    { match: (u) => u.includes("/workers/domains?"), respond: () => ok([]) },
    { match: (u) => u.endsWith("/workers/subdomain"), respond: () => ok({ subdomain: "acme" }) },
    {
      match: (u) => u.includes("/workers/scripts/"),
      respond: () => ({ status: 404, body: { success: false, errors: [{ code: 10007, message: "not found" }] } }),
    },
  ]);
  try {
    assert.equal(await identifyWorker(TOKEN, "ghost.acme.workers.dev"), null);
  } finally {
    restore();
  }
});

test("a refusal from the script endpoint is reported as a permission problem", async () => {
  const { restore } = stubFetch([
    { match: (u) => u.endsWith("/accounts?per_page=50"), respond: () => ok([{ id: "a1", name: "Acme" }]) },
    { match: (u) => u.includes("/workers/domains?"), respond: () => ok([]) },
    { match: (u) => u.endsWith("/workers/subdomain"), respond: () => ok({ subdomain: "acme" }) },
    { match: (u) => u.includes("/workers/scripts/"), respond: () => denied(403, 10000) },
  ]);
  try {
    await assert.rejects(
      () => identifyWorker(TOKEN, "driftmail.acme.workers.dev"),
      (err: Error) => /can't read Workers/.test(err.message),
    );
  } finally {
    restore();
  }
});

test("Email Routing Addresses is probed at the account, not the zone", async () => {
  // Cloudflare scopes destination addresses to the Account, and its token editor
  // only offers the permission there. The zone path answers 404 — an endpoint
  // that doesn't exist — which the 404-tolerant zone probe read as a pass.
  const { d, env, app } = await claimApp();
  const seen: string[] = [];
  const { restore } = stubFetch([
    {
      match: (u) => {
        seen.push(u);
        return u.includes("/zones?");
      },
      respond: () => ok([{ id: "z1", name: "mine.com", status: "active", type: "full" }]),
    },
    { match: (u) => u.endsWith("/accounts?per_page=50"), respond: () => ok([{ id: "a1", name: "Acme" }]) },
    { match: (u) => u.endsWith("/workers/subdomain"), respond: () => ok({ subdomain: "acme" }) },
    { match: (u) => u.includes("/accounts/a1/email/routing/addresses"), respond: () => denied(403, 10000) },
    { match: (u) => u.includes("/email/routing"), respond: () => ok({ enabled: true }) },
    { match: (u) => u.includes("/dns_records"), respond: () => ok([]) },
  ]);
  try {
    const body = (await (await app.fetch(probeReq({ cfToken: TOKEN }), env as never)).json()) as {
      capabilities: Array<{ id: string; ok: boolean; group: string }>;
    };
    const addresses = body.capabilities.find((cap) => cap.id === "email_addresses.read")!;
    assert.equal(addresses.group, "Account");
    // Denied at the account endpoint must read as denied, not as a 404 pass.
    assert.equal(addresses.ok, false);
    assert.ok(
      !seen.some((u) => u.includes("/zones/z1/email/routing/addresses")),
      "must not probe the zone path, which does not exist",
    );
  } finally {
    restore();
  }
  d.close();
});

test("a zone permission denied everywhere names the domains it tried", async () => {
  // "Denied" alone leaves you guessing whether the permission is absent, or
  // simply not granted on the domain you actually want to use.
  const { d, env, app } = await claimApp();
  const { restore } = stubFetch([
    {
      match: (u) => u.includes("/zones?"),
      respond: () =>
        ok([
          { id: "z1", name: "one.com", status: "active", type: "full" },
          { id: "z2", name: "two.com", status: "active", type: "full" },
        ]),
    },
    { match: (u) => u.endsWith("/accounts?per_page=50"), respond: () => ok([{ id: "a1", name: "Acme" }]) },
    { match: (u) => u.endsWith("/workers/subdomain"), respond: () => ok({ subdomain: "acme" }) },
    { match: (u) => u.includes("/accounts/a1/email/routing/addresses"), respond: () => ok([]) },
    { match: (u) => u.includes("/email/routing"), respond: () => denied(403, 10000) },
    { match: (u) => u.includes("/dns_records"), respond: () => ok([]) },
  ]);
  try {
    const body = (await (await app.fetch(probeReq({ cfToken: TOKEN }), env as never)).json()) as {
      ok: boolean;
      capabilities: Array<{ id: string; ok: boolean; detail?: string }>;
    };
    assert.equal(body.ok, false);
    const routing = body.capabilities.find((cap) => cap.id === "email_routing.read")!;
    assert.equal(routing.ok, false);
    assert.match(routing.detail ?? "", /one\.com, two\.com/);
    assert.match(routing.detail ?? "", /Zone Resources/);
  } finally {
    restore();
  }
  d.close();
});

test("the admin the claim signs in can use the post-claim setup routes", async () => {
  // The session gate skips /api/setup/* by prefix so the claim can run with no
  // session — but the routes after the claim are admin-only. Skipping without
  // resolving the cookie left requireAdmin judging an empty context, answering
  // "forbidden" to the very admin the claim had just signed in.
  const { d, env, app } = await claimApp();
  const { restore } = stubFetch(customDomainAccount("mail.example.com", "driftmail"));
  try {
    const claimed = await app.fetch(claimReq({ cfToken: TOKEN, ...ADMIN }), env as never);
    assert.equal(claimed.status, 200);
    const cookie = (claimed.headers.get("set-cookie") ?? "").split(";")[0];
    assert.match(cookie, /^dm_session=/);

    const withCookie = (path: string, init?: RequestInit) =>
      app.fetch(
        new Request(`https://mail.example.com${path}`, {
          ...init,
          headers: { cookie, "content-type": "application/json", ...(init?.headers ?? {}) },
        }),
        env as never,
      );

    assert.equal((await withCookie("/api/setup/worker")).status, 200);
    const set = await withCookie("/api/setup/worker", {
      method: "POST",
      body: JSON.stringify({ name: "driftmail" }),
    });
    assert.equal(set.status, 200);

    // And without the cookie those routes still refuse.
    const anon = await app.fetch(
      new Request("https://mail.example.com/api/setup/worker"),
      env as never,
    );
    assert.equal(anon.status, 403);
  } finally {
    restore();
  }
  d.close();
});

test("the worker step refuses a name that isn't a real script", async () => {
  // The catch-all rule targets a Worker BY NAME. A typo accepted here either
  // fails loudly later or, worse, delivers mail to whatever script gets that
  // name — so when the stored token can check, a wrong name never gets stored.
  const { d, env, app } = await claimApp();
  const { restore } = stubFetch([
    ...customDomainAccount("mail.example.com", "driftmail"),
    {
      match: (u) => u.includes("/workers/scripts/rajveerz-xdriftmail"),
      respond: () => ({ status: 404, body: { success: false, errors: [{ code: 10007, message: "not found" }] } }),
    },
    { match: (u) => u.includes("/workers/scripts/driftmail"), respond: () => ({ text: "--boundary" }) },
  ]);
  try {
    const claimed = await app.fetch(claimReq({ cfToken: TOKEN, ...ADMIN }), env as never);
    const cookie = (claimed.headers.get("set-cookie") ?? "").split(";")[0];
    const post = (name: string) =>
      app.fetch(
        new Request("https://mail.example.com/api/setup/worker", {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ name }),
        }),
        env as never,
      );

    const typo = await post("rajveerz-xdriftmail");
    assert.equal(typo.status, 400);
    assert.match(((await typo.json()) as { error: string }).error, /no Worker named/);

    // The stored name is untouched by the failed attempt…
    const cfg = d.query<{ value: string }>(
      `SELECT value FROM config WHERE key = 'instance.worker_name'`,
    );
    assert.notEqual(cfg[0]?.value, "rajveerz-xdriftmail");

    // …and a real script is accepted.
    assert.equal((await post("driftmail")).status, 200);
  } finally {
    restore();
  }
  d.close();
});

test("removing a domain detaches Cloudflare before deleting the row", async () => {
  // Observed live: a least-privilege token can't disable Email Routing, the
  // failure was swallowed, the row was deleted anyway — and Cloudflare kept
  // delivering to a Worker that now bounced every message. The fallback is the
  // catch-all rule, which such a token can always edit: it created it.
  const { d, env, app } = await claimApp();
  const calls: string[] = [];
  const { restore } = stubFetch([
    ...customDomainAccount("mail.example.com", "driftmail"),
    { match: (u) => u.includes("/email/routing/disable"), respond: () => denied(403, 10000) },
    {
      match: (u, init) => {
        if (u.endsWith("/email/routing/rules/catch_all") && init?.method === "PUT") {
          calls.push(String(init.body));
          return true;
        }
        return false;
      },
      respond: () => ok({ enabled: false }),
    },
  ]);
  try {
    const claimed = await app.fetch(claimReq({ cfToken: TOKEN, ...ADMIN }), env as never);
    const cookie = (claimed.headers.get("set-cookie") ?? "").split(";")[0];

    // Two rows, so removing one is legal under the last-domain rule.
    d.exec(`INSERT INTO domains (domain, zone_id, receive_enabled, accept_all, created_at, updated_at)
              VALUES ('example.com', 'z1', 1, 1, 1, 1), ('keeper.com', 'z2', 1, 1, 1, 1)`);

    const res = await app.fetch(
      new Request("https://mail.example.com/api/domains/example.com", {
        method: "DELETE",
        headers: { cookie },
      }),
      env as never,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { detached: boolean; warning?: string };
    assert.equal(body.detached, true, "the catch-all fallback should have detached it");
    assert.equal(body.warning, undefined);
    assert.equal(calls.length, 1);
    assert.match(calls[0], /"enabled":false/);
    assert.equal(d.query(`SELECT 1 FROM domains WHERE domain='example.com'`).length, 0);
  } finally {
    restore();
  }
  d.close();
});

test("when Cloudflare can't be detached at all, the removal says so", async () => {
  const { d, env, app } = await claimApp();
  const { restore } = stubFetch([
    ...customDomainAccount("mail.example.com", "driftmail"),
    { match: (u) => u.includes("/email/routing/disable"), respond: () => denied(403, 10000) },
    {
      match: (u, init) => u.endsWith("/rules/catch_all") && init?.method === "PUT",
      respond: () => denied(403, 10000),
    },
  ]);
  try {
    const claimed = await app.fetch(claimReq({ cfToken: TOKEN, ...ADMIN }), env as never);
    const cookie = (claimed.headers.get("set-cookie") ?? "").split(";")[0];
    d.exec(`INSERT INTO domains (domain, zone_id, receive_enabled, accept_all, created_at, updated_at)
              VALUES ('example.com', 'z1', 1, 1, 1, 1), ('keeper.com', 'z2', 1, 1, 1, 1)`);

    const res = await app.fetch(
      new Request("https://mail.example.com/api/domains/example.com", {
        method: "DELETE",
        headers: { cookie },
      }),
      env as never,
    );
    const body = (await res.json()) as { detached: boolean; warning?: string };
    assert.equal(body.detached, false);
    assert.match(body.warning ?? "", /bounce/);
  } finally {
    restore();
  }
  d.close();
});

test("the last domain cannot be removed at all", async () => {
  // One domain gone = one domain's mail stops. The LAST domain gone = the whole
  // instance is deaf. Strictly refused server-side with no override — like the
  // last administrator, the way out is adding another first.
  const { d, env, app } = await claimApp();
  const { restore } = stubFetch([
    ...customDomainAccount("mail.example.com", "driftmail"),
    { match: (u) => u.includes("/email/routing/disable"), respond: () => ok({}) },
  ]);
  try {
    const claimed = await app.fetch(claimReq({ cfToken: TOKEN, ...ADMIN }), env as never);
    const cookie = (claimed.headers.get("set-cookie") ?? "").split(";")[0];
    d.exec(`INSERT INTO domains (domain, zone_id, receive_enabled, accept_all, created_at, updated_at)
              VALUES ('example.com', 'z1', 1, 1, 1, 1)`);

    const del = (path: string) =>
      app.fetch(
        new Request(`https://mail.example.com${path}`, { method: "DELETE", headers: { cookie } }),
        env as never,
      );

    const refused = await del("/api/domains/example.com");
    assert.equal(refused.status, 409);
    assert.equal(((await refused.json()) as { error: string }).error, "last_domain");
    assert.equal(d.query(`SELECT 1 FROM domains`).length, 1, "nothing deleted");

    // No override exists — a force flag must not sneak past it either.
    assert.equal((await del("/api/domains/example.com?force=1")).status, 409);
    assert.equal(d.query(`SELECT 1 FROM domains`).length, 1);

    // With a second domain present, a non-primary one is removable — down to
    // one, then locked again.
    d.exec(`INSERT INTO domains (domain, zone_id, receive_enabled, accept_all, created_at, updated_at)
              VALUES ('b.com', 'z1', 1, 1, 1, 1)`);
    assert.equal((await del("/api/domains/b.com")).status, 200);
    assert.equal((await del("/api/domains/example.com")).status, 409);
  } finally {
    restore();
  }
  d.close();
});


test("the primary domain cannot be removed until another is promoted", async () => {
  // The primary is the instance's default sender and alias domain. Removing it
  // out from under those is refused; the path out is promotion, which demotes
  // the incumbent atomically via the partial unique index.
  const { d, env, app } = await claimApp();
  const { restore } = stubFetch([
    ...customDomainAccount("mail.example.com", "driftmail"),
    { match: (u) => u.includes("/email/routing/disable"), respond: () => ok({}) },
  ]);
  try {
    const claimed = await app.fetch(claimReq({ cfToken: TOKEN, ...ADMIN }), env as never);
    const cookie = (claimed.headers.get("set-cookie") ?? "").split(";")[0];
    d.exec(`INSERT INTO domains (domain, zone_id, is_primary, receive_enabled, accept_all, created_at, updated_at)
              VALUES ('main.com', 'z1', 1, 1, 1, 1, 1), ('other.com', 'z2', 0, 1, 1, 1, 1)`);

    const call = (path: string, method = "DELETE") =>
      app.fetch(
        new Request(`https://mail.example.com${path}`, { method, headers: { cookie } }),
        env as never,
      );

    const refused = await call("/api/domains/main.com");
    assert.equal(refused.status, 409);
    assert.equal(((await refused.json()) as { error: string }).error, "primary_domain");

    // Promote the other, which demotes the incumbent…
    assert.equal((await call("/api/domains/other.com/primary", "POST")).status, 200);
    const primaries = d.query<{ domain: string }>(
      `SELECT domain FROM domains WHERE is_primary = 1`,
    );
    assert.deepEqual(primaries.map((r) => r.domain), ["other.com"]);

    // …and now the old primary is removable.
    assert.equal((await call("/api/domains/main.com")).status, 200);
  } finally {
    restore();
  }
  d.close();
});

// ── factory reset ────────────────────────────────────────────────────────────

test("factory reset needs the password, wipes everything, and reopens setup", async () => {
  const { d, env, app } = await claimApp();
  const detach: string[] = [];
  const { restore } = stubFetch([
    ...customDomainAccount("mail.example.com", "driftmail"),
    {
      match: (u) => u.includes("/email/routing/disable"),
      respond: (u) => {
        detach.push(u);
        return ok({});
      },
    },
  ]);
  try {
    const claimed = await app.fetch(claimReq({ cfToken: TOKEN, ...ADMIN }), env as never);
    const cookie = (claimed.headers.get("set-cookie") ?? "").split(";")[0];

    // A lived-in instance: mail, an R2 blob, a domain.
    d.exec(`INSERT INTO domains (domain, zone_id, receive_enabled, accept_all, created_at, updated_at)
              VALUES ('example.com', 'z1', 1, 1, 1, 1)`);
    const uid = d.query<{ id: string }>(`SELECT id FROM users`)[0].id;
    d.exec(`INSERT INTO messages (id, user_id, direction, from_addr, to_addr, subject, text, raw_key, received_at)
              VALUES ('m1', '${uid}', 'in', 'a@b.com', 'c@example.com', 'Hi', 'body', 'u/${uid}/emails/m1.eml', 1)`);
    env.EMAIL_CACHE.put(`u/${uid}/emails/m1.eml`, "raw");

    const reset = (body: unknown) =>
      app.fetch(
        new Request("https://mail.example.com/api/admin/reset", {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        env as never,
      );

    // The two gates, separately.
    assert.equal((await reset({ password: PW })).status, 400, "must type RESET");
    assert.equal(
      (await reset({ confirm: "RESET", password: "wrong-password-here" })).status,
      403,
      "must re-authenticate",
    );
    assert.equal(d.query(`SELECT 1 FROM messages`).length, 1, "refusals must not wipe");

    const res = await reset({ confirm: "RESET", password: PW });
    assert.equal(res.status, 200);
    assert.deepEqual(((await res.json()) as { warnings: string[] }).warnings, []);

    // Cloudflare detached BEFORE data went — the bounce-storm lesson.
    assert.equal(detach.length, 1);
    // Everything is gone: rows, blobs, the claim itself.
    for (const table of ["messages", "users", "domains", "secrets", "config"]) {
      assert.equal(d.query(`SELECT 1 FROM ${table}`).length, 0, `${table} not empty`);
    }
    assert.equal(env.EMAIL_CACHE.objects.size, 0);

    const status = await app.fetch(
      new Request("https://mail.example.com/api/setup/status"),
      env as never,
    );
    assert.equal(((await status.json()) as { claimed: boolean }).claimed, false);
  } finally {
    restore();
  }
  d.close();
});
