import { Hono } from "hono";
import type { HonoEnv } from "../env.ts";
import { loadVapid, vapidPublicKey } from "../push.ts";
import { scopeOf } from "../middleware.ts";

export const push = new Hono<HonoEnv>();

// Public VAPID key for the browser's PushManager.subscribe, derived from the
// private JWK. Empty when push isn't configured — the SPA treats that as "off".
push.get("/key", async (c) => {
  const vapid = await loadVapid(c.env);
  return c.json({ key: vapidPublicKey(vapid?.jwk) ?? "" });
});

push.post("/subscribe", async (c) => {
  const b = await c.req
    .json<{ endpoint?: string; keys?: { p256dh?: string; auth?: string } }>()
    .catch(() => ({}) as Record<string, never>);
  if (!b.endpoint) return c.json({ error: "endpoint required" }, 400);

  // endpoint stays the primary key, and the conflict clause reassigns the owner:
  // on a shared browser, re-subscribing after a different login must MOVE the
  // subscription rather than leave the previous user receiving its pushes.
  await c.env.DB.prepare(
    `INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, created_at) VALUES (?,?,?,?,?)
     ON CONFLICT(endpoint) DO UPDATE SET
       user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`,
  )
    .bind(b.endpoint, scopeOf(c), b.keys?.p256dh ?? null, b.keys?.auth ?? null, Date.now())
    .run();
  return c.json({ ok: true });
});

push.post("/unsubscribe", async (c) => {
  const b = await c.req.json<{ endpoint?: string }>().catch(() => ({}) as { endpoint?: string });
  if (!b.endpoint) return c.json({ error: "endpoint required" }, 400);
  await c.env.DB.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?`)
    .bind(b.endpoint, scopeOf(c))
    .run();
  return c.json({ ok: true });
});
