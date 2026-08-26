import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDb, asD1 } from "./fakes/d1.ts";
import {
  createFirstAdmin,
  createUser,
  updateUser,
  setPassword,
  hashPassword,
  verifyPassword,
  validateHandle,
  validateEmail,
  validatePassword,
  newUserId,
  countAdmins,
  adoptOrphanRows,
  checkLoginAllowed,
  recordLoginFailure,
  clearLoginFailures,
  upgradeHashIfStale,
  getUserById,
  PBKDF2_ITERATIONS,
  UserError,
} from "../apps/api/src/users.ts";

const PW = "a-long-enough-password";

// ── identity rules ───────────────────────────────────────────────────────────

test("user ids are a single FTS token", () => {
  // A hyphenated UUID tokenizes into five terms under unicode61, which breaks
  // the `user_id : <id>` filter the search index relies on.
  for (let i = 0; i < 20; i++) {
    const id = newUserId();
    assert.match(id, /^u[a-f0-9]{32}$/, id);
  }
});

test("handles exclude the sub-address separators", () => {
  // '.', '-' and '+' are what the router splits on, so a handle containing one
  // would make resolution ambiguous rather than merely awkward.
  for (const bad of ["a.b", "a-b", "a+b", "", "_ab", "ab_", "ab c", "x".repeat(65)]) {
    assert.equal(validateHandle(bad).ok, false, JSON.stringify(bad));
  }
  for (const good of ["a", "ab", "a_b", "rajveer", "user123", "x".repeat(64)]) {
    assert.equal(validateHandle(good).ok, true, good);
  }
  // Normalized on the way in, so uniqueness is on the canonical form.
  const ok = validateHandle("  Rajveer  ");
  assert.deepEqual(ok, { ok: true, handle: "rajveer" });
});

test("role addresses cannot be claimed as personal handles", () => {
  for (const reserved of ["postmaster", "abuse", "admin", "noreply", "support"]) {
    const res = validateHandle(reserved);
    assert.equal(res.ok, false, reserved);
    if (!res.ok) assert.match(res.error, /reserved/);
  }
  // Hyphenated role names are rejected earlier, by the format rule, since a
  // handle can never contain a hyphen at all.
  assert.equal(validateHandle("mailer-daemon").ok, false);
});

test("emails and passwords are validated before anything is stored", () => {
  assert.equal(validateEmail("not-an-email").ok, false);
  assert.equal(validateEmail("a@b").ok, false);
  assert.deepEqual(validateEmail(" A@B.com "), { ok: true, email: "a@b.com" });
  assert.equal(validatePassword("short").ok, false);
  assert.equal(validatePassword(PW).ok, true);
});

// ── password hashing ─────────────────────────────────────────────────────────

test("passwords round-trip and reject the wrong input", async () => {
  const fields = await hashPassword(PW);
  assert.equal(fields.pw_iterations, PBKDF2_ITERATIONS);
  assert.equal(await verifyPassword(fields, PW), true);
  assert.equal(await verifyPassword(fields, PW + "x"), false);
  assert.equal(await verifyPassword(fields, ""), false);
});

test("the iteration count stays inside the Workers ceiling", () => {
  // Cloudflare rejects PBKDF2 above 100,000 outright — "iteration counts above
  // 100000 are not supported" — so a higher value fails at runtime, not review.
  assert.ok(PBKDF2_ITERATIONS <= 100_000, "Workers will reject this at runtime");
});

test("every hash gets its own salt", async () => {
  const a = await hashPassword(PW);
  const b = await hashPassword(PW);
  assert.notEqual(a.pw_salt, b.pw_salt);
  assert.notEqual(a.pw_hash, b.pw_hash);
});

test("an unknown algorithm fails closed", async () => {
  const fields = await hashPassword(PW);
  assert.equal(await verifyPassword({ ...fields, pw_algo: "argon2id" }, PW), false);
});

