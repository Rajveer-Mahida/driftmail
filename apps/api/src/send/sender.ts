// Choosing the From address.
//
// Three call sites each resolved this slightly differently, and the fallback used
// to come from a REPLY_FROM env var that most deployments never set.

import { getPrimaryDomain, listDomains } from "../config/domains.ts";
import { SendError } from "./types.ts";
import { resolveRecipient } from "../routing.ts";

type DB = D1Database;

/** Who is sending. Without it (system mail such as the setup test) the
 *  domain default is used. */
export type Sender = { id: string; email: string; handle: string; role: string };

export type ParentMessage = {
  direction: "in" | "out";
  to_addr: string;
  from_addr: string;
} | null;

/**
 * Precedence:
 *   1. an address the caller chose explicitly — only one the sender owns;
 *   2. the alias this thread belongs to — for inbound mail that is the address it
 *      arrived at, so a reply comes from the alias the sender already knows;
 *   3. the signed-in user's own address: their login email when it is on one of
 *      this instance's domains, otherwise <handle>@<primary domain>;
 *   4. with no user: the primary domain's default_from, then reply@<domain>;
 *   5. no sender — throw rather than invent one.
 */
export async function resolveFrom(
  db: DB,
  opts: { explicit?: string | null; parent?: ParentMessage; user?: Sender | null },
): Promise<string> {
  const user = opts.user ?? null;
  const domains = await listDomains(db);
  const onOurDomain = (addr: string) => {
    const d = addr.split("@")[1]?.toLowerCase();
    return !!d && domains.some((x) => x.domain.toLowerCase() === d);
  };

  const explicit = opts.explicit?.trim().toLowerCase();
  if (explicit) {
    if (!user || (await mayUseAddress(db, user, explicit, onOurDomain))) return explicit;
    throw new SendError("no_sender", `You can't send as ${explicit}`, {
      provider: "none",
      hint: "Send from your own address or one of your aliases.",
    });
  }

  const parent = opts.parent;
  if (parent) {
    const alias = (parent.direction === "in" ? parent.to_addr : parent.from_addr)?.trim();
    if (alias && (!user || (await mayUseAddress(db, user, alias, onOurDomain)))) return alias;
  }

  const primary = (await getPrimaryDomain(db)) ?? domains[0] ?? null;

  if (user) {
    if (onOurDomain(user.email)) return user.email.toLowerCase();
    if (primary?.domain) return `${user.handle}@${primary.domain}`;
  }

  if (primary?.default_from?.trim()) return primary.default_from.trim();
  if (primary?.domain) return `reply@${primary.domain}`;

  throw new SendError("no_sender", "No sender address is available", {
    provider: "none",
    hint: "Add a mail domain under Settings → Domains, then set its default From address.",
  });
}

/**
 * Whether `user` may send as `address`: their own email, or any address on this
 * instance's domains that would be delivered to them (handle, handle.tag, an
 * alias they own). Admins may use any address on the instance's domains.
 */
export async function mayUseAddress(
  db: DB,
  user: Sender,
  address: string,
  onOurDomain: (addr: string) => boolean,
): Promise<boolean> {
  const a = address.trim().toLowerCase();
  if (a === user.email.toLowerCase()) return true;
  if (!onOurDomain(a)) return false;
  if (user.role === "admin") return true;
  const route = await resolveRecipient(db, a);
  // The catch-all owner would otherwise "own" every unclaimed address.
  return route.kind === "deliver" && route.userId === user.id && route.reason !== "catchall";
}
