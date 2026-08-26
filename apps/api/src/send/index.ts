// Provider resolution and the single send entry point.

import type { Env } from "../env.ts";
import { getSecret, reveal } from "../config/secrets.ts";
import { loadConfig } from "../config/index.ts";
import { matchDomain, toPolicy, listDomains, type SendProviderName } from "../config/domains.ts";
import { cloudflareProvider } from "./providers/cloudflare.ts";
import { resendProvider } from "./providers/resend.ts";
import { noneProvider } from "./providers/none.ts";
import { SendError, type OutboundMessage, type Provider, type SendResult } from "./types.ts";

export * from "./types.ts";
export { resolveFrom } from "./sender.ts";
export { loadFromR2, splitAddrs } from "./attachments.ts";

/**
 * Which provider sends mail from this address?
 *
 *   1. the sending domain's own `send_provider`, when it sets one;
 *   2. the instance default in config;
 *   3. none.
 *
 * Domain matching reuses the inbound glob logic, so `*` behaves the same in both
 * directions.
 */
export async function resolveProvider(
  env: Env,
  fromAddress: string,
): Promise<Provider> {
  const policies = (await listDomains(env.DB)).map(toPolicy);
  const domain = matchDomain(policies, fromAddress);

  let name: SendProviderName = domain?.sendProvider ?? "none";
  if (!domain?.sendProvider) {
    const cfg = await loadConfig(env.DB);
    name = (cfg["send.provider"] as SendProviderName) || "none";
  }

  switch (name) {
    case "resend": {
      const key = await getSecret(env.DB, env, "resend.api_key");
      if (!key) {
        throw new SendError("not_configured", "Resend is selected but no API key is stored", {
          provider: "resend",
          hint: "Add your Resend API key under Settings → Sending.",
        });
      }
      return resendProvider(reveal(key));
    }
    case "cloudflare":
      return cloudflareProvider(env.EMAIL);
    default:
      return noneProvider();
  }
}

/**
 * Send one message.
 *
 * Deliberately does not touch the database: every caller has its own idea of what
 * to record and when, and folding that in here is what produced the four
 * divergent copies this replaces.
 */
export async function sendMail(env: Env, msg: OutboundMessage): Promise<SendResult> {
  const from = typeof msg.from === "string" ? msg.from : msg.from.email;
  const provider = await resolveProvider(env, from);
  return provider.send(msg);
}
