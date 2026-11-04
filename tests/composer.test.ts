// Composer support: From addresses and saved templates.
import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDb, asD1 } from "./fakes/d1.ts";
import { fakeEnv, stubFetch } from "./fakes/env.ts";
import { invalidateConfigCache } from "../apps/api/src/config/index.ts";
import { invalidateAuthSecretCache } from "../apps/api/src/auth.ts";
import { upsertDomain } from "../apps/api/src/config/domains.ts";

const PW = "a-long-enough-password";
const TOKEN = "cf-token-value";
const ok = (body: unknown) => ({ body: { success: true, result: body } });

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

test("the From picker lists the user's own addresses, default first", async () => {
  const { d, call } = await signedInApp();
  await upsertDomain(asD1(d), "second.org", { zone_id: "z2" });
  d.exec(`INSERT INTO aliases (address, user_id, disabled, created_at)
          SELECT 'career@example.com', id, 0, 1 FROM users WHERE handle = 'rajveer'`);
  const res = await call("GET", "/api/compose/senders");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { default: string; addresses: string[]; customDomains: string[] };
  assert.equal(body.default, "rajveer@example.com");
  assert.equal(body.addresses[0], "rajveer@example.com");
  assert.ok(body.addresses.includes("rajveer@second.org"));
  assert.ok(body.addresses.includes("career@example.com"));
  assert.ok(!body.addresses.some((a) => a.startsWith("reply@")));
  assert.deepEqual(body.customDomains.sort(), ["example.com", "second.org"], "admin may type others");
  d.close();
});

test("templates can be saved, updated by name, listed and deleted", async () => {
  const { d, call } = await signedInApp();
  assert.equal((await call("POST", "/api/compose/templates", { name: "", html: "<b>x</b>" })).status, 400);
  assert.equal((await call("POST", "/api/compose/templates", { name: "Empty", html: "<div><br></div>" })).status, 400);

  const created = (await (await call("POST", "/api/compose/templates", { name: "Thanks", subject: "Thank you", html: "<b>Thanks!</b>" })).json()) as { id: string };
  await call("POST", "/api/compose/templates", { name: "Follow up", html: "<p>Any news?</p>" });
  // Same name again updates instead of duplicating.
  await call("POST", "/api/compose/templates", { name: "thanks", html: "<b>Many thanks!</b>" });

  let list = (await (await call("GET", "/api/compose/templates")).json()) as Array<{ id: string; name: string; html: string }>;
  assert.deepEqual(list.map((t) => t.name), ["Follow up", "thanks"]);
  assert.equal(list.find((t) => t.id === created.id)?.html, "<b>Many thanks!</b>");

  await call("DELETE", `/api/compose/templates/${created.id}`);
  list = (await (await call("GET", "/api/compose/templates")).json()) as typeof list;
  assert.deepEqual(list.map((t) => t.name), ["Follow up"]);
  d.close();
});
