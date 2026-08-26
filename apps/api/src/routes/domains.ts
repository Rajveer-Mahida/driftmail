import { Hono } from "hono";
import type { Context } from "hono";
import type { HonoEnv } from "../env.ts";
import {
  CloudflareError,
  authHint,
  cfToken,
  enableRouting,
  disableCatchAll,
  disableRouting,
  getCatchAll,
  findDnsRecords,
  listZones,
  resolvePublic,
  routingDns,
  routingStatus,
  setCatchAllToWorker,
} from "../cloudflare.ts";
import { getConfig } from "../config/index.ts";
import {
  deleteDomain,
  getDomain,
  listDomains,
  listDns,
  recordDns,
  upsertDomain,
} from "../config/domains.ts";
import { requireAdmin } from "../middleware.ts";

export const domains = new Hono<HonoEnv>();

// Reconfiguring mail delivery affects every mailbox on the instance. Mounted
// here rather than as app.use("/api/domains/*"), which would not match the
// collection route itself and would leave GET /api/domains unguarded.
domains.use("*", requireAdmin());

/** Surface Cloudflare's own message; a permission problem should say so. */
function failure(c: Context<HonoEnv>, err: unknown) {
  if (err instanceof CloudflareError) {
    // Cloudflare's own wording for a catch-all pointed at a script that doesn't
    // exist. Without this hint the message reads like a Cloudflare outage rather
    // than a typo in the stored Worker name.
    const hint = /workers script.*not found/i.test(err.message)
      ? "The stored Worker name doesn't match any script in your account. Fix it at the Worker step of setup — it must match the name at the top of the Worker's dashboard page exactly."
      : authHint(err);
    return c.json({ error: err.message, hint }, err.status === 403 ? 403 : 502);
  }
  return c.json({ error: (err as Error)?.message ?? "Cloudflare request failed" }, 502);
}

/** Every route here needs the token; without one the whole feature is inert. */
async function tokenOr503(c: Context<HonoEnv>): Promise<string | Response> {
  const token = await cfToken(c.env);
  if (!token) {
    return c.json(
      { error: "Domain management isn't set up — add a Cloudflare API token in Settings." },
      503,
    );
  }
  return token;
}

/** The domains this instance already handles, with their stored state. */
domains.get("/", async (c) => {
  const rows = await listDomains(c.env.DB);
  const worker = await getConfig(c.env.DB, "instance.worker_name");
  return c.json({ worker, domains: rows });
});

/**
 * Zones the token can see, each annotated with what enabling routing would do.
 *
 * `currentMx` is the important part: enabling Email Routing REWRITES a zone's MX
 * records, so a domain currently receiving through Google or Fastmail would
 * silently stop. The UI has to be able to say so before anything happens.
 */
domains.get("/zones", async (c) => {
  const token = await tokenOr503(c);
  if (typeof token !== "string") return token;

  try {
    const accountId = (await getConfig(c.env.DB, "instance.cf_account_id")) || undefined;
    const zones = await listZones(token, accountId);
    const known = new Set((await listDomains(c.env.DB)).map((d) => d.domain));

    const annotated = await Promise.all(
      zones.map(async (z) => {
        const routing = await routingStatus(token, z.id).catch(() => ({ enabled: false }));
        const mx = await findDnsRecords(token, z.id, "MX", z.name).catch(() => []);
        const catchAll = await getCatchAll(token, z.id).catch(() => null);
        return {
          ...z,
          routing,
          added: known.has(z.name),
          // Anything that is not a Cloudflare Email Routing MX means mail for
          // this domain currently goes somewhere else.
          currentMx: mx.map((r) => r.content).filter((v) => !v.endsWith("mx.cloudflare.net")),
          catchAllTarget: catchAll?.actions?.[0]?.value?.[0] ?? null,
          /** Only a full zone is on Cloudflare DNS; otherwise records are manual. */
          managedDns: z.type === "full",
        };
      }),
    );
    return c.json({ zones: annotated });
  } catch (err) {
    return failure(c, err);
  }
});

