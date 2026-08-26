// Instance-wide behaviour switches.
//
// Everything else that used to live here — the ALIAS_DOMAINS / ALLOWED_EMAILS /
// ALIAS_SUFFIX / REPLY_FROM env readers and the recipient policy — now lives in
// config/domains.ts, and the per-user preferences in config/user.ts.

import { getConfig, setConfig } from "./config/index.ts";

type DB = D1Database;

/** Replies are off until someone turns them on: an inbox that can receive but
 *  not send is a safe default for a fresh instance. */
export async function getReplyEnabled(db: DB): Promise<boolean> {
  return getConfig(db, "mail.reply_enabled");
}

export async function setReplyEnabled(db: DB, enabled: boolean): Promise<void> {
  await setConfig(db, { "mail.reply_enabled": enabled });
}

export async function getComposeEnabled(db: DB): Promise<boolean> {
  return getConfig(db, "mail.compose_enabled");
}

export async function setComposeEnabled(db: DB, enabled: boolean): Promise<void> {
  await setConfig(db, { "mail.compose_enabled": enabled });
}
