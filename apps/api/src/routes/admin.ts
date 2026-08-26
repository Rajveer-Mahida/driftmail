// Administrator operations: the people on this instance, and where mail with no
// obvious owner should go.

import { Hono } from "hono";
import { asUserId, type AdminUserRow, type UserRole } from "@email/shared";
import type { HonoEnv } from "../env.ts";
import {
  createUser,
  getUserById,
  listUsers,
  setPassword,
  toPublicUser,
  updateUser,
  UserError,
  validateHandle,
} from "../users.ts";
import { getDomain, listDomains, setDomainCatchall } from "../config/domains.ts";
import { cfToken, disableCatchAll, disableRouting } from "../cloudflare.ts";
import { invalidateConfigCache } from "../config/index.ts";
import { verifyPassword } from "../users.ts";
import { explainRecipient } from "../routing.ts";
import { requireAdmin } from "../middleware.ts";

export const admin = new Hono<HonoEnv>();

admin.use("*", requireAdmin());

function fail(err: unknown) {
  if (err instanceof UserError) return { error: err.message, status: err.status };
  return { error: (err as Error)?.message ?? "Request failed", status: 500 };
}

/**
 * A password nobody has to remember: it is shown once, and the account is forced
 * to change it at first sign-in.
 *
 * Six words from a fixed list beats a random string here — it survives being
 * read aloud or copied by hand, which is exactly how it will travel.
 */
const WORDS = [
  "amber", "basalt", "cedar", "delta", "ember", "fjord", "gravel", "harbor",
  "indigo", "juniper", "kelp", "lantern", "marble", "nimbus", "onyx", "pewter",
  "quarry", "ripple", "slate", "thicket", "umber", "vellum", "willow", "zephyr",
];

function tempPassword(): string {
  const picks = new Uint32Array(4);
  crypto.getRandomValues(picks);
  const words = Array.from(picks, (n) => WORDS[n % WORDS.length]);
  const digits = String(crypto.getRandomValues(new Uint32Array(1))[0] % 10000).padStart(4, "0");
  return `${words.join("-")}-${digits}`;
}

// ── people ───────────────────────────────────────────────────────────────────

admin.get("/users", async (c) => {
  const db = c.env.DB;
  const [users, domains] = await Promise.all([listUsers(db), listDomains(db)]);

  const rows: AdminUserRow[] = await Promise.all(
    users.map(async (u) => {
      const aliases = await db
        .prepare(`SELECT COUNT(*) AS n FROM aliases WHERE user_id = ?`)
        .bind(u.id)
        .first<{ n: number }>();
      const messages = await db
        .prepare(`SELECT COUNT(*) AS n FROM messages WHERE user_id = ?`)
        .bind(u.id)
        .first<{ n: number }>();
      return {
        ...toPublicUser(u),
        alias_count: aliases?.n ?? 0,
        message_count: messages?.n ?? 0,
        catchall_domains: domains.filter((d) => d.catchall_user_id === u.id).map((d) => d.domain),
      };
    }),
  );
  return c.json({ users: rows });
});

admin.post("/users", async (c) => {
  const body = await c.req
    .json<{ email?: string; handle?: string; name?: string; role?: UserRole }>()
    .catch(() => ({}) as Record<string, never>);

  if (!body.email) return c.json({ error: "An email address is required" }, 400);

  // Default the handle from the address, since that is almost always what the
  // admin would have typed anyway.
  const handleInput = body.handle?.trim() || body.email.split("@")[0];
  const handle = validateHandle(handleInput);
  if (!handle.ok) return c.json({ error: handle.error }, 400);

  const temp = tempPassword();
  try {
    const user = await createUser(c.env.DB, {
      email: body.email,
      handle: handle.handle,
      name: body.name ?? null,
      role: body.role === "admin" ? "admin" : "user",
      password: temp,
      // An emailed invite link is the one flow guaranteed to be broken on day
      // one, because outbound sending may not be verified yet when the second
      // user is created.
      mustChangePassword: true,
    });
    return c.json({ user: toPublicUser(user), temp_password: temp }, 201);
  } catch (err) {
    const f = fail(err);
    return c.json({ error: f.error }, f.status as 400);
  }
});

