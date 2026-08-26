// Undo-send cron. Sends pending messages whose send_after has elapsed; this
// worker is the single owner of the schedule.
//
// The job stays instance-wide on purpose: identity comes from each row, not from
// a session, so there is nothing to scope it to.

import type { Env } from "./env.ts";
import { duePending, flushPending } from "./send/outbox.ts";

export async function runScheduled(env: Env): Promise<void> {
  for (const id of await duePending(env)) {
    try {
      await flushPending(env, id);
    } catch {
      // flushPending has already parked the row in its resting state — 'pending'
      // to retry next tick, or 'failed' when a retry could never work.
    }
  }
}
