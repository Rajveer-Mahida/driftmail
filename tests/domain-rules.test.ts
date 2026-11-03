// Per-domain accept rules ("only these addresses") and exact-address aliases.
import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDb, asD1 } from "./fakes/d1.ts";
import { fakeEnv, stubFetch } from "./fakes/env.ts";
import { invalidateConfigCache } from "../apps/api/src/config/index.ts";
import { invalidateAuthSecretCache } from "../apps/api/src/auth.ts";
import { upsertDomain, setDomainCatchall, validatePatterns } from "../apps/api/src/config/domains.ts";
import { createFirstAdmin, createUser } from "../apps/api/src/users.ts";
import { resolveRecipient } from "../apps/api/src/routing.ts";

const PW = "a-long-enough-password";
const TOKEN = "cf-token-value";
const ok = (body: unknown) => ({ body: { success: true, result: body } });

// ── validatePatterns ─────────────────────────────────────────────────────────

test("patterns must be addresses on the domain being configured", () => {
  const good = validatePatterns("example.com", " Career@Example.com,\n*.shop@example.com, career@example.com ");
  assert.deepEqual(good, { ok: true, patterns: ["career@example.com", "*.shop@example.com"] });

  for (const bad of ["", "  ,  ", "career", "career@", "@example.com", "a@b@example.com", "career@other.com", "a b@example.com"]) {
    assert.equal(validatePatterns("example.com", bad).ok, false, `accepted ${JSON.stringify(bad)}`);
  }
  // A domain glob in the pattern is fine as long as it covers this domain.
  assert.equal(validatePatterns("example.com", "hr@*.com").ok, true);
});

// ── routing ──────────────────────────────────────────────────────────────────

async function restricted() {
  const d = freshDb();
  const admin = await createFirstAdmin(asD1(d), { email: "rajveer@example.com", handle: "rajveer", password: PW });
  const meera = await createUser(asD1(d), { email: "meera@example.com", handle: "meera", password: PW });
  await upsertDomain(asD1(d), "example.com", {
    is_primary: 1,
    accept_all: 0,
    allowed_pattern: "career@example.com, *.shop@example.com, meera@example.com",
  });
  await setDomainCatchall(asD1(d), "example.com", admin.id);
  d.exec(`INSERT INTO aliases (address, user_id, disabled, created_at) VALUES ('career@example.com', '${meera.id}', 0, 1)`);
  return { d, admin: admin.id, meera: meera.id };
}

test("'only these addresses' refuses everything else, even with a catch-all", async () => {
  const { d, admin, meera } = await restricted();
  const route = (a: string) => resolveRecipient(asD1(d), a);

  const career = await route("career@example.com");
  assert.equal(career.kind, "deliver");
  if (career.kind === "deliver") assert.equal(career.userId, meera, "alias still decides the inbox");

  const tagged = await route("career+linkedin@example.com");
  assert.equal(tagged.kind, "deliver", "a +tag is ignored when matching");

  const shop = await route("amazon.shop@example.com");
  assert.equal(shop.kind, "deliver");
  if (shop.kind === "deliver") assert.equal(shop.userId, admin, "then the catch-all");

  assert.equal((await route("meera@example.com")).kind, "deliver", "a listed handle works");

  for (const refused of ["random@example.com", "rajveer@example.com", "rajveer.netflix@example.com"]) {
    const r = await route(refused);
    assert.equal(r.kind, "reject", refused);
    if (r.kind === "reject") assert.equal(r.code, "not_allowed", refused);
  }
  d.close();
});

test("accept-all ignores a stored pattern", async () => {
  const { d } = await restricted();
  await upsertDomain(asD1(d), "example.com", { accept_all: 1 });
  assert.equal((await resolveRecipient(asD1(d), "random@example.com")).kind, "deliver");
  d.close();
});

// ── HTTP: PATCH /api/domains/:domain and exact aliases ───────────────────────