test("a row hashed with fewer iterations still verifies, then upgrades", async () => {
  // pw_iterations is per row so the cost can rise later without forcing anyone
  // to reset their password.
  const d = freshDb();
  const user = await createFirstAdmin(asD1(d), {
    email: "a@example.com",
    handle: "a",
    password: PW,
  });
  await asD1(d)
    .prepare(`UPDATE users SET pw_iterations = 1000 WHERE id = ?`)
    .bind(user.id)
    .run();

  // Re-hash at the low count so the stored digest matches it.
  const weak = await hashPassword(PW);
  await asD1(d)
    .prepare(`UPDATE users SET pw_salt = ?, pw_hash = ?, pw_iterations = 1000 WHERE id = ?`)
    .bind(weak.pw_salt, weak.pw_hash, user.id)
    .run();

  const stale = (await getUserById(asD1(d), user.id))!;
  assert.equal(await verifyPassword(stale, PW), false, "digest was made at the full count");

  await upgradeHashIfStale(asD1(d), stale, PW);
  const upgraded = (await getUserById(asD1(d), user.id))!;
  assert.equal(upgraded.pw_iterations, PBKDF2_ITERATIONS);
  assert.equal(await verifyPassword(upgraded, PW), true);
  d.close();
});

// ── account lifecycle ────────────────────────────────────────────────────────

test("the first admin can only be created once", async () => {
  const d = freshDb();
  const admin = await createFirstAdmin(asD1(d), {
    email: "rajveer@example.com",
    handle: "rajveer",
    password: PW,
  });
  assert.equal(admin.role, "admin");
  assert.equal(admin.token_version, 1);

  await assert.rejects(
    () => createFirstAdmin(asD1(d), { email: "other@example.com", handle: "other", password: PW }),
    (err: UserError) => err.status === 409,
  );
  d.close();
});

test("emails and handles are unique across the instance", async () => {
  const d = freshDb();
  await createFirstAdmin(asD1(d), { email: "a@example.com", handle: "a", password: PW });

  await assert.rejects(
    () => createUser(asD1(d), { email: "A@Example.com", handle: "b", password: PW }),
    (err: UserError) => err.status === 409 && /email/.test(err.message),
  );
  await assert.rejects(
    () => createUser(asD1(d), { email: "b@example.com", handle: "A", password: PW }),
    (err: UserError) => err.status === 409 && /handle/.test(err.message),
  );
  d.close();
});

test("changing what a session may do revokes existing sessions", async () => {
  const d = freshDb();
  await createFirstAdmin(asD1(d), { email: "a@example.com", handle: "a", password: PW });
  const user = await createUser(asD1(d), { email: "b@example.com", handle: "b", password: PW });
  assert.equal(user.token_version, 1);

  // A rename changes routing, a promotion changes permissions, a suspension
  // should take effect now rather than in thirty days.
  const renamed = await updateUser(asD1(d), user.id, { handle: "bee" });
  assert.equal(renamed.token_version, 2);
  const promoted = await updateUser(asD1(d), user.id, { role: "admin" });
  assert.equal(promoted.token_version, 3);
  const suspended = await updateUser(asD1(d), user.id, { disabled: true });
  assert.equal(suspended.token_version, 4);

  // A cosmetic change does not.
  const renamedName = await updateUser(asD1(d), user.id, { name: "Bee" });
  assert.equal(renamedName.token_version, 4);
  d.close();
});

test("changing a password revokes every other session", async () => {
  const d = freshDb();
  const user = await createFirstAdmin(asD1(d), {
    email: "a@example.com",
    handle: "a",
    password: PW,
  });
  await setPassword(asD1(d), user.id, "another-long-password");
  const after = (await getUserById(asD1(d), user.id))!;
  assert.equal(after.token_version, 2);
  assert.equal(await verifyPassword(after, "another-long-password"), true);
  d.close();
});