/**
 * Add a domain: enable Email Routing, write the MX and SPF records, and point
 * the catch-all at this Worker.
 */
domains.post("/", async (c) => {
  const token = await tokenOr503(c);
  if (typeof token !== "string") return token;

  type AddDomainBody = {
    zoneId?: string;
    domain?: string;
    acceptAll?: boolean;
    allowedPattern?: string;
    aliasSuffix?: string;
    fallbackForwardTo?: string;
    forwardTo?: string;
    primary?: boolean;
    confirmOverwriteMx?: boolean;
  };
  const body = await c.req.json<AddDomainBody>().catch(() => ({}) as AddDomainBody);

  const zoneId = body.zoneId?.trim();
  const domain = body.domain?.trim().toLowerCase();
  if (!zoneId || !domain) return c.json({ error: "zoneId and domain are required" }, 400);

  const worker = await getConfig(c.env.DB, "instance.worker_name");
  if (!worker) {
    return c.json({ error: "This Worker's name hasn't been detected yet." }, 400);
  }

  try {
    // The one genuinely destructive step in the whole flow, so it gets said out
    // loud beforehand rather than discovered afterwards.
    const existingMx = (await findDnsRecords(token, zoneId, "MX", domain))
      .map((r) => r.content)
      .filter((v) => !v.endsWith("mx.cloudflare.net"));
    if (existingMx.length && !body.confirmOverwriteMx) {
      return c.json(
        {
          error: "mx_in_use",
          detail: `${domain} currently receives mail through another provider. Enabling Email Routing replaces these MX records.`,
          currentMx: existingMx,
        },
        409,
      );
    }

    // The settings read/enable pair uses a different permission than the rules
    // write in the account-token editor. A token that can only manage rules must
    // still be able to point the catch-all here — on a zone where routing is
    // already on (MX at Cloudflare), enabling would be a no-op anyway, and if it
    // is genuinely off the status poll's public-DNS check says so honestly.
    try {
      const status = await routingStatus(token, zoneId);
      if (!status.enabled) await enableRouting(token, zoneId);
    } catch (err) {
      if (!(err instanceof CloudflareError && (err.status === 403 || err.status === 401))) {
        throw err;
      }
    }
    await setCatchAllToWorker(token, zoneId, worker);

    // Denied for the same least-privilege tokens as above. The records list is
    // display sugar here — the status poll proves MX/SPF via public DNS, which
    // doesn't need the token at all.
    const records = await routingDns(token, zoneId).catch((err) => {
      if (err instanceof CloudflareError && (err.status === 403 || err.status === 401)) {
        return [];
      }
      throw err;
    });
    const row = await upsertDomain(c.env.DB, domain, {
      zone_id: zoneId,
      zone_name: domain,
      is_primary: body.primary ? 1 : undefined,
      routing_state: "pending_dns",
      catch_all_worker: worker,
      routing_error: null,
      accept_all: body.acceptAll === false ? 0 : 1,
      allowed_pattern: body.allowedPattern?.trim() || null,
      alias_suffix: body.aliasSuffix?.trim() || null,
      fallback_forward_to: body.fallbackForwardTo?.trim() || null,
      forward_to: body.forwardTo?.trim() || null,
    });

    await recordDns(
      c.env.DB,
      domain,
      "routing",
      records.map((r) => ({
        type: r.type,
        name: r.name,
        content: r.content,
        priority: r.priority ?? null,
        status: "written" as const,
        managed: true,
      })),
    );

    return c.json({ ok: true, domain: row, worker, records });
  } catch (err) {
    await upsertDomain(c.env.DB, domain, {
      routing_state: "error",
      routing_error: (err as Error)?.message ?? "failed",
    }).catch(() => {});
    return failure(c, err);
  }
});

/**
 * Is this domain actually receiving yet?
 *
 * Three independent checks, because each can be true while the others are not:
 * Cloudflare's own view of routing, whether the catch-all still points here, and
 * what public DNS resolves — which is the only one that proves mail will arrive.
 */
