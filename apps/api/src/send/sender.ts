// Choosing the From address.
//
// Three call sites each resolved this slightly differently, and the fallback used
// to come from a REPLY_FROM env var that most deployments never set.

import { getPrimaryDomain, listDomains } from "../config/domains.ts";
import { SendError } from "./types.ts";

type DB = D1Database;

export type ParentMessage = {
  direction: "in" | "out";
  to_addr: string;
  from_addr: string;
} | null;

/**
 * Precedence:
 *   1. an address the caller chose explicitly;
 *   2. the alias this thread belongs to — for inbound mail that is the address it
 *      arrived at, so a reply comes from the alias the sender already knows;
 *   3. the primary domain's configured default_from;
 *   4. reply@<primary domain>, so nothing has to be configured to work;
 *   5. no sender — throw rather than invent one.
 */
export async function resolveFrom(
  db: DB,
  opts: { explicit?: string | null; parent?: ParentMessage },
): Promise<string> {
  const explicit = opts.explicit?.trim();
  if (explicit) return explicit;

  const parent = opts.parent;
  if (parent) {
    const alias = parent.direction === "in" ? parent.to_addr : parent.from_addr;
    if (alias?.trim()) return alias.trim();
  }

  const primary = (await getPrimaryDomain(db)) ?? (await listDomains(db))[0] ?? null;
  if (primary?.default_from?.trim()) return primary.default_from.trim();
  if (primary?.domain) return `reply@${primary.domain}`;

  throw new SendError("no_sender", "No sender address is available", {
    provider: "none",
    hint: "Add a mail domain under Settings → Domains, then set its default From address.",
  });
}