admin.patch("/users/:id", async (c) => {
  const id = c.req.param("id");
  const me = c.get("user");
  const body = await c.req
    .json<{ name?: string | null; handle?: string; role?: UserRole; disabled?: boolean }>()
    .catch(() => ({}) as Record<string, never>);

  // Locking yourself out is always a mistake, never an intention.
  if (id === me.id && (body.role === "user" || body.disabled === true)) {
    return c.json({ error: "You can't remove your own access" }, 400);
  }

  try {
    const user = await updateUser(c.env.DB, id, body);
    return c.json({ user: toPublicUser(user) });
  } catch (err) {
    const f = fail(err);
    return c.json({ error: f.error }, f.status as 400);
  }
});

admin.post("/users/:id/reset-password", async (c) => {
  const id = c.req.param("id");
  const user = await getUserById(c.env.DB, id);
  if (!user) return c.json({ error: "No such user" }, 404);

  const temp = tempPassword();
  // setPassword bumps token_version, so every device that user is signed in on
  // is signed out — which is the point of a reset.
  await setPassword(c.env.DB, id, temp, { mustChange: true });
  return c.json({ ok: true, temp_password: temp });
});

admin.delete("/users/:id", async (c) => {
  const id = c.req.param("id");
  const me = c.get("user");
  if (id === me.id) return c.json({ error: "You can't delete your own account" }, 400);

  const user = await getUserById(c.env.DB, id);
  if (!user) return c.json({ error: "No such user" }, 404);
  if (user.role === "admin") {
    const admins = await c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0`,
    ).first<{ n: number }>();
    if ((admins?.n ?? 0) <= 1) {
      return c.json({ error: "This is the only administrator" }, 409);
    }
  }

  const transferTo = c.req.query("transferTo");
  if (transferTo) {
    const target = await getUserById(c.env.DB, transferTo);
    if (!target) return c.json({ error: "No such destination mailbox" }, 400);
    for (const table of ["messages", "attachments"]) {
      await c.env.DB.prepare(`UPDATE ${table} SET user_id = ? WHERE user_id = ?`)
        .bind(transferTo, id)
        .run();
    }
  } else {
    // Sweep the stored objects BEFORE the rows that point at them, or every blob
    // is orphaned in R2 with nothing left to find it by.
    const list = await c.env.EMAIL_CACHE.list({ prefix: `u/${id}/` });
    for (const obj of list.objects) await c.env.EMAIL_CACHE.delete(obj.key);
    await c.env.DB.prepare(`DELETE FROM attachments WHERE user_id = ?`).bind(id).run();
    await c.env.DB.prepare(`DELETE FROM messages WHERE user_id = ?`).bind(id).run();
  }

  // domains.catchall_user_id carries no foreign key, so it has to be cleared by
  // hand or the domain would start bouncing everything.
  await c.env.DB.prepare(
    `UPDATE domains SET catchall_user_id = NULL WHERE catchall_user_id = ?`,
  )
    .bind(id)
    .run();
  // Aliases, rules, drafts, labels and push subscriptions cascade.
  await c.env.DB.prepare(`DELETE FROM users WHERE id = ?`).bind(id).run();

  return c.json({ ok: true, transferred: !!transferTo });
});

// ── routing ──────────────────────────────────────────────────────────────────

admin.post("/domains/:domain/catchall", async (c) => {
  const domain = c.req.param("domain").toLowerCase();
  if (!(await getDomain(c.env.DB, domain))) return c.json({ error: "Unknown domain" }, 404);

  const { userId } = await c.req
    .json<{ userId?: string | null }>()
    .catch(() => ({}) as { userId?: string | null });

  if (userId) {
    const user = await getUserById(c.env.DB, userId);
    if (!user) return c.json({ error: "No such user" }, 400);
    if (user.disabled === 1) {
      return c.json({ error: "That account is disabled, so it would bounce everything" }, 400);
    }
  }

  await setDomainCatchall(c.env.DB, domain, userId ?? null);
  return c.json({ ok: true, domain, catchall_user_id: userId ?? null });
});

/**
 * Where would mail to this address land, and why?
 *
 * Sub-address routing is the one part of this system that can surprise people,
 * so it gets a way to ask rather than a paragraph of documentation.
 */
admin.get("/routing/preview", async (c) => {
  const address = c.req.query("address")?.trim();
  if (!address) return c.json({ error: "address required" }, 400);

  const { normalized, result, trace } = await explainRecipient(c.env.DB, address);
  const owner =
    result.kind === "deliver" ? await getUserById(c.env.DB, asUserId(result.userId)) : null;

  return c.json({
    address,
    normalized: normalized?.recipient ?? null,
    local: normalized?.local ?? null,
    domain: normalized?.domain ?? null,
    result:
      result.kind === "deliver"
        ? { kind: "deliver", user: owner ? toPublicUser(owner) : null, reason: result.reason, matched: result.matched }
        : { kind: "reject", code: result.code },
    trace,
  });
});

/** Mail that reached the Worker and matched no owner. */
admin.get("/unrouted", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM unrouted ORDER BY received_at DESC LIMIT 200`,
  ).all();
  return c.json({ unrouted: results ?? [] });
});

