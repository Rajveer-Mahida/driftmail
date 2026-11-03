import { Hono } from "hono";
import type { HonoEnv, Env } from "./env.ts";
import { setupGate, sessionGate } from "./middleware.ts";
import { handleEmail } from "./email-handler.ts";
import { runScheduled } from "./scheduled.ts";
import { auth } from "./routes/auth.ts";
import { messages } from "./routes/messages.ts";
import { labels, counts } from "./routes/labels.ts";
import { settings } from "./routes/settings.ts";
import { reply } from "./routes/reply.ts";
import { attachments } from "./routes/attachments.ts";
import { compose } from "./routes/compose.ts";
import { uploads } from "./routes/uploads.ts";
import { drafts } from "./routes/drafts.ts";
import { aliases } from "./routes/aliases.ts";
import { rules } from "./routes/rules.ts";
import { push } from "./routes/push.ts";
import { ai } from "./routes/ai.ts";
import { domains } from "./routes/domains.ts";
import { setup } from "./routes/setup.ts";
import { admin } from "./routes/admin.ts";
import { sending } from "./routes/sending.ts";
import { ensureSchema } from "./migrations/runner.ts";

const app = new Hono<HonoEnv>();

// Order matters. A fresh deployment has an EMPTY database, so the schema is
// created before anything reads config; then an unclaimed instance must refuse
// before anything tries to resolve a session against a signing key that does
// not exist yet.
app.use("/api/*", async (c, next) => {
  try {
    await ensureSchema(c.env.DB);
  } catch (err) {
    return c.json(
      { error: "database_init_failed", detail: (err as Error)?.message ?? String(err) },
      503,
    );
  }
  return next();
});
app.use("/api/*", setupGate());
app.use("/api/*", sessionGate());

app.route("/api/setup", setup);
app.route("/api/auth", auth);
app.route("/api/messages", messages);
app.route("/api/labels", labels);
app.route("/api/counts", counts);
app.route("/api/settings", settings);
app.route("/api/reply", reply);
app.route("/api/send", compose);
app.route("/api/uploads", uploads);
app.route("/api/drafts", drafts);
app.route("/api/aliases", aliases);
app.route("/api/rules", rules);
app.route("/api/push", push);
app.route("/api/ai", ai);
app.route("/api/domains", domains);
app.route("/api/admin", admin);
app.route("/api/sending", sending);
app.route("/api/attachments", attachments);

app.get("/api/health", (c) => c.json({ ok: true }));

app.notFound((c) => c.json({ error: "not found" }, 404));

// Single worker: HTTP (SPA + API) via Hono, plus inbound email + undo-send cron.
export default {
  fetch: app.fetch,
  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext) {
    await ensureSchema(env.DB);
    await handleEmail(message, env, ctx);
  },
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(ensureSchema(env.DB).then(() => runScheduled(env)));
  },
};
