// Configuring outbound mail: which provider, and getting the domain verified.

import { Hono } from "hono";
import type { HonoEnv } from "../env.ts";
import { setConfig } from "../config/index.ts";
import { getSecret, reveal, setSecret } from "../config/secrets.ts";
import {
  getDomain,
  getPrimaryDomain,
  listDns,
  upsertDomain,
  type SendProviderName,
} from "../config/domains.ts";
import { cfToken, enableSending, listSendingSubdomains } from "../cloudflare.ts";
import {
  findOrCreateResendDomain,
  getResendDomain,
  reconcileDns,
  saveSendingDns,
  verifyResendDomain,
} from "../send/resend-dns.ts";
import { sendMail, resolveFrom, SendError } from "../send/index.ts";
import { requireAdmin } from "../middleware.ts";

export const sending = new Hono<HonoEnv>();

// Choosing how the instance sends is an instance-wide decision.
sending.use("*", requireAdmin());

async function targetDomain(c: { env: { DB: D1Database } }, name?: string) {
  if (name) return getDomain(c.env.DB, name);
  return getPrimaryDomain(c.env.DB);
}

sending.post("/", async (c) => {
  const body = await c.req
    .json<{ provider?: SendProviderName; apiKey?: string; domain?: string; subdomain?: string }>()
    .catch(() => ({}) as Record<string, never>);

  const provider = body.provider;
  if (!provider || !["resend", "cloudflare", "none"].includes(provider)) {
    return c.json({ error: "provider must be resend, cloudflare or none" }, 400);
  }

  if (provider === "none") {
    await setConfig(c.env.DB, { "send.provider": "none" });
    return c.json({ ok: true, provider, send_state: "none", records: [], manual: false });
  }

  const domain = await targetDomain(c, body.domain);
  if (!domain) {
    return c.json({ error: "Add a mail domain before setting up sending." }, 400);
  }

  // ── Resend ──
  if (provider === "resend") {
    const key = body.apiKey?.trim();
    if (!key) return c.json({ error: "A Resend API key is required" }, 400);

    let resendDomain;
    try {
      // Doubles as validation: a bad key fails here, before anything is stored.
      resendDomain = await findOrCreateResendDomain(key, domain.domain);
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 401 || status === 403) {
        return c.json({ error: "Resend rejected that API key." }, 401);
      }
      return c.json({ error: (err as Error).message }, 502);
    }

    await setSecret(c.env.DB, c.env, "resend.api_key", key);
    await setConfig(c.env.DB, { "send.provider": "resend" });

    const wanted = (resendDomain.records ?? []).map((r) => ({
      type: r.type.toUpperCase(),
      name: r.name,
      content: r.value,
      priority: r.priority,
    }));

    const token = await cfToken(c.env);
    let results;
    let manual = true;

    if (token && domain.zone_id && domain.zone_type !== "partial") {
      results = await reconcileDns(token, domain.zone_id, wanted, new Set());
      manual = false;
    } else {
      // No token, or the zone isn't on Cloudflare DNS: show the records instead
      // of pretending to have written them.
      results = wanted.map((r) => ({
        ...r,
        priority: r.priority ?? null,
        status: "pending" as const,
        managed: false,
      }));
    }

    await saveSendingDns(c.env.DB, domain.domain, results);
    if (!manual) await verifyResendDomain(key, resendDomain.id).catch(() => {});

    const state = results.some((r) => r.status === "failed" || r.status === "conflict")
      ? "pending_dns"
      : manual
        ? "pending_dns"
        : "verifying";

    await upsertDomain(c.env.DB, domain.domain, {
      send_provider: "resend",
      send_state: state,
      send_identity: resendDomain.id,
      send_error: null,
    });

    return c.json({ ok: true, provider, send_state: state, records: results, manual });
  }

  // ── Cloudflare ──
  const token = await cfToken(c.env);
  if (!token || !domain.zone_id) {
    return c.json({ error: "Cloudflare sending needs a stored API token." }, 400);
  }

  try {
    const existing = await listSendingSubdomains(token, domain.zone_id);
    const subdomain =
      existing[0] ?? (await enableSending(token, domain.zone_id, body.subdomain ?? "cf-bounce"));

    await setConfig(c.env.DB, { "send.provider": "cloudflare" });
    await upsertDomain(c.env.DB, domain.domain, {
      send_provider: "cloudflare",
      // Cloudflare writes and manages its own records on a zone it hosts, so
      // there is nothing for us to reconcile here.
      send_state: "verified",
      send_identity: subdomain.name,
      send_error: null,
    });

    return c.json({
      ok: true,
      provider,
      send_state: "verified",
      records: await listDns(c.env.DB, domain.domain, "sending"),
      manual: false,
    });
  } catch (err) {
    await upsertDomain(c.env.DB, domain.domain, {
      send_state: "failed",
      send_error: (err as Error).message,
    });
    return c.json({ error: (err as Error).message }, 502);
  }
});

/** Poll target while a domain is verifying. */
sending.get("/status", async (c) => {
  const domain = await targetDomain(c, c.req.query("domain"));
  if (!domain) return c.json({ error: "not found" }, 404);

  if (domain.send_provider === "resend" && domain.send_identity) {
    const key = await getSecret(c.env.DB, c.env, "resend.api_key");
    if (key) {
      try {
        const remote = await getResendDomain(reveal(key), domain.send_identity);
        // `temporary_failure` means DNS hasn't propagated yet, not that anything
        // is wrong — keep waiting rather than reporting a failure.
        const state =
          remote.status === "verified"
            ? "verified"
            : remote.status === "failed"
              ? "failed"
              : "verifying";
        if (state !== domain.send_state) {
          await upsertDomain(c.env.DB, domain.domain, { send_state: state });
        }
        return c.json({
          provider: "resend",
          send_state: state,
          records: await listDns(c.env.DB, domain.domain, "sending"),
          detail: remote.status,
        });
      } catch {
        /* fall through to the stored state */
      }
    }
  }

  return c.json({
    provider: domain.send_provider ?? "none",
    send_state: domain.send_state,
    records: await listDns(c.env.DB, domain.domain, "sending"),
    detail: domain.send_error ?? undefined,
  });
});

/** Prove it end to end, rather than trusting the provider's own status. */
sending.post("/test", async (c) => {
  const { to } = await c.req.json<{ to?: string }>().catch(() => ({}) as { to?: string });
  const target = to?.trim() || c.get("user").email;

  try {
    const from = await resolveFrom(c.env.DB, {});
    const result = await sendMail(c.env, {
      from,
      to: [target],
      subject: "Driftmail is set up",
      text: "If you're reading this, sending works.",
    });
    return c.json({ ok: true, messageId: result.messageId, provider: result.provider });
  } catch (err) {
    if (err instanceof SendError) return c.json(err.toJSON(), 502);
    return c.json({ error: (err as Error).message }, 502);
  }
});
