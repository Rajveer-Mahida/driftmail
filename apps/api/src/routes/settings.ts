import { Hono } from "hono";
import type { HonoEnv } from "../env.ts";
import type { SettingsResponse } from "@email/shared";
import {
  getReplyEnabled,
  setReplyEnabled,
  getComposeEnabled,
  setComposeEnabled,
} from "../settings.ts";
import { getUserSetting, setUserSetting, parseList } from "../config/user.ts";
import { listDomains, getPrimaryDomain } from "../config/domains.ts";
import { hasSecret } from "../config/secrets.ts";
import { scopeOf } from "../middleware.ts";

export const settings = new Hono<HonoEnv>();

settings.get("/", async (c) => {
  const db = c.env.DB;
  const uid = scopeOf(c);
  const user = c.get("user");

  const [blockRaw, allowRaw, signature, storedPrimary, domainRows, primary, cfToken] =
    await Promise.all([
      getUserSetting(db, uid, "block_remote_images"),
      getUserSetting(db, uid, "image_allowlist"),
      getUserSetting(db, uid, "signature"),
      getUserSetting(db, uid, "primary_domain"),
      listDomains(db),
      getPrimaryDomain(db),
      hasSecret(db, "cf.token"),
    ]);

  const domains = domainRows.map((d) => d.domain);
  const body: SettingsResponse = {
    reply_enabled: await getReplyEnabled(db),
    compose_enabled: await getComposeEnabled(db),
    // A personal choice, but only among domains this instance actually handles —
    // a stale value must not survive the domain being removed.
    primary_domain:
      storedPrimary && domains.includes(storedPrimary)
        ? storedPrimary
        : (primary?.domain ?? domains[0] ?? ""),
    domains,
    signature: signature ?? "",
    // Blocking is the default: an unread tracking pixel is still a disclosure.
    block_remote_images: blockRaw === null ? true : blockRaw === "1",
    image_allowlist: parseList(allowRaw),
    domain_management: cfToken,
    user,
  };
  return c.json(body);
});

settings.post("/", async (c) => {
  const db = c.env.DB;
  const uid = scopeOf(c);
  const isAdmin = c.get("user").role === "admin";

  const body = await c.req
    .json<{
      reply_enabled?: boolean;
      compose_enabled?: boolean;
      primary_domain?: string;
      signature?: string;
      block_remote_images?: boolean;
      allow_image_sender?: string;
    }>()
    .catch(() => ({}) as Record<string, never>);

  // Compose and reply are instance-wide kill switches, so only an admin flips
  // them; everything else below is the caller's own preference.
  if (typeof body.compose_enabled === "boolean") {
    if (!isAdmin) return c.json({ error: "forbidden" }, 403);
    await setComposeEnabled(db, body.compose_enabled);
    return c.json({ ok: true, compose_enabled: body.compose_enabled });
  }

  if (typeof body.reply_enabled === "boolean") {
    if (!isAdmin) return c.json({ error: "forbidden" }, 403);
    await setReplyEnabled(db, body.reply_enabled);
    return c.json({ ok: true, reply_enabled: body.reply_enabled });
  }

  if (typeof body.block_remote_images === "boolean") {
    await setUserSetting(db, uid, "block_remote_images", body.block_remote_images ? "1" : "0");
    return c.json({ ok: true });
  }

  if (typeof body.allow_image_sender === "string" && body.allow_image_sender.trim()) {
    const list = parseList(await getUserSetting(db, uid, "image_allowlist"));
    const addr = body.allow_image_sender.trim().toLowerCase();
    if (!list.includes(addr)) list.push(addr);
    await setUserSetting(db, uid, "image_allowlist", JSON.stringify(list));
    return c.json({ ok: true });
  }

  if (typeof body.signature === "string") {
    await setUserSetting(db, uid, "signature", body.signature);
    return c.json({ ok: true });
  }

  if (typeof body.primary_domain === "string") {
    const domains = (await listDomains(db)).map((d) => d.domain);
    if (!domains.includes(body.primary_domain)) {
      return c.json({ error: "Unknown domain" }, 400);
    }
    await setUserSetting(db, uid, "primary_domain", body.primary_domain);
    return c.json({ ok: true, primary_domain: body.primary_domain });
  }

  return c.json({ error: "No recognised setting in that request" }, 400);
});
