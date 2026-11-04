import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDb, asD1 } from "./fakes/d1.ts";
import { upsertDomain, setDomainCatchall } from "../apps/api/src/config/domains.ts";
import { createFirstAdmin, createUser } from "../apps/api/src/users.ts";
import { resolveFrom } from "../apps/api/src/send/sender.ts";
import { SendError } from "../apps/api/src/send/types.ts";

const inbound = (to: string) => ({ direction: "in" as const, to_addr: to, from_addr: "them@x.com" });
const outbound = (from: string) => ({ direction: "out" as const, to_addr: "them@x.com", from_addr: from });

test("an explicit sender wins over everything", async () => {
  const d = freshDb();
  await upsertDomain(asD1(d), "example.com", { is_primary: 1, default_from: "hello@example.com" });
  assert.equal(
    await resolveFrom(asD1(d), { explicit: " chosen@example.com ", parent: inbound("alias@example.com") }),
    "chosen@example.com",
  );
  d.close();
});

test("a reply comes from the alias the thread arrived at", async () => {
  // Not the instance-wide address: the sender already knows the alias, and
  // replying from something else looks like a different person.
  const d = freshDb();
  await upsertDomain(asD1(d), "example.com", { is_primary: 1, default_from: "hello@example.com" });
  assert.equal(
    await resolveFrom(asD1(d), { parent: inbound("netflix.rajveer@example.com") }),
    "netflix.rajveer@example.com",
  );
  d.close();
});

test("continuing an outbound thread keeps the address it was sent from", async () => {
  const d = freshDb();
  await upsertDomain(asD1(d), "example.com", { is_primary: 1 });
  assert.equal(
    await resolveFrom(asD1(d), { parent: outbound("shop.rajveer@example.com") }),
    "shop.rajveer@example.com",
  );
  d.close();
});

test("with no thread, the primary domain's default_from is used", async () => {
  const d = freshDb();
  await upsertDomain(asD1(d), "other.com", {});
  await upsertDomain(asD1(d), "example.com", { is_primary: 1, default_from: "hello@example.com" });
  assert.equal(await resolveFrom(asD1(d), {}), "hello@example.com");
  d.close();
});

test("without a default_from it falls back to reply@<primary>", async () => {
  // So a freshly configured domain sends without anything else being set.
  const d = freshDb();
  await upsertDomain(asD1(d), "example.com", { is_primary: 1 });
  assert.equal(await resolveFrom(asD1(d), {}), "reply@example.com");
  d.close();
});

test("with no primary marked, the only domain still works", async () => {
  const d = freshDb();
  await upsertDomain(asD1(d), "example.com", {});
  assert.equal(await resolveFrom(asD1(d), {}), "reply@example.com");
  d.close();
});

test("with no domains at all it refuses rather than inventing a sender", async () => {
  const d = freshDb();
  await assert.rejects(
    () => resolveFrom(asD1(d), {}),
    (err: SendError) => {
      assert.equal(err.code, "no_sender");
      assert.match(err.hint!, /Settings/);
      return true;
    },
  );
  d.close();
});

test("a blank explicit sender falls through instead of sending from empty", async () => {
  const d = freshDb();
  await upsertDomain(asD1(d), "example.com", { is_primary: 1 });
  assert.equal(await resolveFrom(asD1(d), { explicit: "   " }), "reply@example.com");
  d.close();
});

// ── The signed-in user's own address ─────────────────────────────────────────

const PW = "a-long-enough-password";

async function setup() {
  const d = freshDb();
  await upsertDomain(asD1(d), "example.com", { is_primary: 1 });
  const admin = await createFirstAdmin(asD1(d), { email: "hello@example.com", handle: "hello", password: PW });
  const meera = await createUser(asD1(d), { email: "meera@example.com", handle: "meera", password: PW });
  // Logs in with a Gmail address; mail on our domain still reaches them by handle.
  const sam = await createUser(asD1(d), { email: "sam@gmail.com", handle: "sam", password: PW });
  await setDomainCatchall(asD1(d), "example.com", meera.id);
  d.exec(`INSERT INTO aliases (address, user_id, disabled, created_at) VALUES ('career@example.com', '${meera.id}', 0, 1)`);
  const as = (u: { id: string; email: string; handle: string; role: string }) => u;
  return { d, admin: as(admin), meera: as(meera), sam: as(sam) };
}

test("a new message comes from the signed-in user, not reply@", async () => {
  const { d, admin, meera, sam } = await setup();
  const db = asD1(d);
  assert.equal(await resolveFrom(db, { user: admin }), "hello@example.com");
  assert.equal(await resolveFrom(db, { user: meera }), "meera@example.com");
  assert.equal(await resolveFrom(db, { user: sam }), "sam@example.com", "handle on the primary domain");
  // System mail with no user keeps the domain default.
  assert.equal(await resolveFrom(db, {}), "reply@example.com");
  d.close();
});

test("a reply comes from the address the mail arrived at", async () => {
  const { d, meera } = await setup();
  const parent = { direction: "in" as const, to_addr: "career@example.com", from_addr: "x@gmail.com" };
  assert.equal(await resolveFrom(asD1(d), { user: meera, parent }), "career@example.com");
  d.close();
});

test("a chosen From must belong to the sender", async () => {
  const { d, admin, meera, sam } = await setup();
  const db = asD1(d);
  assert.equal(await resolveFrom(db, { user: meera, explicit: "career@example.com" }), "career@example.com");
  assert.equal(await resolveFrom(db, { user: meera, explicit: "meera.shop@example.com" }), "meera.shop@example.com");
  assert.equal(await resolveFrom(db, { user: admin, explicit: "news@example.com" }), "news@example.com", "admins may use any");

  for (const [user, addr] of [
    [sam, "hello@example.com"],
    [sam, "career@example.com"],
    [meera, "random@example.com"], // only hers as the catch-all owner
    [meera, "ceo@other.com"],
  ] as const) {
    await assert.rejects(resolveFrom(db, { user, explicit: addr }), SendError, `${user.handle} → ${addr}`);
  }
  // A forwarded thread whose alias isn't theirs falls back to their own address.
  const parent = { direction: "in" as const, to_addr: "career@example.com", from_addr: "x@gmail.com" };
  assert.equal(await resolveFrom(db, { user: sam, parent }), "sam@example.com");
  d.close();
});
