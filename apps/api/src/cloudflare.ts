// Cloudflare REST client, for configuring this instance's own mail delivery.
//
// The token is supplied by the operator through the setup wizard and stored in
// D1, rather than being a Worker secret, so the whole instance can be set up
// from a browser with no CLI involved.
//
// Scopes the token needs:
//   Account · Workers Scripts   · Read   detect this Worker's own name, and prove
//                                        the token belongs to the account running it
//   Zone    · Zone              · Read   list the domains to choose from
//   Zone    · Email Routing Rules     · Edit   point the catch-all at this Worker
//   Zone    · Email Routing Addresses · Edit   verify forwarding destinations
//   Zone    · DNS               · Edit   write the MX, SPF and DKIM records
//   Zone    · DNS Settings      · Edit   Email Routing locks its own records
//
// Raw fetch, same style as ai.ts — no SDK.

import type { Env } from "./env.ts";
import { getSecret, reveal } from "./config/secrets.ts";

const API = "https://api.cloudflare.com/client/v4";

export class CloudflareError extends Error {
  readonly status: number;
  readonly codes: number[];
  constructor(status: number, message: string, codes: number[] = []) {
    super(message);
    this.name = "CloudflareError";
    this.status = status;
    this.codes = codes;
  }
}

/** The stored API token, or null when domain management has not been set up. */
export async function cfToken(env: Env): Promise<string | null> {
  const stored = await getSecret(env.DB, env, "cf.token");
  return stored ? reveal(stored).trim() || null : null;
}

export async function domainManagementEnabled(env: Env): Promise<boolean> {
  return (await cfToken(env)) !== null;
}

type CfResponse<T> = {
  success: boolean;
  result: T;
  errors?: Array<{ code: number; message: string }>;
};

/** Turn Cloudflare's error codes into something a person can act on. */
export function authHint(err: CloudflareError): string | undefined {
  if (err.codes.includes(9109) || err.codes.includes(6003)) {
    return "Cloudflare rejected the token itself. Paste the token value, not its ID, and check it hasn't expired.";
  }
  if (err.codes.includes(10000) || err.status === 403) {
    return (
      "The token is valid, but is missing a permission this step needs — most " +
      "often Account \u00b7 Workers Scripts \u00b7 Read, which is what proves the " +
      "token's account runs this Worker. Also check the zone is listed under the " +
      "token's Zone Resources."
    );
  }
  if (err.codes.includes(7404)) {
    return "That zone isn't in this Cloudflare account.";
  }
  return undefined;
}

export async function cf<T>(
  token: string,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: init?.method ?? "GET",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });

  let json: CfResponse<T> | null = null;
  try {
    json = (await res.json()) as CfResponse<T>;
  } catch {
    /* non-JSON error body */
  }

  if (!res.ok || !json?.success) {
    // Cloudflare's own messages are specific and worth surfacing verbatim —
    // "token lacks permission X" beats any generic failure we could invent.
    const detail = json?.errors?.map((e) => e.message).join("; ");
    throw new CloudflareError(
      res.status,
      detail || `Cloudflare API returned ${res.status}`,
      json?.errors?.map((e) => e.code) ?? [],
    );
  }
  return json.result;
}

/**
 * Does this endpoint answer 200, whatever it answers with?
 *
 * `cf()` parses every response as JSON, which is wrong for the handful of
 * Cloudflare endpoints that don't return it — fetching a Worker script hands
 * back the script bundle as multipart/form-data, so parsing it threw and the
 * caller read a perfectly good 200 as "not found".
 */
export async function scriptExists(
  token: string,
  accountId: string,
  name: string,
): Promise<boolean> {
  return cfOk(token, `/accounts/${accountId}/workers/scripts/${encodeURIComponent(name)}`);
}

