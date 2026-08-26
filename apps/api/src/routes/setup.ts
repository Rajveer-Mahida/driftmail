// First-run setup.
//
// These are the only routes an unclaimed instance answers. Everything here is
// mounted under /api/setup and matched by prefix in the setup gate.

import { Hono } from "hono";
import { asUserId } from "@email/shared";
import type { HonoEnv } from "../env.ts";
import { setCookie } from "hono/cookie";
import {
  claimInstance,
  getConfig,
  isClaimed,
  loadConfig,
  setConfig,
} from "../config/index.ts";
import { hasSecret, setSecret } from "../config/secrets.ts";
import { setUserSetting } from "../config/user.ts";
import { ensureAuthSecret, issueSession, cookieName, cookieMaxAge, timingSafeEqual } from "../auth.ts";
import {
  adoptOrphanRows,
  countUsers,
  createFirstAdmin,
  UserError,
  validateEmail,
  validateHandle,
  validatePassword,
} from "../users.ts";
import {
  CloudflareError,
  authHint,
  identifyWorker,
  listAccounts,
  localDevIdentity,
  probeToken,
  scriptExists,
  listScripts,
  cfToken,
  type WorkerIdentity,
} from "../cloudflare.ts";
import { requireAdmin } from "../middleware.ts";

export const setup = new Hono<HonoEnv>();

/** How long an abandoned deployment keeps accepting the weaker SETUP_TOKEN
 *  claim. The Cloudflare-token path is self-authenticating and never expires. */
const SETUP_TOKEN_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Whether the ownership proof may be skipped for local development.
 *
 * BOTH conditions are required, and the env var is the one that matters. The
 * hostname comes from the Host header, which the client controls — a deployed
 * Worker could in principle be sent `Host: localhost`, so a hostname check alone
 * would be a bypass, not a boundary. DEV_UNSAFE_SKIP_OWNERSHIP only ever exists
 * in a local .dev.vars file.
 */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0"]);

function devSkipAllowed(env: { DEV_UNSAFE_SKIP_OWNERSHIP?: string }, hostname: string): boolean {
  if (env.DEV_UNSAFE_SKIP_OWNERSHIP !== "1") return false;
  const host = hostname.toLowerCase();
  return LOOPBACK.has(host) || host.endsWith(".localhost");
}

/** Unauthenticated, so worth blunting: 5 attempts per client per 15 minutes. */
const CLAIM_MAX_ATTEMPTS = 5;
const CLAIM_WINDOW_MS = 15 * 60 * 1000;

function fail(err: unknown): { error: string; hint?: string; status: 400 | 403 | 502 } {
  if (err instanceof CloudflareError) {
    return {
      error: err.message,
      hint: authHint(err),
      status: err.status === 403 || err.status === 401 ? 403 : 502,
    };
  }
  if (err instanceof UserError) {
    return { error: err.message, status: 400 };
  }
  return { error: (err as Error)?.message ?? "Setup step failed", status: 502 };
}

/**
 * Public, and deliberately says almost nothing.
 *
 * Anyone can reach this before the instance is claimed, so it must not disclose
 * zone names, the admin's email, the account id, or anything else about a
 * deployment that has been set up.
 */
setup.get("/status", async (c) => {
  const claimed = await isClaimed(c.env.DB);
  if (!claimed) {
    return c.json({
      claimed: false,
      complete: false,
      step: "welcome",
      requires: c.env.SETUP_TOKEN?.trim() ? "either" : "cf_token",
      hostname: new URL(c.req.url).hostname,
    });
  }

  const cfg = await loadConfig(c.env.DB);
  return c.json({
    claimed: true,
    complete: cfg["setup.completed_at"] !== null,
    step: cfg["setup.step"],
    skipped: cfg["setup.skipped"],
  });
});

/**
 * Check a token's permissions before committing to it.
 *
 * Public, because it is only useful before the instance has an owner — which is
 * exactly when nobody can authenticate. It reveals nothing an attacker doesn't
 * supply themselves: you learn what YOUR token can do, and only for a token you
 * already hold. Rate-limited alongside the claim.
 */
setup.post("/check-token", async (c) => {
  if (await isClaimed(c.env.DB)) {
    // After setup, this belongs behind the admin gate in Settings.
    return c.json({ error: "already_claimed" }, 409);
  }

  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  if (!(await rateLimitClaim(c.env.DB, `probe:${ip}`))) {
    return c.json({ error: "rate_limited", retryAfter: CLAIM_WINDOW_MS / 1000 }, 429);
  }

  const body = await c.req
    .json<{ cfToken?: string; accountId?: string; zoneId?: string }>()
    .catch(() => ({}) as Record<string, never>);
  const token = body.cfToken?.trim();
  if (!token) return c.json({ error: "A token is required" }, 400);

  try {
    const capabilities = await probeToken(token, {
      accountId: body.accountId?.trim() || undefined,
      zoneId: body.zoneId?.trim() || undefined,
    });
    const missing = capabilities.filter((cap) => !cap.ok);
    return c.json({
      capabilities,
      ok: missing.every((cap) => !cap.required),
      missingRequired: missing.filter((cap) => cap.required).map((cap) => cap.id),
    });
  } catch (err) {
    const f = fail(err);
    return c.json({ error: f.error, hint: f.hint }, f.status);
  }
});

