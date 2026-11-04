// Per-user preferences, as opposed to the instance-wide `config` table.
//
// Signature, image-blocking and the alias domain are personal choices; the
// compose/reply kill switches are not, and stay in `config`.

import type { UserId } from "@email/shared";

type DB = D1Database;

export type UserSettingKey =
  | "signature"
  | "block_remote_images"
  | "image_allowlist"
  | "primary_domain"
  | "templates";

export async function getUserSetting(
  db: DB,
  userId: UserId,
  key: UserSettingKey,
): Promise<string | null> {
  const row = await db
    .prepare(`SELECT value FROM user_settings WHERE user_id = ? AND key = ?`)
    .bind(userId, key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

export async function setUserSetting(
  db: DB,
  userId: UserId,
  key: UserSettingKey,
  value: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?)
         ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`,
    )
    .bind(userId, key, value)
    .run();
}

/** Never throws: a corrupt row falls back to an empty list rather than breaking
 *  the whole settings page. */
export function parseList(raw: string | null): string[] {
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}