async function cfOk(token: string, path: string): Promise<boolean> {
  const res = await fetch(`${API}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.ok) return true;
  if (res.status === 404) return false;

  // Anything else — 401, 403 — is the token being refused, which the caller
  // must be able to tell apart from the script genuinely not existing.
  let codes: number[] = [];
  let detail = `Cloudflare API returned ${res.status}`;
  try {
    const json = (await res.json()) as CfResponse<unknown>;
    codes = json.errors?.map((e) => e.code) ?? [];
    detail = json.errors?.map((e) => e.message).join("; ") || detail;
  } catch {
    /* non-JSON error body */
  }
  throw new CloudflareError(res.status, detail, codes);
}

/** Bind a token once, so call sites read as operations rather than plumbing. */
export function client(token: string) {
  return <T>(path: string, init?: { method?: string; body?: unknown }) => cf<T>(token, path, init);
}

// ── ownership proof and worker detection ─────────────────────────────────────

export type Account = { id: string; name: string };
export type WorkerIdentity = {
  accountId: string;
  accountName: string;
  workerName: string;
  /** How the Worker was identified. "local" means the ownership check was
   *  skipped for local development — see localDevIdentity(). */
  source: "custom_domain" | "workers_dev" | "local";
  /** The zone this Worker is served from, when it runs on a custom domain.
   *  A domain in that zone is the natural default at the domain step. */
  zoneId?: string;
  zoneName?: string;
};

export async function listAccounts(token: string): Promise<Account[]> {
  return cf<Account[]>(token, "/accounts?per_page=50");
}

/**
 * Prove that this token's Cloudflare account is the one running the Worker that
 * served this request — and learn the Worker's own script name while doing it.
 *
 * This is the claim guard. An attacker who finds an unclaimed instance cannot
 * produce a token on the owner's account; if they could, they would already
 * control the Worker and would not need to claim anything.
 *
 * It doubles as the detection that lets CF_WORKER_NAME disappear: a Worker
 * cannot read its own script name, but the account can be asked what is serving
 * this hostname.
 */
export async function identifyWorker(
  token: string,
  hostname: string,
  accountIds?: string[],
): Promise<WorkerIdentity | null> {
  let accounts: Account[];
  if (accountIds?.length) {
    accounts = accountIds.map((id) => ({ id, name: id }));
  } else {
    accounts = await listAccounts(token);
  }

  // A probe can fail two very different ways: the Worker genuinely isn't there,
  // or the token isn't allowed to look. Reporting the second as the first sends
  // people off to check which Cloudflare account they used, when the real answer
  // is one missing permission — so the two are tracked apart.
  let denied = false;

  for (const account of accounts) {
    // (a) a custom domain — exact, and it hands back the zone as well.
    try {
      const domains = await cf<
        Array<{ id: string; zone_id: string; zone_name: string; hostname: string; service: string }>
      >(token, `/accounts/${account.id}/workers/domains?hostname=${encodeURIComponent(hostname)}`);
      const match = domains.find((d) => d.hostname.toLowerCase() === hostname.toLowerCase());
      if (match) {
        return {
          accountId: account.id,
          accountName: account.name,
          workerName: match.service,
          source: "custom_domain",
          zoneId: match.zone_id,
          zoneName: match.zone_name,
        };
      }
    } catch (err) {
      // A token scoped to one zone may be refused here; try the other route.
      if (isPermissionError(err)) denied = true;
    }

    // (b) a workers.dev hostname — <script>.<subdomain>.workers.dev
    try {
      const { subdomain } = await cf<{ subdomain: string }>(
        token,
        `/accounts/${account.id}/workers/subdomain`,
      );
      const suffix = `.${subdomain}.workers.dev`;
      if (subdomain && hostname.toLowerCase().endsWith(suffix)) {
        const label = hostname.slice(0, -suffix.length);
        const script = await resolveScriptLabel(token, account.id, label);
        if (script.denied) denied = true;
        if (script.name) {
          return {
            accountId: account.id,
            accountName: account.name,
            workerName: script.name,
            source: "workers_dev",
          };
        }
      }
    } catch (err) {
      if (isPermissionError(err)) denied = true;
      /* try the next account */
    }
  }

  // Nothing matched, and every attempt to look was refused — so this says
  // nothing about ownership. Surface the actual problem instead.
  if (denied) {
    throw new CloudflareError(
      403,
      "This token can't read Workers, so there's no way to check which Worker serves this hostname.",
      [10000],
    );
  }
  return null;
}

function isPermissionError(err: unknown): boolean {
  return (
    err instanceof CloudflareError &&
    (err.status === 401 || err.status === 403 || err.codes.includes(10000))
  );
}

/**
 * The local-development stand-in for identifyWorker().
 *
 * On localhost there is no hostname Cloudflare could be asked about, so the
 * ownership half of the proof is impossible. This still validates that the token
 * is real and usable — a typo'd token fails here rather than being stored and
 * failing confusingly at the domain step — but it establishes nothing about who
 * owns anything.
 *
 * Callers MUST gate this on both a loopback hostname and an explicit opt-in;
 * see the claim route. The Host header is attacker-controlled, so the hostname
 * alone is not a security boundary.
 */
export async function localDevIdentity(
  token: string,
  accountIds?: string[],
): Promise<WorkerIdentity | null> {
  const accounts = accountIds?.length
    ? accountIds.map((id) => ({ id, name: id }))
    : await listAccounts(token);
  const account = accounts[0];
  if (!account) return null;

  return {
    accountId: account.id,
    accountName: account.name,
    // Undetectable locally, so the wizard asks for it at the next step.
    workerName: "",
    source: "local",
  };
}

/**
 * Turn a workers.dev label into a real script name.
 *
 * Version preview URLs are `<prefix>-<script>.<subdomain>.workers.dev`, so the
 * label is not always the script name. Accepting a wrong one is worse than
 * failing: the catch-all would point at a Worker that does not exist, Cloudflare
 * would accept the mail, and it would be delivered nowhere — silently.
 */
async function resolveScriptLabel(
  token: string,
  accountId: string,
  label: string,
): Promise<{ name: string | null; denied: boolean }> {
  const candidates = [label];
  const dash = label.indexOf("-");
  if (dash > 0) candidates.push(label.slice(dash + 1));

  let denied = false;
  for (const name of candidates) {
    try {
      if (await cfOk(token, `/accounts/${accountId}/workers/scripts/${encodeURIComponent(name)}`)) {
        return { name, denied: false };
      }
    } catch (err) {
      // A refusal is not the same as "no such script", and the caller needs to
      // report the two differently.
      if (isPermissionError(err)) denied = true;
    }
  }
  return { name: null, denied };
}

// ── zones ────────────────────────────────────────────────────────────────────

export type Zone = {
  id: string;
  name: string;
  status: string;
  /** "full" means the zone is on Cloudflare DNS, so records can be written for
   *  the operator. Anything else means manual DNS. */
  type?: string;
};

export async function listZones(token: string, accountId?: string): Promise<Zone[]> {
  const q = new URLSearchParams({ per_page: "50", status: "active" });
  if (accountId) q.set("account.id", accountId);
  const zones = await cf<Zone[]>(token, `/zones?${q}`);
  return zones.map((z) => ({ id: z.id, name: z.name, status: z.status, type: z.type }));
}

export type RoutingStatus = { enabled: boolean; name?: string; status?: string };

export async function routingStatus(token: string, zoneId: string): Promise<RoutingStatus> {
  try {
    const r = await cf<RoutingStatus>(token, `/zones/${zoneId}/email/routing`);
    return { enabled: !!r.enabled, name: r.name, status: r.status };
  } catch (err) {
    // Never-onboarded zones 404 here; that's "not enabled", not an error.
    if (err instanceof CloudflareError && err.status === 404) return { enabled: false };
    throw err;
  }
}

export type DnsRecord = {
  id?: string;
  type: string;
  name: string;
  content: string;
  priority?: number;
};

export async function routingDns(token: string, zoneId: string): Promise<DnsRecord[]> {
  try {
    return await cf<DnsRecord[]>(token, `/zones/${zoneId}/email/routing/dns`);
  } catch (err) {
    if (err instanceof CloudflareError && err.status === 404) return [];
    throw err;
  }
}

/** Enable Email Routing — this is what adds and locks the MX + SPF records. */
export async function enableRouting(token: string, zoneId: string): Promise<void> {
  await cf(token, `/zones/${zoneId}/email/routing/enable`, { method: "POST", body: {} });
}

export async function disableRouting(token: string, zoneId: string): Promise<void> {
  await cf(token, `/zones/${zoneId}/email/routing/disable`, { method: "POST", body: {} });
}

export type CatchAllRule = {
  enabled: boolean;
  actions?: Array<{ type: string; value?: string[] }>;
};

export async function getCatchAll(token: string, zoneId: string): Promise<CatchAllRule | null> {
  try {
    return await cf<CatchAllRule>(token, `/zones/${zoneId}/email/routing/rules/catch_all`);
  } catch (err) {
    if (err instanceof CloudflareError && err.status === 404) return null;
    throw err;
  }
}

/**
 * Point the catch-all at this Worker, so every address on the zone lands here.
 *
 * This deliberately goes over REST rather than through wrangler: the CLI rejects
 * `--action-type worker` for catch-all rules with "Catch-all rule only supports
 * 'forward' or 'drop' action types", which is wrong — both the REST API and the
 * dashboard allow it.
 */
export async function setCatchAllToWorker(
  token: string,
  zoneId: string,
  worker: string,
): Promise<void> {
  await cf(token, `/zones/${zoneId}/email/routing/rules/catch_all`, {
    method: "PUT",
    body: {
      name: "Driftmail catch-all",
      enabled: true,
      matchers: [{ type: "all" }],
      actions: [{ type: "worker", value: [worker] }],
    },
  });
}

// ── outbound sending ─────────────────────────────────────────────────────────

export type SendingSubdomain = { tag?: string; name: string; dkim_selector?: string };

/**
 * Onboard a subdomain for Cloudflare Email Sending.
 *
 * The endpoint requires a `name`; posting an empty body — which an earlier
 * version of this file did, swallowing the error — silently achieved nothing and
 * left sending broken with no trace.
 */
export async function enableSending(
  token: string,
  zoneId: string,
  name = "cf-bounce",
): Promise<SendingSubdomain> {
  return cf<SendingSubdomain>(token, `/zones/${zoneId}/email/sending/subdomains`, {
    method: "POST",
    body: { name },
  });
}

export async function listSendingSubdomains(
  token: string,
  zoneId: string,
): Promise<SendingSubdomain[]> {
  try {
    return await cf<SendingSubdomain[]>(token, `/zones/${zoneId}/email/sending/subdomains`);
  } catch (err) {
    if (err instanceof CloudflareError && err.status === 404) return [];
    throw err;
  }
}

// ── DNS records ──────────────────────────────────────────────────────────────

export async function findDnsRecords(
  token: string,
  zoneId: string,
  type: string,
  name: string,
): Promise<DnsRecord[]> {
  const q = new URLSearchParams({ type, name, per_page: "50" });
  return cf<DnsRecord[]>(token, `/zones/${zoneId}/dns_records?${q}`);
}

export async function createDnsRecord(
  token: string,
  zoneId: string,
  record: { type: string; name: string; content: string; priority?: number },
): Promise<DnsRecord> {
  return cf<DnsRecord>(token, `/zones/${zoneId}/dns_records`, {
    method: "POST",
    body: { ...record, ttl: 1, proxied: false },
  });
}

export async function updateDnsRecord(
  token: string,
  zoneId: string,
  recordId: string,
  record: { type: string; name: string; content: string; priority?: number },
): Promise<DnsRecord> {
  return cf<DnsRecord>(token, `/zones/${zoneId}/dns_records/${recordId}`, {
    method: "PATCH",
    body: { ...record, ttl: 1, proxied: false },
  });
}

// ── independent propagation check ────────────────────────────────────────────

/**
 * Ask public DNS what the world actually sees.
 *
 * Cloudflare's API will report a record as created the instant it is written;
 * that is not the same as it being resolvable, and "we made the record" is not
 * the claim the wizard should make to the operator.
 */
export async function resolvePublic(
  name: string,
  type: "MX" | "TXT" | "CNAME",
): Promise<string[]> {
  const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`;
  const res = await fetch(url, { headers: { accept: "application/dns-json" } });
  if (!res.ok) return [];
  const json = (await res.json()) as { Answer?: Array<{ data: string }> };
  return (json.Answer ?? []).map((a) => a.data.replace(/^"|"$/g, ""));
}

// ── token capability probe ───────────────────────────────────────────────────

export type CapabilityId =
  | "workers.read"
  | "zone.read"
  | "email_routing.read"
  | "dns.read"
  | "email_addresses.read";

export type Capability = {
  id: CapabilityId;
  /** Exactly as Cloudflare labels it in the token editor. */
  group: "Account" | "Zone";
  permission: string;
  level: "Read" | "Edit";
  /** What breaks without it, in the user's terms. */
  why: string;
  /** Whether setup can proceed at all without it. */
  required: boolean;
  ok: boolean;
  detail?: string;
};

/**
 * What can this token actually do?
 *
 * Cloudflare has no API that enumerates a token's own permissions, so each one
 * is probed by making the cheapest read the app would make anyway. That means
 * an "Edit" permission can only be checked as far as its read half — a token
 * with Read but not Edit passes here and fails later at the write. Said plainly
 * in `detail` rather than glossed over, because a green tick that means "maybe"
 * is worse than an honest "checked as far as we can".
 */
export async function probeToken(
  token: string,
  scope: { accountId?: string; zoneId?: string } = {},
): Promise<Capability[]> {
  const checks: Array<Omit<Capability, "ok" | "detail"> & { run: () => Promise<unknown> }> = [
    {
      id: "zone.read",
      group: "Zone",
      permission: "Zone",
      level: "Read",
      why: "list the domains you can choose from",
      required: true,
      run: () => cf(token, "/zones?per_page=1"),
    },
    {
      id: "workers.read",
      group: "Account",
      permission: "Workers Scripts",
      level: "Read",
      why: "prove this token's account runs this Worker, and find its name",
      required: true,
      run: async () => {
        const id = scope.accountId ?? (await listAccounts(token))[0]?.id;
        if (!id) throw new CloudflareError(403, "No account is visible to this token");
        return cf(token, `/accounts/${id}/workers/subdomain`);
      },
    },
    {
      id: "email_routing.read",
      group: "Zone",
      permission: "Email Routing Rules",
      level: "Edit",
      why: "point your domain's catch-all at this Worker",
      required: true,
      // Probe the RULES endpoint, because that is what the app writes (the
      // catch-all is a rule). The neighbouring settings endpoint,
      // /zones/{z}/email/routing, is governed by a different permission in the
      // account-token editor — probing it marked a correctly-built token as
      // missing "Email Routing Rules".
      run: () =>
        zoneScoped(token, scope.zoneId, (z) =>
          cf(token, `/zones/${z}/email/routing/rules?per_page=1`),
        ),

    },
    {
      id: "dns.read",
      group: "Zone",
      permission: "DNS",
      level: "Edit",
      why: "write the MX and SPF records for you",
      required: false,
      run: () =>
        zoneScoped(token, scope.zoneId, (z) => cf(token, `/zones/${z}/dns_records?per_page=1`)),
    },
    {
      id: "email_addresses.read",
      // ACCOUNT, not Zone. Destination addresses are account-wide in Cloudflare,
      // and its token editor only offers this permission under Account. Probing
      // a /zones/.../addresses path answered 404 — an endpoint that does not
      // exist — which the 404-tolerant zone probe then read as a pass.
      group: "Account",
      permission: "Email Routing Addresses",
      level: "Edit",
      why: "verify forwarding destinations",
      required: false,
      run: async () => {
        const id = scope.accountId ?? (await listAccounts(token))[0]?.id;
        if (!id) throw new CloudflareError(403, "No account is visible to this token");
        return cf(token, `/accounts/${id}/email/routing/addresses?per_page=1`);
      },
    },
  ];

  return Promise.all(
    checks.map(async ({ run, ...meta }) => {
      try {
        const note = await run();
        return {
          ...meta,
          ok: true,
          // Never claim more than was actually tested: an Edit permission is only
          // ever probed as far as its read half.
          detail:
            typeof note === "string"
              ? note
              : meta.level === "Edit"
                ? "Read access confirmed; the write is attempted when you add a domain."
                : undefined,
        };
      } catch (err) {
        const message =
          err instanceof CloudflareError ? err.message : ((err as Error)?.message ?? "failed");
        return { ...meta, ok: false, detail: message };
      }
    }),
  );
}

/**
 * Run a zone-scoped probe.
 *
 * With a specific zone, that zone is the answer. Without one — which is the case
 * on the Cloudflare step, before a domain has been chosen — every visible zone is
 * tried, and the permission counts as present if ANY of them allows it.
 *
 * Testing only the first zone was wrong in a way that mattered: a token with
 * Zone:Read across the account but Email Routing scoped to one domain would be
 * reported as missing Email Routing entirely, sending people to widen a token
 * that was already correct.
 */
async function zoneScoped(
  token: string,
  zoneId: string | undefined,
  run: (zoneId: string) => Promise<unknown>,
): Promise<string | undefined> {
  const zones = zoneId
    ? [{ id: zoneId, name: zoneId }]
    : (await listZones(token)).map((z) => ({ id: z.id, name: z.name }));
  if (!zones.length) throw new CloudflareError(403, "No zone is visible to this token");

  const allowed: string[] = [];
  let lastError: unknown = null;

  for (const zone of zones) {
    try {
      await run(zone.id);
      allowed.push(zone.name);
    } catch (err) {
      // A zone whose Email Routing was never touched 404s on that endpoint.
      // That is a state, not a refusal, so it counts as allowed — which is only
      // safe because every URL probed here is known to exist. A 404 from a
      // wrong URL would otherwise read as success.
      if (err instanceof CloudflareError && err.status === 404) {
        allowed.push(zone.name);
        continue;
      }
      lastError = err;
    }
  }

  if (!allowed.length) {
    // Name what was tried. "Denied" alone leaves someone guessing whether the
    // permission is absent or simply not granted on the domain they want.
    const names = zones.map((z) => z.name).join(", ");
    const because = lastError instanceof CloudflareError ? ` (${lastError.message})` : "";
    throw new CloudflareError(
      403,
      `Denied on every domain this token can see — ${names}${because}. ` +
        `Check the token's Zone Resources includes the domain you'll use for mail.`,
      lastError instanceof CloudflareError ? lastError.codes : [],
    );
  }
  if (allowed.length === zones.length) return undefined;
  // A partial pass is the normal, correct shape for a well-scoped token — say
  // which domains it covers so the choice at the next step is informed.
  return `Allowed on ${allowed.length} of ${zones.length} domains: ${allowed.join(", ")}`;
}

/** The script names in an account — so a fallback Worker-name prompt can offer
 *  the real options instead of a free-text field that invites typos. */
export async function listScripts(token: string, accountId: string): Promise<string[]> {
  const scripts = await cf<Array<{ id: string }>>(
    token,
    `/accounts/${accountId}/workers/scripts`,
  );
  return scripts.map((s) => s.id);
}
