import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDb, asD1, type FakeD1 } from "./fakes/d1.ts";
import { upsertDomain, setDomainCatchall } from "../apps/api/src/config/domains.ts";
import { createUser, createFirstAdmin } from "../apps/api/src/users.ts";
import {
  resolveRecipient,
  explainRecipient,
  normalizeAddress,
  splitSegments,
} from "../apps/api/src/routing.ts";

const PW = "a-long-enough-password";

/**
 * Two users on two domains:
 *   example.com  catch-all -> rajveer (admin)
 *   alt.com      no catch-all
 * Aliases: billing@ -> meera, shop.rajveer@ -> meera (an admin override),
 *          old@ -> rajveer but burned.
 */
async function fixture(): Promise<{ d: FakeD1; rajveer: string; meera: string }> {
  const d = freshDb();
  const rajveer = await createFirstAdmin(asD1(d), {
    email: "rajveer@example.com",
    handle: "rajveer",
    password: PW,
  });
  const meera = await createUser(asD1(d), {
    email: "meera@example.com",
    handle: "meera",
    password: PW,
  });

  await upsertDomain(asD1(d), "example.com", { is_primary: 1 });
  await upsertDomain(asD1(d), "alt.com", {});
  await setDomainCatchall(asD1(d), "example.com", rajveer.id);

  const alias = async (address: string, userId: string, disabled = 0) =>
    asD1(d)
      .prepare(
        `INSERT INTO aliases (address, user_id, disabled, created_at) VALUES (?, ?, ?, 1)`,
      )
      .bind(address, userId, disabled)
      .run();

  await alias("billing@example.com", meera.id);
  await alias("shop.rajveer@example.com", meera.id);
  await alias("old@example.com", rajveer.id, 1);

  return { d, rajveer: rajveer.id, meera: meera.id };
}

// ── normalization ────────────────────────────────────────────────────────────

test("addresses are canonicalized before anything else", () => {
  const n = normalizeAddress('  "Someone" <Rajveer+News@Example.COM.>  ');
  assert.equal(n?.recipient, "rajveer+news@example.com");
  assert.equal(n?.base, "rajveer");
  assert.equal(n?.baseAddress, "rajveer@example.com");
  assert.equal(n?.domain, "example.com");

  // Split on the LAST @, since a local part may legally contain one.
  assert.equal(normalizeAddress("a@b@example.com")?.base, "a@b");

  for (const bad of ["", "   ", "@example.com", "nobody", "a@", "+tag@example.com", "a@ b.com"]) {
    assert.equal(normalizeAddress(bad), null, JSON.stringify(bad));
  }
});

test("dots are separators here, not noise to be stripped", () => {
  // Gmail collapses a.b@ and ab@; doing that would break sub-address routing.
  assert.deepEqual(splitSegments("news.letters-meera"), ["news", "letters", "meera"]);
  assert.deepEqual(splitSegments("rajveer"), ["rajveer"]);
  assert.deepEqual(splitSegments("a+b.c-d"), ["a", "b", "c", "d"]);
});

// ── the routing matrix ───────────────────────────────────────────────────────

test("every address on the domain reaches the right mailbox", async () => {
  const { d, rajveer, meera } = await fixture();

  const cases: Array<[address: string, owner: string, reason: string]> = [
    // The handle itself, in any case.
    ["Rajveer@Example.com", rajveer, "handle"],
    // A plus tag is stripped before the handle lookup.
    ["rajveer+news@example.com", rajveer, "handle"],
    // Sub-addressing, handle first or last, dot or hyphen.
    ["rajveer.netflix@example.com", rajveer, "subaddress"],
    ["netflix.rajveer@example.com", rajveer, "subaddress"],
    ["rajveer-uber@example.com", rajveer, "subaddress"],
    // The case a last-segment-only rule would get wrong: `aws` is not a handle,
    // so this would fall through to the admin catch-all instead of reaching meera.
    ["meera.aws@example.com", meera, "subaddress"],
    ["news.letters-meera@example.com", meera, "subaddress"],
    // Two handles present: the leading name wins, since that is the one a sender
    // writes when they mean a person.
    ["meera.rajveer@example.com", meera, "subaddress"],
    ["rajveer.meera@example.com", rajveer, "subaddress"],
    // An explicit alias outranks the handle it happens to contain.
    ["shop.rajveer@example.com", meera, "alias"],
    ["billing@example.com", meera, "alias"],
    ["billing+vat@example.com", meera, "alias_base"],
    // Nothing claims it, so the catch-all owner takes it.
    ["hello@example.com", rajveer, "catchall"],
    ["a.b.c@example.com", rajveer, "catchall"],
    // Handles are instance-global, so they work on every domain.
    ["rajveer@alt.com", rajveer, "handle"],
    ["meera.aws@alt.com", meera, "subaddress"],
  ];

  for (const [address, owner, reason] of cases) {
    const res = await resolveRecipient(asD1(d), address);
    assert.equal(res.kind, "deliver", `${address} was rejected`);
    if (res.kind !== "deliver") continue;
    assert.equal(res.userId, owner, `${address} went to the wrong mailbox`);
    assert.equal(res.reason, reason, `${address} matched the wrong rule`);
  }
  d.close();
});