// ── the claim ────────────────────────────────────────────────────────────────

async function rateLimitClaim(db: D1Database, key: string): Promise<boolean> {
  const now = Date.now();
  const row = await db
    .prepare(`SELECT fails, window_start FROM login_attempts WHERE key = ?`)
    .bind(key)
    .first<{ fails: number; window_start: number }>();

  const fresh = !row || now - row.window_start > CLAIM_WINDOW_MS;
  const fails = fresh ? 1 : row.fails + 1;
  await db
    .prepare(
      `INSERT INTO login_attempts (key, fails, window_start, locked_until) VALUES (?, ?, ?, NULL)
         ON CONFLICT(key) DO UPDATE SET fails = excluded.fails, window_start = excluded.window_start`,
    )
    .bind(key, fails, fresh ? now : row!.window_start)
    .run();
  return fails <= CLAIM_MAX_ATTEMPTS;
}

type ClaimBody = {
  cfToken?: string;
  setupToken?: string;
  accountId?: string;
  email?: string;
  handle?: string;
  password?: string;
};

setup.post("/claim", async (c) => {
  if (await isClaimed(c.env.DB)) return c.json({ error: "already_claimed" }, 409);

  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  if (!(await rateLimitClaim(c.env.DB, `claim:${ip}`))) {
    return c.json({ error: "rate_limited", retryAfter: CLAIM_WINDOW_MS / 1000 }, 429);
  }

  const body = (await c.req.json<ClaimBody>().catch(() => ({}))) as ClaimBody;
  const hostname = new URL(c.req.url).hostname;

  // Validate everything BEFORE writing anything, so a rejected claim leaves the
  // database exactly as it was.
  const email = validateEmail(body.email ?? "");
  if (!email.ok) return c.json({ error: email.error }, 400);
  const handle = validateHandle(body.handle ?? email.email.split("@")[0]);
  if (!handle.ok) return c.json({ error: handle.error }, 400);
  const password = validatePassword(body.password ?? "");
  if (!password.ok) return c.json({ error: password.error }, 400);

  // ── proof of ownership ──
  let identity: WorkerIdentity | null = null;
  const token = body.cfToken?.trim();

  const localDev = devSkipAllowed(c.env, hostname);

  if (token) {
    // Resolve the account FIRST, and separately.
    //
    // Doing it here rather than inside identifyWorker keeps two different
    // failures apart: a token that can't list accounts needs the operator to
    // supply an id, while a token that can't read Workers needs a permission
    // added. Conflating them tells people to paste an account id that won't
    // help.
    let accountIds: string[] | undefined = body.accountId?.trim()
      ? [body.accountId.trim()]
      : undefined;

    if (!accountIds) {
      try {
        accountIds = (await listAccounts(token)).map((a) => a.id);
      } catch (err) {
        if (err instanceof CloudflareError && (err.status === 403 || err.status === 401)) {
          return c.json(
            {
              error: "account_undetermined",
              detail:
                "That token can't list your Cloudflare accounts. Paste your account ID and try again — you'll find it in the dashboard URL, or on any zone's Overview page.",
            },
            422,
          );
        }
        const f = fail(err);
        return c.json({ error: f.error, hint: f.hint }, f.status);
      }
      if (!accountIds.length) {
        return c.json(
          {
            error: "account_undetermined",
            detail: "That token works, but it can't see any Cloudflare account.",
          },
          422,
        );
      }
    }

    try {
      identity = localDev
        ? // No Worker serves localhost, so there is nothing to prove ownership
          // against. The token is still validated, and still stored, so the
          // domain and DNS steps work against real Cloudflare while developing.
          await localDevIdentity(token, accountIds)
        : await identifyWorker(token, hostname, accountIds);
    } catch (err) {
      const f = fail(err);
      return c.json({ error: f.error, hint: f.hint }, f.status);
    }

    if (!identity) {
      return c.json(
        localDev
          ? {
              error: "no_accounts",
              detail: "That token works, but it can't see any Cloudflare account.",
              hostname,
            }
          : {
              error: "not_owner",
              detail:
                `This token's Cloudflare account doesn't run the Worker at ${hostname}.` +
                (LOOPBACK.has(hostname.toLowerCase())
                  ? " Running locally? No Worker serves localhost, so set DEV_UNSAFE_SKIP_OWNERSHIP=1 in .dev.vars, or use a SETUP_TOKEN instead."
                  : ""),
              hostname,
            },
        403,
      );
    }
  } else {
    const expected = c.env.SETUP_TOKEN?.trim();
    const supplied = body.setupToken?.trim();
    if (!expected || !supplied || !timingSafeEqual(supplied, expected)) {
      return c.json(
        {
          error: "proof_required",
          detail:
            "Paste a Cloudflare API token for the account running this Worker, or set a SETUP_TOKEN secret on the Worker and use that instead.",
        },
        403,
      );
    }
    // An abandoned deployment must stop being claimable by a shared secret.
    const firstSeen = await getConfig(c.env.DB, "instance.first_seen_at");
    if (firstSeen && Date.now() - firstSeen > SETUP_TOKEN_WINDOW_MS) {
      return c.json(
        {
          error: "setup_token_expired",
          detail:
            "This deployment has been running for more than a day, so the setup token is no longer accepted. Claim it with a Cloudflare API token instead.",
        },
        403,
      );
    }
  }

  // ── the claim itself ──
  // A conditional insert, so two concurrent claimants cannot both win. Anything
  // before this point must not have written.
  if (!(await claimInstance(c.env.DB))) {
    return c.json({ error: "already_claimed" }, 409);
  }

  try {
    await ensureAuthSecret(c.env);
    if (token) await setSecret(c.env.DB, c.env, "cf.token", token);

    const admin = await createFirstAdmin(c.env.DB, {
      email: email.email,
      handle: handle.handle,
      password: body.password!,
    });

    // Mail that predates multi-tenancy belongs to nobody and is therefore
    // invisible; hand it to the first administrator.
    const adopted = await adoptOrphanRows(c.env.DB, asUserId(admin.id));

    await setConfig(c.env.DB, {
      "instance.hostname": hostname,
      "setup.step": identity?.workerName ? "domain" : "worker",
      ...(identity
        ? {
            // Empty when running locally — leave the default in place rather
            // than blanking the name the catch-all rule will point at.
            ...(identity.workerName ? { "instance.worker_name": identity.workerName } : {}),
            "instance.worker_source": identity.source,
            "instance.cf_account_id": identity.accountId,
          }
        : {}),
    });

    const session = await issueSession(c.env, admin.id, admin.token_version);
    if (session) {
      setCookie(c, cookieName(), session, {
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
        path: "/",
        maxAge: cookieMaxAge(),
      });
    }

    return c.json({
      ok: true,
      worker: identity?.workerName
        ? { name: identity.workerName, source: identity.source }
        : {
            name: await getConfig(c.env.DB, "instance.worker_name"),
            source: identity?.source ?? "manual",
          },
      account: identity ? { id: identity.accountId, name: identity.accountName } : null,
      servingZone: identity?.zoneId
        ? { id: identity.zoneId, name: identity.zoneName }
        : null,
      adopted,
      nextStep: identity?.workerName ? "domain" : "worker",
    });
  } catch (err) {
    const f = fail(err);
    return c.json({ error: f.error, hint: f.hint }, f.status);
  }
});

