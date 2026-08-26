import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDb, asD1 } from "./fakes/d1.ts";
import { upsertDomain } from "../apps/api/src/config/domains.ts";
import { resolveFrom } from "../apps/api/src/send/sender.ts";
import type { SendError } from "../apps/api/src/send/types.ts";

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
