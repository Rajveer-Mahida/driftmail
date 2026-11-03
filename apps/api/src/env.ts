export interface EmailAttachmentOut {
  content: ArrayBuffer | string;
  filename: string;
  type?: string;
  disposition?: "attachment" | "inline";
  contentId?: string;
}

export interface SendEmailBinding {
  send(opts: {
    to: string | string[];
    cc?: string | string[];
    bcc?: string | string[];
    from: string | { email: string; name?: string };
    replyTo?: string;
    subject: string;
    html?: string;
    text?: string;
    attachments?: EmailAttachmentOut[];
    headers?: Record<string, string>;
  }): Promise<{ messageId: string }>;
}

export type Env = {
  // Bindings — see wrangler.jsonc.
  DB: D1Database;
  EMAIL_CACHE: R2Bucket;
  EMAIL: SendEmailBinding;
  ASSETS: Fetcher;

  // Two OPTIONAL secrets, set in the dashboard after deploy. Neither is required
  // and neither is declared in wrangler.jsonc, so the deploy form stays empty.
  //
  // Everything else this app needs — mail domains, the Cloudflare API token, the
  // session signing key, provider keys, VAPID keys — lives in D1 and is written
  // by the setup wizard. See apps/api/src/config/.
  //
  // SETUP_TOKEN     accepted by /api/setup/claim instead of a Cloudflare API
  //                 token, for operators who won't hand a DNS-capable token to a
  //                 self-hosted app, and for local development.
  // CONFIG_ENC_KEY  wraps stored credentials at rest. Only worth setting because
  //                 it lives OUTSIDE the database — see config/secrets.ts.
  SETUP_TOKEN?: string;
  CONFIG_ENC_KEY?: string;

  // OPTIONAL. Only needed if you deploy this Worker under a name other than
  // "driftmail": the Email Routing catch-all points at the Worker BY NAME, and
  // on localhost there is no hostname to detect it from.
  WORKER_NAME?: string;

  // OPTIONAL, for copies made with the Deploy to Cloudflare button: lets admins
  // pull upstream updates from Settings. See .github/workflows/sync-upstream.yml.
  //   GITHUB_UPDATE_TOKEN   secret: fine-grained token for the copy
  //                         (Contents, Actions, Workflows: read and write)
  //   GITHUB_UPDATE_REPO    var: "owner/repo" of the copy
  //   GITHUB_UPDATE_REF     var: branch Cloudflare deploys (default: repo default)
  //   DRIFTMAIL_UPSTREAM    var: upstream "owner/repo" (default Rajveer-Mahida/driftmail)
  //   DRIFTMAIL_UPSTREAM_REF var: upstream branch (default master)
  GITHUB_UPDATE_TOKEN?: string;
  GITHUB_UPDATE_REPO?: string;
  GITHUB_UPDATE_REF?: string;
  DRIFTMAIL_UPSTREAM?: string;
  DRIFTMAIL_UPSTREAM_REF?: string;

  // LOCAL DEVELOPMENT ONLY. Set to "1" in .dev.vars to let /api/setup/claim
  // accept a Cloudflare API token without proving that the token's account runs
  // the Worker — impossible on localhost, since no Worker serves it.
  //
  // Also requires a loopback hostname, but THIS is the condition that matters:
  // the Host header is client-controlled, so the hostname alone would be a
  // bypass rather than a boundary. Never set this on a deployed Worker.
  DEV_UNSAFE_SKIP_OWNERSHIP?: string;
};

/** Set by the session middleware; every authenticated handler reads it. */
export type Variables = { user: import("@email/shared").SessionUser };

/** Hono context env shape. */
export type HonoEnv = { Bindings: Env; Variables: Variables };