admin.delete("/unrouted", async (c) => {
  await c.env.DB.prepare(`DELETE FROM unrouted`).run();
  return c.json({ ok: true });
});

// ── factory reset ────────────────────────────────────────────────────────────

/**
 * Wipe the instance back to unclaimed: every message, person, credential and
 * setting — as if freshly deployed, with /setup waiting.
 *
 * Ordering is the design here, learned the hard way in this codebase's history:
 * Cloudflare must be detached from every domain BEFORE the data goes. A wiped
 * instance still receiving a domain's mail bounces all of it.
 */
admin.post("/reset", async (c) => {
  const me = c.get("user");
  const body = await c.req
    .json<{ password?: string; confirm?: string }>()
    .catch(() => ({}) as Record<string, never>);

  // Re-authenticate: a reset from a hijacked or forgotten-open session must not
  // be one click. The typed word is for the human; the password is the gate.
  if (body.confirm !== "RESET") {
    return c.json({ error: 'Type RESET to confirm.' }, 400);
  }
  const row = await getUserById(c.env.DB, me.id);
  if (!row || !(await verifyPassword(row, body.password ?? ""))) {
    return c.json({ error: "That isn't your password." }, 403);
  }

  const warnings: string[] = [];

  // 1. Detach Cloudflare from every domain, best-effort within the token.
  const token = await cfToken(c.env);
  for (const domain of await listDomains(c.env.DB)) {
    if (!token || !domain.zone_id) continue;
    const detached =
      (await disableRouting(token, domain.zone_id).then(
        () => true,
        () => false,
      )) ||
      (await disableCatchAll(token, domain.zone_id).then(
        () => true,
        () => false,
      ));
    if (!detached) {
      warnings.push(
        `${domain.domain}: Cloudflare could not be detached — its mail may still route here and bounce. Check the zone's Email Routing in the dashboard.`,
      );
    }
  }

  // 2. Sweep R2 before the rows that reference it, or every blob is orphaned.
  let cursor: string | undefined;
  do {
    const page = await c.env.EMAIL_CACHE.list({ cursor, limit: 500 });
    for (const obj of page.objects) await c.env.EMAIL_CACHE.delete(obj.key);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  // 3. The database, children before parents. `config` last: deleting
  //    instance.claimed_at is the moment the instance becomes claimable again,
  //    so everything else must already be gone by then.
  for (const table of [
    "message_labels",
    "attachments",
    "messages",
    "drafts",
    "aliases",
    "rules",
    "labels",
    "push_subscriptions",
    "user_settings",
    "login_attempts",
    "domain_dns",
    "domains",
    "unrouted",
    "users",
    "secrets",
    "config",
  ]) {
    await c.env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  invalidateConfigCache();

  return c.json({ ok: true, warnings });
});
