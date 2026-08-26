// Getting a domain verified for sending, without the operator touching DNS.
//
// Resend hands back the records it wants; the Cloudflare token we already hold
// can write them. The interesting part is doing that without trampling records
// somebody else put there.

import {
  createDnsRecord,
  findDnsRecords,
  updateDnsRecord,
  type DnsRecord,
} from "../cloudflare.ts";
import { recordDns, type DnsStatus } from "../config/domains.ts";

const API = "https://api.resend.com";

export type ResendRecord = {
  record: string;
  name: string;
  type: string;
  ttl?: string;
  status?: string;
  value: string;
  priority?: number;
};

export type ResendDomain = {
  id: string;
  name: string;
  status: string;
  region?: string;
  records?: ResendRecord[];
};

async function resend<T>(
  apiKey: string,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: init?.method ?? "GET",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON */
  }
  if (!res.ok) {
    const message = (json as { message?: string })?.message ?? `Resend returned ${res.status}`;
    throw Object.assign(new Error(message), { status: res.status });
  }
  return json as T;
}

export async function listResendDomains(apiKey: string): Promise<ResendDomain[]> {
  const body = await resend<{ data?: ResendDomain[] } | ResendDomain[]>(apiKey, "/domains");
  return Array.isArray(body) ? body : (body.data ?? []);
}

export async function findOrCreateResendDomain(
  apiKey: string,
  domain: string,
  region = "us-east-1",
): Promise<ResendDomain> {
  const existing = (await listResendDomains(apiKey)).find((d) => d.name === domain);
  if (existing) {
    // The list response omits `records`; fetch the full object so the caller has
    // something to write and to show.
    return resend<ResendDomain>(apiKey, `/domains/${existing.id}`);
  }
  return resend<ResendDomain>(apiKey, "/domains", {
    method: "POST",
    body: { name: domain, region },
  });
}

export async function verifyResendDomain(apiKey: string, id: string): Promise<void> {
  await resend(apiKey, `/domains/${id}/verify`, { method: "POST", body: {} });
}

export async function getResendDomain(apiKey: string, id: string): Promise<ResendDomain> {
  return resend<ResendDomain>(apiKey, `/domains/${id}`);
}

export type ReconcileResult = {
  type: string;
  name: string;
  content: string;
  priority: number | null;
  status: DnsStatus;
  managed: boolean;
  detail?: string;
};

/**
 * Write the provider's records into the zone, without clobbering anything.
 *
 * Rules, in order:
 *   - no record at that name/type   → create it, and remember we own it
 *   - identical content already     → leave it, count it as done
 *   - different content, ours       → update it
 *   - different content, not ours   → refuse, and surface the conflict
 *
 * The last case is the point. A record somebody added by hand may be load-bearing
 * for something this app knows nothing about.
 */
export async function reconcileDns(
  token: string,
  zoneId: string,
  wanted: Array<{ type: string; name: string; content: string; priority?: number }>,
  ours: Set<string>,
): Promise<ReconcileResult[]> {
  const out: ReconcileResult[] = [];

  for (const record of wanted) {
    const key = `${record.type}:${record.name}`;
    let existing: DnsRecord[] = [];
    try {
      existing = await findDnsRecords(token, zoneId, record.type, record.name);
    } catch (err) {
      out.push({
        ...record,
        priority: record.priority ?? null,
        status: "failed",
        managed: false,
        detail: (err as Error).message,
      });
      continue;
    }

    const identical = existing.find((r) => r.content === record.content);
    if (identical) {
      out.push({ ...record, priority: record.priority ?? null, status: "written", managed: true });
      continue;
    }

    // Two SPF records at one name is a permanent permerror that silently ruins
    // deliverability, so it is refused rather than merged.
    if (record.type === "TXT" && record.content.startsWith("v=spf1")) {
      const otherSpf = existing.find((r) => r.content.startsWith("v=spf1"));
      if (otherSpf) {
        out.push({
          ...record,
          priority: record.priority ?? null,
          status: "conflict",
          managed: false,
          detail: `${record.name} already has an SPF record. Merge them by hand — two SPF records at one name break every message.`,
        });
        continue;
      }
    }

    const mine = existing.find((r) => r.id && ours.has(`${key}:${r.id}`));
    try {
      if (mine?.id) {
        await updateDnsRecord(token, zoneId, mine.id, record);
        out.push({ ...record, priority: record.priority ?? null, status: "written", managed: true });
      } else if (existing.length) {
        out.push({
          ...record,
          priority: record.priority ?? null,
          status: "conflict",
          managed: false,
          detail: `A ${record.type} record already exists at ${record.name} with different content, and Driftmail didn't create it.`,
        });
      } else {
        const created = await createDnsRecord(token, zoneId, record);
        if (created.id) ours.add(`${key}:${created.id}`);
        out.push({ ...record, priority: record.priority ?? null, status: "written", managed: true });
      }
    } catch (err) {
      out.push({
        ...record,
        priority: record.priority ?? null,
        status: "failed",
        managed: false,
        detail: (err as Error).message,
      });
    }
  }

  return out;
}

/** Persist whatever we just did, so the UI can show it without asking Resend. */
export async function saveSendingDns(
  db: D1Database,
  domain: string,
  results: ReconcileResult[],
): Promise<void> {
  await recordDns(db, domain, "sending", results);
}