// ── everything past the claim is admin-only ──────────────────────────────────

setup.use("/worker", requireAdmin());
setup.use("/worker/*", requireAdmin());
setup.use("/accounts", requireAdmin());
setup.use("/complete", requireAdmin());
setup.use("/skip", requireAdmin());

setup.get("/worker", async (c) => {
  const cfg = await loadConfig(c.env.DB);

  // When the token can enumerate the account's scripts, hand back the real
  // options. This step only appears when detection failed (there is no hostname
  // to detect from, i.e. local dev), and a free-text field here is where a typo
  // becomes a catch-all pointed at a Worker that doesn't exist.
  let candidates: string[] = [];
  const token = await cfToken(c.env);
  const accountId = cfg["instance.cf_account_id"];
  if (token && accountId) {
    candidates = await listScripts(token, accountId).catch(() => []);
  }

  return c.json({
    name: cfg["instance.worker_name"],
    source: cfg["instance.worker_source"],
    hostname: cfg["instance.hostname"] || new URL(c.req.url).hostname,
    candidates,
  });
});

setup.post("/worker", async (c) => {
  const { name } = await c.req.json<{ name?: string }>().catch(() => ({}) as { name?: string });
  const value = name?.trim();
  if (!value) return c.json({ error: "A Worker name is required" }, 400);

  // Verify the script actually exists whenever the stored token can ask.
  // Accepting an unverified name is the quiet catastrophe of this system: the
  // catch-all rule targets a Worker BY NAME, so a typo either fails loudly at
  // the domain step (best case) or, if a script by that name ever exists,
  // delivers your mail to it.
  const token = await cfToken(c.env);
  const accountId = await getConfig(c.env.DB, "instance.cf_account_id");
  if (token && accountId) {
    try {
      if (!(await scriptExists(token, accountId, value))) {
        return c.json(
          {
            error: `There's no Worker named "${value}" in your Cloudflare account.`,
            hint:
              "The name must match the script exactly — it's at the top of the Worker's page " +
              "in the dashboard. For this deployment it is usually the name in wrangler.jsonc.",
          },
          400,
        );
      }
    } catch {
      // The token may lack Workers Scripts:Read; without a way to ask, storing
      // the name is the only option — the domain step surfaces a mismatch.
    }
  }

  await setConfig(c.env.DB, {
    "instance.worker_name": value,
    "instance.worker_source": "manual",
  });
  return c.json({ ok: true, name: value, source: "manual" });
});

