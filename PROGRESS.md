# Driftmail — Progress Tracker

One Cloudflare Worker, `driftmail`: SPA (Vite/React 19) + Hono JSON API + inbound
email for every added domain + undo-send/scheduled cron, on D1 `driftmail` and R2
`driftmail-mail`. Domains are added in the app (Domains page), not by deploying
more instances.

## ✅ Completed

### Foundation
- [x] Monorepo: `apps/web` (Vite SPA), `apps/api` (Hono worker), `packages/shared` (types)
- [x] Clean worker/frontend split, single worker serves both on one host
- [x] Cutover: legacy Next.js + email workers deleted; `smi-mail` owns everything
- [x] Inbox views (inbox/starred/snoozed/archived/sent/trash), labels, threads
- [x] Read/unread, star, archive, snooze, trash, bulk actions, optimistic UI
- [x] Reply + undo-send, reply-from-alias
- [x] Attachments (download, inline cid, per-thread)
- [x] App dark mode + per-email dark reading mode (invert filter)
- [x] Mobile drawer, swipe-to-archive, Framer Motion animations
- [x] HMAC cookie auth, login gate

### Phase 1 — Compose & sending
- [x] New compose (docked panel), forward, reply-all, CC/BCC
- [x] Outgoing attachments (R2 upload → send)
- [x] Drafts (autosave, Drafts view, resume/delete)
- [x] Signature (Settings editor, auto-appended)
- [x] Send-later (schedule) + 8s undo flush

### Phase 2 — Managed aliases
- [x] Alias registry (`/aliases`): create named/custom/generated, notes, copy
- [x] Mail counts per alias, auto-track on first inbound
- [x] Disable/burn (bounces inbound), delete (keeps mail)
- [x] "View inbox" filter by alias

### Phase 3 — Privacy + scheduled send
- [x] Block remote tracker images by default (cid/inline kept)
- [x] Per-email "Show in this email" (persists) + per-sender "Always allow" + global toggle
- [x] Scheduled-send badge + Cancel in reading pane; reply send-later

### Phase 4 — Filters / rules
- [x] Rules engine: if from/to/subject contains/is/starts/ends → label/archive/read/trash
- [x] Applied on ingest + "Run on existing" (last 1000)
- [x] Rules builder in Settings

### Phase 5 — Search + performance
- [x] Search operators: `from:` `to:` `subject:` `has:attachment` `is:unread|read|starred` + free-text FTS
- [x] Infinite scroll (past the 50 cap, IntersectionObserver)
- [x] Route code-splitting (lazy) + vendor chunks (main bundle 677KB → ~266KB)

### Phase 6 — Command palette + shortcuts
- [x] ⌘K / Ctrl-K command palette (cmdk): go-to, actions, labels, search
- [x] Keyboard help dialog (`?`)
- [x] Shortcuts: `c` compose, `/` search, `g i/s/n/e/t` views, `j/k` row nav + Enter, in-message `r/e/s/#/Esc`

### Phase 7 — Web push + PWA
- [x] Installable PWA (manifest + service worker + icons)
- [x] Web Push (VAPID, no-payload) → new-mail notification on the SW
- [x] Subscribe/unsubscribe API + `push_subscriptions` table
- [x] Settings "New-mail notifications" enable/disable

### Phase 8 — AI summarize + smart reply
- [x] `POST /api/ai/summarize` (thread → 2–4 sentence summary) via Claude Messages API (`claude-haiku-4-5`, raw fetch)
- [x] `POST /api/ai/smart-reply` (thread → 3 reply drafts, structured output)
- [x] Summarize button + summary card + "Suggest" chips in `MailDetail` (chips prefill the composer)
- [x] Graceful 503 when `ANTHROPIC_API_KEY` unset → "AI not set up yet" toast
- Model overridable via `AI_MODEL` var

## 🎉 All 8 phases complete

## Deploy
`pnpm run deploy` = `pnpm build` (bundles migrations + builds the SPA) + `wrangler deploy`.
Wrangler finds or creates D1 `driftmail` and R2 `driftmail-mail` by name.
The Worker applies migrations itself: automatically on an empty database, and
from Settings → "Update database" afterwards. See README → Deploying updates.

Optional Worker secrets/vars: `SETUP_TOKEN`, `CONFIG_ENC_KEY`, `WORKER_NAME`,
`ANTHROPIC_API_KEY` (AI summarize / smart reply).
