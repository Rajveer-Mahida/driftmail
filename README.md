# Driftmail

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Rajveer-Mahida/driftmail)

A private inbox that runs entirely on your own Cloudflare account. One Worker
serves the app, receives your mail, and configures its own delivery.

Deploy it, then set it up in the browser — no config files, no
`wrangler secret put`, no dashboard clicking.

Every address on your domain arrives here. `you@`, `netflix.you@`,
`you-uber@`, `anything@` — no per-address setup, ever.

---

## Setting it up

1. **Deploy it.** Click **Deploy to Cloudflare** and keep the default names, or
   from a clone:

   ```bash
   pnpm install
   pnpm run deploy               # `pnpm deploy` is a built-in pnpm command
   ```

   That's the whole deploy: build, then `wrangler deploy`. Wrangler finds the
   `driftmail` D1 database and `driftmail-mail` bucket in your account, or
   creates them. There are no ids to paste and no migrations to run.
2. **Open it in a browser.** You'll land on `/setup`. The app creates its own
   database tables on that first visit.
3. **Paste a Cloudflare API token.** Either kind works — an account-owned token
   (Manage Account → Account API Tokens; survives you leaving the account) or a
   user token (My Profile → API Tokens). The wizard lists what the token must be
   able to do and has a **Check permissions** button that tests it against the
   live API — the check is the authority, since Cloudflare's two token editors
   spell the same permissions differently. The token then turns on Email
   Routing, writes your MX and SPF records, and points your domain's catch-all
   at this Worker.
4. **Pick your first domain, then your password.** Done.
5. **More domains?** Open **Domains** in the sidebar and click **Add** next to
   any zone in the account. Same inbox, same Worker — one Driftmail serves all
   your domains.

Sending is optional and comes later in the wizard. Receiving works without it.

### Deploy with an AI agent

Paste this into an agent with terminal access (Claude Code, Codex, Cursor…):

```text
Install Driftmail from https://github.com/Rajveer-Mahida/driftmail
on my Cloudflare account. Read README.md and wrangler.jsonc first.
Ask me for my Cloudflare account ID and a deploy API token through a secret
input (Workers Scripts Edit, D1 Edit, Workers R2 Storage Edit, Account Settings
Read). Never print it, commit it, or pass it as a command argument; use it only
as CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID for Wrangler.
Keep the Worker name "driftmail". Run `pnpm install` and `pnpm run deploy`.
Do not run D1 migrations; the app does that. Give me the workers.dev URL.
I will open /setup, paste a runtime token there, and add my domains.
```

### Why the token is the first step

It is not only configuration — it is how the app knows the person filling in the
form owns this deployment. A freshly deployed Worker has no accounts, so
whoever reaches it first would otherwise become the administrator. The claim
only completes if the token belongs to the Cloudflare account that runs the
Worker serving that request, which is something an attacker cannot produce
without already controlling it.

If you'd rather not give a self-hosted app a DNS-capable token, set a
`SETUP_TOKEN` secret on the Worker after deploying and use that instead. You
then add DNS records by hand, and the setup-token path stops working 24 hours
after the deployment first starts serving traffic, so an instance you forgot
about can't be claimed later.

---

## How addresses are routed

Everyone on the instance has a **handle**. Mail is matched in this order, and
the first match wins:

| Address | Goes to | Because |
|---|---|---|
| `billing@example.com` | whoever owns that alias | an alias you created |
| `billing+vat@example.com` | the same person | the `+tag` is stripped first |
| `rajveer@example.com` | rajveer | it's their handle |
| `rajveer.netflix@example.com` | rajveer | their handle appears in the local part |
| `netflix-rajveer@example.com` | rajveer | position doesn't matter |
| `meera.aws@example.com` | meera | same rule, different person |
| `anything-else@example.com` | the domain's catch-all owner | nothing else claimed it |

Handles can't contain `.`, `-` or `+`, because those are the separators the
router splits on — which is what makes the rules unambiguous rather than a pile
of tie-breaks. When two handles appear in one address, the first one wins.

Not sure where something would land? **People → Where would mail go?** answers
it, and shows which rule decided.

---

## Sending

Chosen in the wizard, changeable in Settings:

| | Cost | Setup |
|---|---|---|
| **Resend** *(recommended)* | 3,000/month free | Paste an API key; Driftmail writes the verification records for you |
| **Cloudflare Email Sending** | Free only to destination addresses you've verified; anyone else needs Workers Paid | One click, if your DNS is on Cloudflare |
| **Receive only** | — | Nothing. Compose and reply stay disabled |

Resend is the default because "send to anyone" is what a mail client does, and
that is the part Cloudflare charges for.

---

## Adding people

**People → Add someone.** They get their own inbox — mail, labels, drafts,
rules and aliases are all private to them. You're handed a temporary password to
pass on, shown once; they're required to change it when they first sign in.

There's no emailed invite on purpose: outbound sending may not be verified at
the moment you add the second person, which would make an emailed link the one
flow guaranteed to be broken on day one.

---

## Where your secrets live

**The database is the secret store.** Your Cloudflare API token, your Resend
key, and the session signing key are all rows in D1. Anyone who can read that
database — anyone with access to your Cloudflare account, or anyone who can
deploy code to this Worker — can read them in plaintext.

That is the same exposure as `wrangler secret`: those aren't shown in the
dashboard either, but anyone who can deploy the Worker can print them. Moving
them into D1 doesn't widen the blast radius; it makes it visible.

Encrypting them under a key stored *in the same database* would not change any
of that, so Driftmail doesn't pretend to. What actually helps:

- **Scope the token.** The wizard nudges you toward a token limited to the one
  zone you use for mail. A token that can't touch your other domains is worth
  more than encryption around one that can.
- **Rotate it.** Roll it in the Cloudflare dashboard. (Replacing the stored token from inside the app is not built yet.)
- **Optionally, bring your own key.** Set a `CONFIG_ENC_KEY` secret on the
  Worker and stored credentials are wrapped with AES-GCM under it. That key
  lives outside the database, so it *is* a real boundary — against a leaked D1
  export, specifically. Off by default, and defence in depth rather than the
  thing standing between you and disaster.

---

## Resource names

Fixed, and the same in every account:

| | |
|---|---|
| Worker | `driftmail` |
| D1 database | `driftmail` |
| R2 bucket | `driftmail-mail` |

Domains are data in that database, not part of the names — so adding a domain
never means a new deployment, and nothing has to be decided before deploying.

The Worker name matters: Cloudflare's catch-all rule points at a Worker **by
name**. Setup detects it from the hostname you open, falling back to
`driftmail`. If you deploy under another name, set a `WORKER_NAME` var on the
Worker, or change it on the Domains page.

## Local development

```bash
pnpm install
pnpm db:local          # optional: the app also initializes an empty local D1 itself
pnpm dev:api           # the Worker, on :8787
pnpm dev               # the SPA, on :5173 (proxies /api to :8787)
```

Then open <http://localhost:5173/setup>. There's no real hostname for the
ownership check to verify against locally, so put `SETUP_TOKEN=dev` in
`.dev.vars` and claim the instance with that.

```bash
pnpm test              # node --test, no runner, no build step
pnpm typecheck
```

The test suite runs against the real migration files through a `node:sqlite`
adapter, so the schema itself is under test — the CHECK constraints, the partial
unique index on `domains`, and the FTS5 triggers all get exercised.

---

## What's where

```
apps/api/src/
  index.ts         Worker entry: HTTP, inbound email, cron
  middleware.ts    setup gate → session gate → admin gate
  routing.ts       which mailbox an address belongs to
  users.ts         identity, password hashing, admin operations
  auth.ts          session tokens
  cloudflare.ts    the REST client that configures your mail
  config/          instance config, credentials, per-domain policy
  send/            provider-agnostic outbound (Resend, Cloudflare, none)
  routes/          the HTTP surface
apps/web/src/
  components/setup/  the first-run wizard
packages/shared/     the JSON contract between the two
scripts/
  bundle-migrations.mjs  packs apps/api/migrations into the Worker
```

## Deploying updates

`pnpm run deploy` builds and deploys. It never touches the database.

When a new version brings migrations, admins see **Database update available**
in Settings; **Update database** applies them. Each migration runs in one D1
batch with its `d1_migrations` ledger row — the same ledger `wrangler d1
migrations apply` writes, so Wrangler still works for manual recovery:

```bash
npx wrangler d1 migrations apply DB --remote
```

Adding a migration: put a new `apps/api/migrations/NNNN_name.sql` in place and
run `pnpm db:bundle` (build and `dev:api` do it too). The test suite fails if
the committed bundle is stale.