/** For the account-id fallback, once a token is stored. */
setup.get("/accounts", async (c) => {
  const stored = await getConfig(c.env.DB, "instance.cf_account_id");
  return c.json({ accountId: stored });
});

setup.post("/skip", async (c) => {
  const { step } = await c.req.json<{ step?: string }>().catch(() => ({}) as { step?: string });
  if (!step) return c.json({ error: "step required" }, 400);
  const skipped = new Set(await getConfig(c.env.DB, "setup.skipped"));
  skipped.add(step);
  await setConfig(c.env.DB, { "setup.skipped": [...skipped] });
  return c.json({ ok: true, skipped: [...skipped] });
});

setup.post("/complete", async (c) => {
  await setConfig(c.env.DB, { "setup.completed_at": Date.now(), "setup.step": "done" });
  return c.json({ ok: true });
});

/** Exported for the tests, which drive the claim directly. */
export { countUsers, listAccounts };

// ── optional extras ──────────────────────────────────────────────────────────

setup.use("/extras", requireAdmin());

/**
 * Push and AI, each independent.
 *
 * Partial success is normal and is reported per field: a rejected Anthropic key
 * must not discard the signature the operator just typed.
 */
setup.post("/extras", async (c) => {
  const body = await c.req
    .json<{
      enablePush?: boolean;
      vapidSubject?: string;
      anthropicKey?: string;
      aiModel?: string;
      signature?: string;
    }>()
    .catch(() => ({}) as Record<string, never>);

  const errors: Record<string, string> = {};
  let pushEnabled = await hasSecret(c.env.DB, "push.vapid_private_jwk");
  let aiEnabled = await hasSecret(c.env.DB, "anthropic.api_key");

  if (body.enablePush) {
    try {
      // Generated in the Worker with Web Crypto, so web push needs no CLI step
      // and no key ever leaves this process. The public half is always derived
      // from the private JWK, so the pair cannot drift apart.
      const pair = (await crypto.subtle.generateKey(
        { name: "ECDSA", namedCurve: "P-256" },
        true,
        ["sign", "verify"],
      )) as CryptoKeyPair;
      const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
      await setSecret(c.env.DB, c.env, "push.vapid_private_jwk", JSON.stringify(jwk));

      const admin = c.get("user");
      await setConfig(c.env.DB, {
        // Push services block senders that sign with a placeholder contact
        // address, so this has to be a real one.
        "push.vapid_subject": body.vapidSubject?.trim() || `mailto:${admin.email}`,
      });
      pushEnabled = true;
    } catch (err) {
      errors.push = (err as Error).message;
    }
  }

  if (body.anthropicKey?.trim()) {
    const key = body.anthropicKey.trim();
    try {
      // A models listing costs nothing, unlike an actual completion.
      const res = await fetch("https://api.anthropic.com/v1/models", {
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
      });
      if (!res.ok) {
        errors.ai = res.status === 401 ? "Anthropic rejected that key." : `Anthropic returned ${res.status}.`;
      } else {
        await setSecret(c.env.DB, c.env, "anthropic.api_key", key);
        if (body.aiModel?.trim()) await setConfig(c.env.DB, { "ai.model": body.aiModel.trim() });
        aiEnabled = true;
      }
    } catch (err) {
      errors.ai = (err as Error).message;
    }
  }

  if (typeof body.signature === "string") {
    await setUserSetting(c.env.DB, asUserId(c.get("user").id), "signature", body.signature);
  }

  return c.json({
    push: { enabled: pushEnabled },
    ai: { enabled: aiEnabled, model: await getConfig(c.env.DB, "ai.model") },
    ...(Object.keys(errors).length ? { errors } : {}),
  });
});