domains.get("/:domain/status", async (c) => {
  const name = c.req.param("domain").toLowerCase();
  const row = await getDomain(c.env.DB, name);
  if (!row) return c.json({ error: "not found" }, 404);

  const token = await cfToken(c.env);
  const worker = await getConfig(c.env.DB, "instance.worker_name");

  let routing: { enabled: boolean; status?: string } = { enabled: false };
  let catchAllOk = false;

  if (token && row.zone_id) {
    routing = await routingStatus(token, row.zone_id).catch(() => ({ enabled: false }));
    // Worth re-checking on every poll: the catch-all is the one piece of this
    // that a person can silently undo from the Cloudflare dashboard.
    const rule = await getCatchAll(token, row.zone_id).catch(() => null);
    catchAllOk = !!rule?.enabled && rule.actions?.[0]?.value?.[0] === worker;
  }

  const [mx, spf] = await Promise.all([
    resolvePublic(name, "MX").catch(() => []),
    resolvePublic(name, "TXT").catch(() => []),
  ]);
  const mxLive = mx.some((v) => v.includes("mx.cloudflare.net"));
  const spfLive = spf.some((v) => v.includes("_spf.mx.cloudflare.net"));

  const state = mxLive && catchAllOk ? "ready" : routing.enabled ? "pending_dns" : "none";
  if (state !== row.routing_state) {
    await upsertDomain(c.env.DB, name, { routing_state: state, last_checked_at: Date.now() });
  }

  return c.json({
    domain: name,
    routing_state: state,
    catch_all_ok: catchAllOk,
    worker,
    records: await listDns(c.env.DB, name, "routing"),
    checks: { mx_live: mxLive, spf_live: spfLive, observed_mx: mx },
  });
});

/** Promote a domain to primary; the incumbent is demoted automatically by the
 *  partial unique index handling in upsertDomain. */
domains.post("/:domain/primary", async (c) => {
  const name = c.req.param("domain").toLowerCase();
  if (!(await getDomain(c.env.DB, name))) return c.json({ error: "not found" }, 404);
  await upsertDomain(c.env.DB, name, { is_primary: 1 });
  return c.json({ ok: true, primary: name });
});

domains.delete("/:domain", async (c) => {
  const name = c.req.param("domain").toLowerCase();
  const row = await getDomain(c.env.DB, name);
  if (!row) return c.json({ error: "not found" }, 404);

  // Removing the last domain makes the instance deaf — no address anywhere can
  // reach it. Strictly refused, with no override: like the last administrator,
  // the way out is to add another first, not to confirm harder.
  const all = await listDomains(c.env.DB);
  if (all.length === 1) {
    return c.json(
      {
        error: "last_domain",
        detail:
          "This is the only domain — removing it would stop ALL mail to this inbox. Add another domain first.",
      },
      409,
    );
  }

  // The primary is the instance's default — fallback sender, alias generation.
  // Removing it out from under those is refused the same way: promote another
  // domain first, then this one becomes removable.
  if (row.is_primary === 1) {
    return c.json(
      {
        error: "primary_domain",
        detail: "This is the primary domain. Make another domain primary first, then remove it.",
      },
      409,
    );
  }

  const token = await cfToken(c.env);
  // The row must not be deleted while Cloudflare still delivers here: the
  // resolver would reject every message — a bounce storm, observed live. So
  // Cloudflare is detached FIRST, and only best-effort within what the token
  // can do: disabling routing needs the settings permission a least-privilege
  // token lacks, in which case the catch-all rule (which such a token can
  // always edit — it created it) is disabled instead.
  let detached = false;
  if (token && row.zone_id) {
    detached = await disableRouting(token, row.zone_id).then(
      () => true,
      () => false,
    );
    if (!detached) {
      detached = await disableCatchAll(token, row.zone_id).then(
        () => true,
        () => false,
      );
    }
  }
  await deleteDomain(c.env.DB, name);
  return c.json({
    ok: true,
    detached,
    ...(detached
      ? {}
      : {
          warning:
            "Cloudflare could not be updated, so it may still route this domain's mail here — and it will bounce. Check the zone's Email Routing in the dashboard.",
        }),
  });
});