test("the last administrator cannot be locked out", async () => {
  const d = freshDb();
  const admin = await createFirstAdmin(asD1(d), {
    email: "a@example.com",
    handle: "a",
    password: PW,
  });
  await createUser(asD1(d), { email: "b@example.com", handle: "b", password: PW });

  await assert.rejects(() => updateUser(asD1(d), admin.id, { role: "user" }), /only administrator/);
  await assert.rejects(() => updateUser(asD1(d), admin.id, { disabled: true }), /only administrator/);
  assert.equal(await countAdmins(asD1(d)), 1);

  // Once a second admin exists, the first may step down.
  const second = await createUser(asD1(d), {
    email: "c@example.com",
    handle: "c",
    password: PW,
    role: "admin",
  });
  assert.equal(second.role, "admin");
  await updateUser(asD1(d), admin.id, { role: "user" });
  assert.equal(await countAdmins(asD1(d)), 1);
  d.close();
});

// ── login throttle ───────────────────────────────────────────────────────────

test("repeated failures lock the account out before any key derivation", async () => {
  const d = freshDb();
  const keys = ["email:a@example.com", "ip:203.0.113.1"];

  for (let i = 0; i < 9; i++) await recordLoginFailure(asD1(d), keys);
  assert.deepEqual(await checkLoginAllowed(asD1(d), keys), { allowed: true });

  await recordLoginFailure(asD1(d), keys);
  const locked = await checkLoginAllowed(asD1(d), keys);
  assert.equal(locked.allowed, false);
  if (!locked.allowed) assert.ok(locked.retryAfter > 0);

  // Either key alone is enough to hold the lock, so switching IP doesn't help.
  assert.equal((await checkLoginAllowed(asD1(d), ["email:a@example.com"])).allowed, false);

  await clearLoginFailures(asD1(d), keys);
  assert.deepEqual(await checkLoginAllowed(asD1(d), keys), { allowed: true });
  d.close();
});

test("failures outside the window start a fresh count", async () => {
  const d = freshDb();
  const keys = ["email:a@example.com"];
  const t0 = 1_000_000;
  for (let i = 0; i < 9; i++) await recordLoginFailure(asD1(d), keys, t0);

  const later = t0 + 16 * 60 * 1000;
  await recordLoginFailure(asD1(d), keys, later);
  assert.deepEqual(await checkLoginAllowed(asD1(d), keys, later), { allowed: true });
  d.close();
});

// ── adoption ─────────────────────────────────────────────────────────────────

test("pre-existing mail is invisible until the first admin adopts it", async () => {
  const d = freshDb();
  await asD1(d)
    .prepare(
      `INSERT INTO messages (id, direction, from_addr, to_addr, subject, text, received_at)
         VALUES ('m1','in','a@b.com','c@d.com','Old mail','body',1)`,
    )
    .run();
  await asD1(d)
    .prepare(`INSERT INTO labels (id, name, color, created_at) VALUES ('l1','Work','#fff',1)`)
    .run();

  const admin = await createFirstAdmin(asD1(d), {
    email: "rajveer@example.com",
    handle: "rajveer",
    password: PW,
  });

  // Before adoption the rows exist but belong to nobody, so no user_id = ?
  // query can see them.
  assert.equal(d.query(`SELECT 1 FROM messages WHERE user_id IS NULL`).length, 1);

  const adopted = await adoptOrphanRows(asD1(d), admin.id);
  assert.equal(adopted.messages, 1);
  assert.equal(adopted.labels, 1);
  assert.equal(d.query(`SELECT 1 FROM messages WHERE user_id = ?`, admin.id).length, 1);

  // And adoption re-indexes them for search.
  const hits = d.query(
    `SELECT m.id FROM messages m JOIN messages_fts f ON f.rowid = m.rowid
       WHERE messages_fts MATCH ?`,
    `user_id : ${admin.id} AND {subject from_addr snippet text} : ("old"*)`,
  );
  assert.equal(hits.length, 1);
  d.close();
});
