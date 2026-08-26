// The gates every /api request passes through, in order:
//
//   1. setup    — an unclaimed instance answers nothing but /api/setup
//   2. session  — resolve the cookie to a user, or 401
//   3. admin    — mounted only on the routes that need it

import { getCookie } from "hono/cookie";
import type { Context, MiddlewareHandler } from "hono";
import { asUserId, type UserId } from "@email/shared";
import type { HonoEnv } from "./env.ts";
import { authSecret, verifySessionToken, cookieName } from "./auth.ts";
import { getUserById, toSessionUser } from "./users.ts";
import { isClaimed, markFirstSeen } from "./config/index.ts";

/** Reachable before the instance is claimed. Matched by PREFIX — an exact-match
 *  set would leave every nested setup route unreachable. */
const SETUP_PREFIX = "/api/setup";

/** Reachable without a session, once the instance is claimed. */
const PUBLIC_EXACT = new Set(["/api/auth/login", "/api/health"]);

/** The only routes someone with an expired temporary password may reach. */
const PW_CHANGE_ALLOWED = new Set([
  "/api/auth/me",
  "/api/auth/change-password",
  "/api/auth/logout",
]);

const isSetupPath = (path: string) =>
  path === SETUP_PREFIX || path.startsWith(`${SETUP_PREFIX}/`);

/**
 * Until someone claims this deployment it holds no data and has no owner, so it
 * answers only the two endpoints needed to claim it.
 *
 * 409 rather than 401: a 401 makes the SPA bounce to /login, which would be a
 * dead end on an instance that has no accounts yet.
 */
export function setupGate(): MiddlewareHandler<HonoEnv> {
  return async (c, next) => {
    if (await isClaimed(c.env.DB)) return next();

    // Records when this deployment first served traffic, which bounds how long
    // the weaker SETUP_TOKEN claim stays open.
    await markFirstSeen(c.env.DB).catch(() => {});

    if (isSetupPath(c.req.path) || c.req.path === "/api/health") return next();
    return c.json({ error: "setup_required" }, 409);
  };
}

/** Resolve the session cookie to a user, or refuse. */
export function sessionGate(): MiddlewareHandler<HonoEnv> {
  return async (c, next) => {
    const path = c.req.path;
    if (PUBLIC_EXACT.has(path) || isSetupPath(path)) {
      // Setup paths are matched by prefix BEFORE authentication, because the
      // claim must work with no session. But every setup route past the claim
      // is admin-only — so resolve the session best-effort here, or their
      // requireAdmin judges an empty context and answers "forbidden" to the
      // very admin the claim just signed in.
      try {
        const raw = getCookie(c, cookieName());
        if (raw) {
          const claims = await verifySessionToken(await authSecret(c.env), raw);
          if (claims) {
            const user = await getUserById(c.env.DB, claims.uid);
            if (user && user.disabled !== 1 && user.token_version === claims.tv) {
              c.set("user", toSessionUser(user));
            }
          }
        }
      } catch {
        // Unauthenticated is a fine state for these paths; the admin gate on
        // the individual routes decides what needs more.
      }
      return next();
    }

    try {
      const raw = getCookie(c, cookieName());
      if (!raw) return c.json({ error: "unauthorized" }, 401);

      const claims = await verifySessionToken(await authSecret(c.env), raw);
      if (!claims) return c.json({ error: "unauthorized" }, 401);

      const user = await getUserById(c.env.DB, claims.uid);
      // token_version is the revocation channel: a password change, a role
      // change or a suspension bumps it, and every token issued before that
      // stops verifying immediately.
      if (!user || user.disabled === 1 || user.token_version !== claims.tv) {
        return c.json({ error: "unauthorized" }, 401);
      }

      if (user.must_change_pw === 1 && !PW_CHANGE_ALLOWED.has(path)) {
        return c.json({ error: "password_change_required" }, 403);
      }

      c.set("user", toSessionUser(user));
      return next();
    } catch {
      // Fail closed on anything unexpected rather than falling through.
      return c.json({ error: "unauthorized" }, 401);
    }
  };
}

export function requireAdmin(): MiddlewareHandler<HonoEnv> {
  return async (c, next) => {
    if (c.get("user")?.role !== "admin") return c.json({ error: "forbidden" }, 403);
    return next();
  };
}

/**
 * The signed-in user's id, branded.
 *
 * This and the address resolver are the only two places a UserId is minted, so
 * grepping for `asUserId` finds every point where an unscoped string becomes an
 * authority to read someone's mail.
 */
export function scopeOf(c: Context<HonoEnv>): UserId {
  return asUserId(c.get("user").id);
}