test("mail with no owner is rejected rather than guessed at", async () => {
  const { d } = await fixture();

  const cases: Array<[address: string, code: string]> = [
    // A burned alias bounces before anything is parsed or stored.
    ["old@example.com", "disabled_alias"],
    ["old+tag@example.com", "disabled_alias"],
    // alt.com has no catch-all owner.
    ["random@alt.com", "no_owner"],
    // Domains this instance does not handle. The globs are anchored, so these
    // near-misses must not slip through.
    ["hi@notmine.com", "unknown_domain"],
    ["hi@evil-example.com", "unknown_domain"],
    ["hi@example.com.evil.com", "unknown_domain"],
    ["nonsense", "bad_address"],
    ["+tag@example.com", "bad_address"],
  ];

  for (const [address, code] of cases) {
    const res = await resolveRecipient(asD1(d), address);
    assert.equal(res.kind, "reject", `${address} should not deliver`);
    if (res.kind !== "reject") continue;
    assert.equal(res.code, code, address);
  }
  d.close();
});

test("a disabled user's mail stops, including via the catch-all", async () => {
  const { d, meera } = await fixture();
  await asD1(d).prepare(`UPDATE users SET disabled = 1 WHERE id = ?`).bind(meera).run();

  for (const address of ["meera@example.com", "meera.aws@example.com", "billing@example.com"]) {
    const res = await resolveRecipient(asD1(d), address);
    assert.equal(res.kind, "reject", address);
    if (res.kind === "reject") assert.equal(res.code, "disabled_owner", address);
  }
  d.close();
});

test("a catch-all pointing at a deleted account bounces rather than vanishing", async () => {
  // domains.catchall_user_id carries no foreign key — a later migration cannot
  // add one to a column referencing a table created after it — so a stale id can
  // survive there even though aliases and rules cascade away. A stale owner has
  // to behave exactly like no owner: bounce, so the sender is told, instead of
  // accepting mail into an account that no longer exists.
  const { d } = await fixture();
  await setDomainCatchall(asD1(d), "example.com", "udoesnotexist");

  const res = await resolveRecipient(asD1(d), "nobody-in-particular@example.com");
  assert.equal(res.kind, "reject");
  if (res.kind === "reject") assert.equal(res.code, "no_owner");
  d.close();
});

test("deleting a user takes their aliases and rules with them", async () => {
  const { d, meera } = await fixture();
  await asD1(d)
    .prepare(`INSERT INTO rules (id, field, op, value, action, enabled, created_at)
                VALUES ('r1','from','contains','x','archive',1,1)`)
    .run();
  await asD1(d).prepare(`UPDATE rules SET user_id = ? WHERE id = 'r1'`).bind(meera).run();
  assert.equal(d.query(`SELECT 1 FROM aliases WHERE user_id = ?`, meera).length, 2);

  await asD1(d).prepare(`DELETE FROM users WHERE id = ?`).bind(meera).run();

  assert.equal(d.query(`SELECT 1 FROM aliases WHERE user_id = ?`, meera).length, 0);
  assert.equal(d.query(`SELECT 1 FROM rules WHERE user_id = ?`, meera).length, 0);
  d.close();
});

test("the recipient keeps its tag while the alias row does not", async () => {
  // Otherwise foo+a@, foo+b@ and foo+c@ each become a separate alias, and the
  // list becomes unusable within a week.
  const { d } = await fixture();
  const res = await resolveRecipient(asD1(d), "rajveer+netflix@example.com");
  assert.equal(res.kind, "deliver");
  if (res.kind !== "deliver") return;
  assert.equal(res.recipient, "rajveer+netflix@example.com");
  assert.equal(res.baseAddress, "rajveer@example.com");
  d.close();
});

test("a glob domain accepts its subdomains but stays anchored", async () => {
  const d = freshDb();
  const admin = await createFirstAdmin(asD1(d), {
    email: "me@example.com",
    handle: "me",
    password: PW,
  });
  await upsertDomain(asD1(d), "*.example.com", { is_primary: 1 });
  await setDomainCatchall(asD1(d), "*.example.com", admin.id);

  assert.equal((await resolveRecipient(asD1(d), "any@mail.example.com")).kind, "deliver");
  assert.equal((await resolveRecipient(asD1(d), "any@example.com")).kind, "reject");
  assert.equal((await resolveRecipient(asD1(d), "any@mail.example.com.evil.com")).kind, "reject");
  d.close();
});

test("an unconfigured instance routes nothing", async () => {
  // A freshly deployed Worker must be inert until it is set up.
  const d = freshDb();
  const res = await resolveRecipient(asD1(d), "anyone@anywhere.com");
  assert.equal(res.kind, "reject");
  if (res.kind === "reject") assert.equal(res.code, "unknown_domain");
  d.close();
});

test("the preview explains which rule decided, step by step", async () => {
  const { d, meera } = await fixture();
  const { result, trace } = await explainRecipient(asD1(d), "meera.aws@example.com");

  assert.equal(result.kind, "deliver");
  if (result.kind === "deliver") assert.equal(result.userId, meera);

  const byRule = Object.fromEntries(trace.map((t) => [t.rule, t]));
  assert.equal(byRule["domain"].hit, true);
  assert.equal(byRule["alias"].hit, false);
  assert.equal(byRule["handle or login email"].hit, false);
  assert.equal(byRule["sub-address"].hit, true);
  assert.match(byRule["sub-address"].detail!, /meera/);
  d.close();
});
