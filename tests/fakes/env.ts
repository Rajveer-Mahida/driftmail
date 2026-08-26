// Minimal stand-ins for the Worker bindings, so route and cron logic can be
// exercised without wrangler in the loop.

import { FakeD1 } from "./d1.ts";

export class FakeR2 {
  readonly objects = new Map<string, ArrayBuffer>();

  put(key: string, body: ArrayBuffer | string): void {
    this.objects.set(
      key,
      typeof body === "string" ? new TextEncoder().encode(body).buffer : body,
    );
  }

  async get(key: string) {
    const buf = this.objects.get(key);
    if (!buf) return null;
    return {
      arrayBuffer: async () => buf,
      text: async () => new TextDecoder().decode(buf),
    };
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  /** Enough of R2's list() for prefix sweeps and the full-wipe pagination loop. */
  async list(opts: { prefix?: string; cursor?: string; limit?: number } = {}) {
    const keys = [...this.objects.keys()]
      .filter((k) => !opts.prefix || k.startsWith(opts.prefix))
      .sort();
    const start = opts.cursor ? Number(opts.cursor) : 0;
    const limit = opts.limit ?? 1000;
    const page = keys.slice(start, start + limit);
    const truncated = start + limit < keys.length;
    return {
      objects: page.map((key) => ({ key })),
      truncated,
      cursor: truncated ? String(start + limit) : undefined,
    };
  }
}

export type SentEmail = Record<string, unknown>;

/** The Cloudflare send_email binding. `fail` makes the next send throw, which is
 *  how the error-mapping and retry paths are driven. */
export class FakeEmailBinding {
  readonly sent: SentEmail[] = [];
  fail: (Error & { code?: string }) | null = null;

  async send(opts: SentEmail): Promise<{ messageId: string }> {
    if (this.fail) throw this.fail;
    this.sent.push(opts);
    return { messageId: `cf-${this.sent.length}` };
  }
}

export type TestEnv = {
  DB: D1Database;
  EMAIL_CACHE: FakeR2;
  EMAIL: FakeEmailBinding;
  SETUP_TOKEN?: string;
  CONFIG_ENC_KEY?: string;
  DEV_UNSAFE_SKIP_OWNERSHIP?: string;
};

export function fakeEnv(db: FakeD1, over: Partial<TestEnv> = {}) {
  const env = {
    DB: db as never,
    EMAIL_CACHE: new FakeR2(),
    EMAIL: new FakeEmailBinding(),
    ...over,
  };
  return env as TestEnv & { EMAIL_CACHE: FakeR2; EMAIL: FakeEmailBinding };
}

/** Route `fetch` through a table of matchers, so a test states exactly which
 *  outbound calls it expects rather than stubbing a bare function. */
export type FetchCall = { url: string; method: string; headers: Record<string, string>; body: unknown };

export function stubFetch(
  routes: Array<{
    match: (url: string, init?: RequestInit) => boolean;
    respond: (url: string, init?: RequestInit) => { status?: number; body?: unknown; text?: string };
  }>,
): { calls: FetchCall[]; restore: () => void } {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    let body: unknown = init?.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        /* leave as the raw string */
      }
    }
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body,
    });

    const route = routes.find((r) => r.match(url, init));
    if (!route) throw new Error(`No stubbed route for ${init?.method ?? "GET"} ${url}`);

    const out = route.respond(url, init);
    const text = out.text ?? JSON.stringify(out.body ?? {});
    return new Response(text, {
      status: out.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  return { calls, restore: () => void (globalThis.fetch = original) };
}
