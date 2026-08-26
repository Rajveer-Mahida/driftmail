import { Hono } from "hono";
import { setCookie, deleteCookie } from "hono/cookie";
import type { HonoEnv } from "../env.ts";
import type { LoginRequest } from "@email/shared";
import { authSecret, cookieName, cookieMaxAge, issueSession } from "../auth.ts";
import {
  checkLoginAllowed,
  clearLoginFailures,
  dummyVerify,
  getUserByEmail,
  normalizeEmail,
  recordLogin,
  recordLoginFailure,
  setPassword,
  toSessionUser,
  upgradeHashIfStale,
  UserError,
  verifyPassword,
} from "../users.ts";
import { isClaimed } from "../config/index.ts";

export const auth = new Hono<HonoEnv>();

/** Deliberately identical for every failure: an unknown address, a wrong
 *  password and a disabled account must be indistinguishable. */
const REJECT = { error: "Invalid email or password" } as const;

function throttleKeys(c: { req: { header(name: string): string | undefined } }, email: string) {
  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  return [`email:${email}`, `ip:${ip}`];
}

auth.post("/login", async (c) => {
  if (!(await isClaimed(c.env.DB))) {
    return c.json({ error: "setup_required" }, 409);
  }

  const body = await c.req.json<LoginRequest>().catch(() => null);
  const email = normalizeEmail(body?.email ?? "");
  const password = body?.password ?? "";
  if (!email || !password) return c.json(REJECT, 401);

  const keys = throttleKeys(c, email);
  const allowed = await checkLoginAllowed(c.env.DB, keys);
  if (!allowed.allowed) {
    return c.json({ error: "Too many attempts. Try again shortly.", retryAfter: allowed.retryAfter }, 429);
  }

  const user = await getUserByEmail(c.env.DB, email);
  if (!user) {
    // Burn the same work a real verification would have cost, so the response
    // time doesn't reveal whether the account exists.
    await dummyVerify(password);
    await recordLoginFailure(c.env.DB, keys);
    return c.json(REJECT, 401);
  }

  const ok = await verifyPassword(user, password);
  if (!ok || user.disabled === 1) {
    await recordLoginFailure(c.env.DB, keys);
    return c.json(REJECT, 401);
  }

  const token = await issueSession(c.env, user.id, user.token_version);
  if (!token) return c.json({ error: "setup_required" }, 409);

  await clearLoginFailures(c.env.DB, keys);
  await recordLogin(c.env.DB, user.id);
  await upgradeHashIfStale(c.env.DB, user, password);

  setCookie(c, cookieName(), token, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: cookieMaxAge(),
  });
  return c.json({ ok: true, user: toSessionUser(user) });
});

auth.post("/logout", (c) => {
  deleteCookie(c, cookieName(), { path: "/" });
  return c.json({ ok: true });
});

/** Reaching this at all means the middleware accepted the cookie. */
auth.get("/me", (c) => c.json({ user: c.get("user") }));

auth.post("/change-password", async (c) => {
  const user = c.get("user");
  const body = await c.req
    .json<{ current?: string; next?: string }>()
    .catch(() => null);
  if (!body?.next) return c.json({ error: "A new password is required" }, 400);

  const row = await getUserByEmail(c.env.DB, user.email);
  if (!row) return c.json({ error: "unauthorized" }, 401);

  // Someone forced to change their password still has to prove they hold the
  // temporary one, or an unattended session becomes an account takeover.
  if (!(await verifyPassword(row, body.current ?? ""))) {
    return c.json({ error: "That isn't your current password" }, 403);
  }

  try {
    await setPassword(c.env.DB, row.id, body.next);
  } catch (err) {
    if (err instanceof UserError) return c.json({ error: err.message }, err.status as 400);
    throw err;
  }

  // setPassword bumped token_version, so the cookie in flight is now stale —
  // reissue it, otherwise the user is signed out by their own password change.
  const token = await issueSession(c.env, row.id, row.token_version + 1);
  if (token) {
    setCookie(c, cookieName(), token, {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: "/",
      maxAge: cookieMaxAge(),
    });
  }
  return c.json({ ok: true });
});

/** Sign out everywhere, including this device. */
auth.post("/logout-all", async (c) => {
  const user = c.get("user");
  await c.env.DB.prepare(`UPDATE users SET token_version = token_version + 1 WHERE id = ?`)
    .bind(user.id)
    .run();
  deleteCookie(c, cookieName(), { path: "/" });
  return c.json({ ok: true });
});

/** Exported for the middleware, which needs the key on every request. */
export { authSecret };