async function signedInApp() {
  invalidateConfigCache();
  invalidateAuthSecretCache();
  const d = freshDb();
  const env = fakeEnv(d);
  const { default: app } = await import("../apps/api/src/index.ts");
  const { restore } = stubFetch([
    { match: (u) => u.endsWith("/accounts?per_page=50"), respond: () => ok([{ id: "acct-1", name: "Acme" }]) },
    {
      match: (u) => u.includes("/workers/domains?hostname="),
      respond: () => ok([{ id: "d1", zone_id: "z1", zone_name: "example.com", hostname: "mail.example.com", service: "driftmail" }]),
    },
    { match: (u) => u.endsWith("/workers/subdomain"), respond: () => ok({ subdomain: "acme" }) },
  ]);
  const claimed = await app.fetch(
    new Request("https://mail.example.com/api/setup/claim", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9" },
      body: JSON.stringify({ cfToken: TOKEN, email: "rajveer@example.com", handle: "rajveer", password: PW }),
    }),
    env as never,
  );
  restore();
  assert.equal(claimed.status, 200);
  const cookie = (claimed.headers.get("set-cookie") ?? "").split(";")[0];
  await upsertDomain(asD1(d), "example.com", { is_primary: 1, zone_id: "z1" });

  const call = (method: string, path: string, body?: unknown) =>
    app.fetch(
      new Request(`https://mail.example.com${path}`, {
        method,
        headers: { "content-type": "application/json", cookie },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      env as never,
    );
  return { d, call };
}

test("domain rules can be edited, and invalid ones are refused", async () => {
  const { d, call } = await signedInApp();
  const row = () =>
    d.query<{ accept_all: number; allowed_pattern: string | null; forward_to: string | null; fallback_forward_to: string | null }>(
      `SELECT accept_all, allowed_pattern, forward_to, fallback_forward_to FROM domains WHERE domain = 'example.com'`,
    )[0];

  assert.equal((await call("PATCH", "/api/domains/example.com", { acceptAll: false, allowedPattern: "" })).status, 400);
  assert.equal((await call("PATCH", "/api/domains/example.com", { acceptAll: false, allowedPattern: "hr@other.com" })).status, 400);
  assert.equal((await call("PATCH", "/api/domains/example.com", { forwardTo: "not-an-address" })).status, 400);
  assert.equal((await call("PATCH", "/api/domains/example.com", { forwardTo: "me@example.com" })).status, 400, "loop");
  assert.equal(row().accept_all, 1, "rejected edits change nothing");

  const res = await call("PATCH", "/api/domains/example.com", {
    acceptAll: false,
    allowedPattern: "career@example.com, *.shop@example.com",
    forwardTo: "Me@Gmail.com",
    fallbackForwardTo: "",
  });
  assert.equal(res.status, 200);
  assert.deepEqual(row(), {
    accept_all: 0,
    allowed_pattern: "career@example.com, *.shop@example.com",
    forward_to: "me@gmail.com",
    fallback_forward_to: null,
  });

  // Back to accept-all keeps the list, so switching again restores it.
  assert.equal((await call("PATCH", "/api/domains/example.com", { acceptAll: true })).status, 200);
  assert.equal(row().accept_all, 1);
  assert.equal(row().allowed_pattern, "career@example.com, *.shop@example.com");

  assert.equal((await call("PATCH", "/api/domains/nope.com", { acceptAll: true })).status, 404);
  d.close();
});

test("an alias can be created as an exact address, without the handle", async () => {
  const { d, call } = await signedInApp();

  const res = await call("POST", "/api/aliases", { address: "Career@Example.com", name: "Careers" });
  assert.equal(res.status, 201);
  assert.equal(((await res.json()) as { address: string }).address, "career@example.com");

  for (const bad of ["career", "career@", ".career@example.com", "car eer@example.com", "career.@example.com"]) {
    assert.equal((await call("POST", "/api/aliases", { address: bad })).status, 400, bad);
  }
  // Not on a configured domain.
  assert.equal((await call("POST", "/api/aliases", { address: "career@other.com" })).status, 400);

  // The generated form still appends the handle.
  const gen = await call("POST", "/api/aliases", { local: "netflix" });
  assert.equal(((await gen.json()) as { address: string }).address, "netflix.rajveer@example.com");

  const routed = await resolveRecipient(asD1(d), "career@example.com");
  assert.equal(routed.kind, "deliver");
  if (routed.kind === "deliver") assert.equal(routed.reason, "alias");
  d.close();
});
