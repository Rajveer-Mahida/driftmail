import { Hono } from "hono";
import type { HonoEnv } from "../env.ts";
import { getMessage } from "../db.ts";
import { scopeOf } from "../middleware.ts";
import { aiConfigured, callClaude, threadText } from "../ai.ts";

export const ai = new Hono<HonoEnv>();

ai.post("/summarize", async (c) => {
  if (!(await aiConfigured(c.env))) return c.json({ error: "AI not configured" }, 503);
  const { messageId } = await c.req
    .json<{ messageId?: string }>()
    .catch(() => ({}) as { messageId?: string });
  if (!messageId) return c.json({ error: "messageId required" }, 400);

  const msg = await getMessage(c.env.DB, scopeOf(c), messageId);
  if (!msg) return c.json({ error: "not found" }, 404);

  try {
    const summary = await callClaude(c.env, {
      system:
        "You summarize email threads. Reply with 2–4 tight sentences in plain text. Lead with what the thread is about, then any decision or action needed. No preamble, no markdown headers.",
      user: await threadText(c.env.DB, scopeOf(c), msg),
      maxTokens: 350,
    });
    return c.json({ summary: summary.trim() });
  } catch (err) {
    return c.json({ error: (err as Error)?.message ?? "summarize failed" }, 500);
  }
});

ai.post("/smart-reply", async (c) => {
  if (!(await aiConfigured(c.env))) return c.json({ error: "AI not configured" }, 503);
  const { messageId } = await c.req
    .json<{ messageId?: string }>()
    .catch(() => ({}) as { messageId?: string });
  if (!messageId) return c.json({ error: "messageId required" }, 400);

  const msg = await getMessage(c.env.DB, scopeOf(c), messageId);
  if (!msg) return c.json({ error: "not found" }, 404);

  try {
    const raw = await callClaude(c.env, {
      system:
        "You draft reply options for an email thread, written from the perspective of the person who would reply next. Give 3 short, distinct options (1–2 sentences each) that vary in tone or stance (e.g. agree, ask a question, decline politely). Plain text, no signatures, no greetings unless natural.",
      user: await threadText(c.env.DB, scopeOf(c), msg),
      maxTokens: 500,
      schema: {
        type: "object",
        properties: {
          replies: { type: "array", items: { type: "string" } },
        },
        required: ["replies"],
        additionalProperties: false,
      },
    });
    let replies: string[] = [];
    try {
      replies = (JSON.parse(raw).replies ?? []).filter((s: unknown) => typeof s === "string");
    } catch {
      replies = raw.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean).slice(0, 3);
    }
    return c.json({ replies: replies.slice(0, 3) });
  } catch (err) {
    return c.json({ error: (err as Error)?.message ?? "smart-reply failed" }, 500);
  }
});
