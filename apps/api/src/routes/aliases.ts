import { Hono } from "hono";
import type { HonoEnv } from "../env.ts";
import { listAliases, createAlias, updateAlias, deleteAlias } from "../db.ts";
import { isAllowedRecipient, loadPolicies, getPrimaryDomain } from "../config/domains.ts";
import { resolveRecipient } from "../routing.ts";
import { scopeOf } from "../middleware.ts";

export const aliases = new Hono<HonoEnv>();

aliases.get("/", async (c) => c.json(await listAliases(c.env.DB, scopeOf(c))));

aliases.post("/", async (c) => {
  const b = await c.req
    .json<{ address?: string; local?: string; domain?: string; name?: string; note?: string }>()
    .catch(() => ({}) as Record<string, never>);

  const user = c.get("user");
  const uid = scopeOf(c);
  const policies = await loadPolicies(c.env.DB);
  if (!policies.length) {
    return c.json({ error: "No mail domain is configured yet — add one in Settings." }, 400);
  }

  let address = b.address?.trim().toLowerCase();
  if (!address) {
    const primary = await getPrimaryDomain(c.env.DB);
    const domain = b.domain?.trim().toLowerCase() || primary?.domain || policies[0].domain;
    const policy = policies.find((p) => p.domain === domain);
    if (!policy) return c.json({ error: "Unknown domain" }, 400);

    const local =
      b.local?.trim().toLowerCase().replace(/[^a-z0-9._%+-]/g, "") ||
      `alias-${Math.floor(1000 + Math.random() * 9000)}`;
    // The generated shape puts the user's own handle in it, so the address
    // routes back to them even before the alias row exists.
    address = policy.aliasSuffix
      ? `${local}.${policy.aliasSuffix}@${domain}`
      : `${local}.${user.handle}@${domain}`;
  }

  // An alias is only useful if mail addressed to it would actually be accepted.
  if (!isAllowedRecipient(policies, address)) {
    return c.json(
      { error: "That address wouldn't receive mail on any configured domain." },
      400,
    );
  }

  // Claiming an address that currently reaches someone else would silently
  // redirect their mail. Admins may do it deliberately; nobody else may.
  const current = await resolveRecipient(c.env.DB, address, policies);
  if (
    current.kind === "deliver" &&
    current.userId !== user.id &&
    current.reason !== "catchall" &&
    user.role !== "admin"
  ) {
    return c.json({ error: "That address already routes to another mailbox" }, 409);
  }

  const row = await createAlias(
    c.env.DB,
    uid,
    address,
    b.name?.trim() || null,
    b.note?.trim() || null,
  );
  return c.json(row, 201);
});

aliases.post("/update", async (c) => {
  const b = await c.req
    .json<{ address?: string; name?: string | null; note?: string | null; disabled?: 0 | 1 }>()
    .catch(() => ({}) as Record<string, never>);
  if (!b.address) return c.json({ error: "address required" }, 400);
  await updateAlias(c.env.DB, scopeOf(c), b.address, {
    name: b.name,
    note: b.note,
    disabled: b.disabled,
  });
  return c.json({ ok: true });
});

aliases.post("/delete", async (c) => {
  const b = await c.req.json<{ address?: string }>().catch(() => ({}) as { address?: string });
  if (!b.address) return c.json({ error: "address required" }, 400);
  await deleteAlias(c.env.DB, scopeOf(c), b.address);
  return c.json({ ok: true });
});

/** Where would mail to this address actually land? Drives the live hint in the
 *  alias form, so sub-address routing is discoverable rather than surprising. */
aliases.get("/preview", async (c) => {
  const address = c.req.query("address")?.trim();
  if (!address) return c.json({ error: "address required" }, 400);

  const result = await resolveRecipient(c.env.DB, address);
  if (result.kind === "reject") {
    return c.json({ address, delivers: false, reason: result.code });
  }
  return c.json({
    address,
    delivers: true,
    reason: result.reason,
    mine: result.userId === c.get("user").id,
  });
});
