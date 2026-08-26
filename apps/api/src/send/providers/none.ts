// The placeholder for a receive-only instance.
//
// It throws rather than silently succeeding: a compose that vanishes without a
// trace is far worse than one that says sending isn't set up yet.

import { SendError, type Provider } from "../types.ts";

export function noneProvider(): Provider {
  return {
    name: "none",
    async send(): Promise<never> {
      throw new SendError("not_configured", "Sending is not set up on this instance", {
        provider: "none",
        hint: "Choose a sending provider under Settings → Sending.",
      });
    },
  };
}
