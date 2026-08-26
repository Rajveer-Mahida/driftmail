// Setup-wizard client. Kept separate from api/client.ts because these are the
// only endpoints reachable before the instance has an owner.

import { ApiError } from "./client";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "include",
    headers: init?.body ? { "content-type": "application/json" } : undefined,
    ...init,
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON */
  }
  if (!res.ok) {
    const body = (json ?? {}) as { error?: string; detail?: string; hint?: string };
    // Prefer the detail, then the hint: both are written for a person, whereas
    // `error` is often a machine code the wizard branches on.
    const message = body.detail ?? body.hint ?? body.error ?? res.statusText;
    const err = new ApiError(res.status, message);
    (err as ApiError & { code?: string; body?: unknown }).code = body.error;
    (err as ApiError & { body?: unknown }).body = json;
    throw err;
  }
  return json as T;
}

const post = (data: unknown) =>
  ({ method: "POST", body: JSON.stringify(data) }) satisfies RequestInit;

export type SetupStep =
  | "welcome"
  | "cloudflare"
  | "worker"
  | "domain"
  | "routing"
  | "sending"
  | "extras"
  | "done";

export type SetupStatus = {
  claimed: boolean;
  complete: boolean;
  step: SetupStep;
  skipped?: string[];
  requires?: "cf_token" | "setup_token" | "either";
  hostname?: string;
};

export type ClaimRequest = {
  cfToken?: string;
  setupToken?: string;
  accountId?: string;
  email: string;
  handle?: string;
  password: string;
};

export type ClaimResponse = {
  ok: true;
  worker: { name: string; source: string };
  account: { id: string; name: string } | null;
  servingZone: { id: string; name: string } | null;
  adopted: Record<string, number>;
  nextStep: SetupStep;
};

export type SetupZone = {
  id: string;
  name: string;
  status: string;
  type?: string;
  routing: { enabled: boolean };
  added: boolean;
  /** Non-Cloudflare MX records this domain currently uses. Non-empty means
   *  enabling Email Routing would take mail away from another provider. */
  currentMx: string[];
  catchAllTarget: string | null;
  managedDns: boolean;
};

export type DnsRow = {
  type: string;
  name: string;
  content: string;
  priority: number | null;
  status: "pending" | "written" | "live" | "conflict" | "failed";
};

export type DomainStatus = {
  domain: string;
  routing_state: "none" | "enabling" | "pending_dns" | "ready" | "error";
  catch_all_ok: boolean;
  worker: string;
  records: DnsRow[];
  checks: { mx_live: boolean; spf_live: boolean; observed_mx: string[] };
};

export type Capability = {
  id: string;
  group: "Account" | "Zone";
  permission: string;
  level: "Read" | "Edit";
  why: string;
  required: boolean;
  ok: boolean;
  detail?: string;
};

export type TokenCheck = {
  capabilities: Capability[];
  /** True when nothing REQUIRED is missing; optional gaps still allow setup. */
  ok: boolean;
  missingRequired: string[];
};

export const setupApi = {
  checkToken: (cfToken: string, scope?: { accountId?: string; zoneId?: string }) =>
    req<TokenCheck>("/api/setup/check-token", post({ cfToken, ...scope })),
  status: () => req<SetupStatus>("/api/setup/status"),
  claim: (body: ClaimRequest) => req<ClaimResponse>("/api/setup/claim", post(body)),
  worker: () =>
    req<{ name: string; source: string; hostname: string; candidates: string[] }>(
      "/api/setup/worker",
    ),
  setWorker: (name: string) =>
    req<{ ok: true; name: string }>("/api/setup/worker", post({ name })),
  zones: () => req<{ zones: SetupZone[] }>("/api/domains/zones"),
  addDomain: (body: {
    zoneId: string;
    domain: string;
    acceptAll?: boolean;
    allowedPattern?: string;
    aliasSuffix?: string;
    fallbackForwardTo?: string;
    primary?: boolean;
    confirmOverwriteMx?: boolean;
  }) => req<{ ok: true; records: DnsRow[] }>("/api/domains", post(body)),
  domainStatus: (domain: string) =>
    req<DomainStatus>(`/api/domains/${encodeURIComponent(domain)}/status`),
  sending: (body: { provider: "resend" | "cloudflare" | "none"; apiKey?: string; domain?: string }) =>
    req<{ ok: true; provider: string; send_state: string; records: DnsRow[]; manual: boolean }>(
      "/api/sending",
      post(body),
    ),
  sendingStatus: (domain: string) =>
    req<{ provider: string; send_state: string; records: DnsRow[]; detail?: string }>(
      `/api/sending/status?domain=${encodeURIComponent(domain)}`,
    ),
  testSend: (to: string) => req<{ ok: true }>("/api/sending/test", post({ to })),
  extras: (body: {
    enablePush?: boolean;
    vapidSubject?: string;
    anthropicKey?: string;
    aiModel?: string;
    signature?: string;
  }) =>
    req<{
      push: { enabled: boolean };
      ai: { enabled: boolean };
      errors?: Record<string, string>;
    }>("/api/setup/extras", post(body)),
  skip: (step: SetupStep) => req<{ ok: true }>("/api/setup/skip", post({ step })),
  complete: () => req<{ ok: true }>("/api/setup/complete", post({})),
};
