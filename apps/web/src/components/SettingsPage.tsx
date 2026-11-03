import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { useNavigate } from "@tanstack/react-router";
import * as Switch from "@radix-ui/react-switch";
import * as Dialog from "@radix-ui/react-dialog";
import { motion } from "framer-motion";
import { toast } from "sonner";
import {
  ArrowLeft,
  Check,
  Sun,
  Moon,
  Mail,
  Globe,
  Palette,
  PenLine,
  ShieldCheck,
  ShieldAlert,
  Bell,
  Database,
} from "lucide-react";
import {
  useSettings,
  useSetSettings,
} from "@/api/hooks";
import { useUI } from "@/lib/store";
import { PasswordInput, Button, Spinner } from "@/components/primitives";
import { Section } from "@/components/Section";
import { RulesManager } from "@/components/RulesManager";
import { pushSupported, pushEnabled, enablePush, disablePush } from "@/lib/push";
import { cn } from "@/lib/utils";

const ACCENTS: { name: string; label: string }[] = [
  { name: "amber", label: "Amber" },
  { name: "orange", label: "Orange" },
  { name: "red", label: "Red" },
  { name: "pink", label: "Pink" },
  { name: "violet", label: "Violet" },
  { name: "indigo", label: "Indigo" },
  { name: "blue", label: "Blue" },
  { name: "cyan", label: "Cyan" },
  { name: "teal", label: "Teal" },
  { name: "emerald", label: "Emerald" },
  { name: "lime", label: "Lime" },
  { name: "slate", label: "Slate" },
];

export function SettingsPage() {
  const navigate = useNavigate();
  const settings = useSettings();
  const save = useSetSettings();
  const { theme, toggleTheme, accent, setAccent } = useUI();

  const s = settings.data;

  const isAdmin = s?.user.role === "admin";

  const [sig, setSig] = useState("");
  useEffect(() => {
    if (s?.signature !== undefined) setSig(s.signature);
  }, [s?.signature]);

  return (
    <div className="scroll-thin h-full min-w-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-2xl px-6 py-8 md:px-10">
        <button
          onClick={() => navigate({ to: "/" })}
          className="mb-6 inline-flex items-center gap-2 text-sm text-muted transition hover:text-fg"
        >
          <ArrowLeft size={16} /> Back to inbox
        </button>

        <h1 className="mb-8 font-display text-3xl font-semibold tracking-tight">Settings</h1>

        <div className="space-y-4">
          {/* Instance-wide controls are admin-only on the server, so a
              non-admin gets nothing but 403s from them — showing them anyway
              renders as the word "forbidden" where content should be. */}
          {isAdmin && (
          <>
          {/* Replies */}
          <Section icon={<Mail size={18} />} title="Replies" desc="Allow sending replies from this inbox.">
            <Switch.Root
              checked={!!s?.reply_enabled}
              onCheckedChange={(v) =>
                save.mutate(
                  { reply_enabled: v },
                  { onSuccess: () => toast.success(v ? "Replies enabled" : "Replies disabled") },
                )
              }
              className="relative h-7 w-12 rounded-full bg-border-strong transition-colors data-[state=checked]:bg-accent"
            >
              <Switch.Thumb className="block h-5 w-5 translate-x-1 rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-6" />
            </Switch.Root>
          </Section>

          {/* Compose */}
          <Section icon={<PenLine size={18} />} title="Compose" desc="Allow composing and forwarding new emails.">
            <Switch.Root
              checked={s?.compose_enabled ?? true}
              onCheckedChange={(v) =>
                save.mutate(
                  { compose_enabled: v },
                  { onSuccess: () => toast.success(v ? "Compose enabled" : "Compose disabled") },
                )
              }
              className="relative h-7 w-12 rounded-full bg-border-strong transition-colors data-[state=checked]:bg-accent"
            >
              <Switch.Thumb className="block h-5 w-5 translate-x-1 rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-6" />
            </Switch.Root>
          </Section>
          </>
          )}

          {/* Privacy */}
          <Section
            icon={<ShieldCheck size={18} />}
            title="Block remote images"
            desc="Hide remote images until you load them — stops tracking pixels."
          >
            <Switch.Root
              checked={s?.block_remote_images ?? true}
              onCheckedChange={(v) =>
                save.mutate(
                  { block_remote_images: v },
                  { onSuccess: () => toast.success(v ? "Remote images blocked" : "Remote images allowed") },
                )
              }
              className="relative h-7 w-12 rounded-full bg-border-strong transition-colors data-[state=checked]:bg-accent"
            >
              <Switch.Thumb className="block h-5 w-5 translate-x-1 rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-6" />
            </Switch.Root>
          </Section>

          {/* Primary domain */}
          <Section
            icon={<Globe size={18} />}
            title="Primary alias domain"
            desc="Used when generating new aliases."
            stack
          >
            <div className="mt-3 flex flex-wrap gap-2">
              {s?.domains.map((d: string) => {
                const active = s.primary_domain === d;
                return (
                  <button
                    key={d}
                    onClick={() =>
                      save.mutate(
                        { primary_domain: d },
                        { onSuccess: () => toast.success(`Primary domain: ${d}`) },
                      )
                    }
                    className={cn(
                      "flex items-center gap-2 rounded-full border px-4 py-2 font-mono text-sm transition",
                      active
                        ? "border-accent bg-accent-soft text-accent"
                        : "border-border text-muted hover:border-accent-ring hover:text-fg",
                    )}
                  >
                    {active && <Check size={15} />}
                    {d}
                  </button>
                );
              })}
            </div>
          </Section>

          {/* Domains have their own page now; this is the signpost. */}
          {isAdmin && (
            <Section
              icon={<Globe size={18} />}
              title="Domains"
              desc="Add, remove and check the mail domains this instance serves."
            >
              <Button size="sm" onClick={() => navigate({ to: "/domains" })}>
                Manage
              </Button>
            </Section>
          )}

          {/* Only shows up when a deploy brought migrations the database
              doesn't have yet. */}
          {isAdmin && <DatabaseSection />}

          {/* Appearance */}
          <Section icon={<Palette size={18} />} title="Appearance" desc="Switch between light and dark.">
            <button
              onClick={toggleTheme}
              className="flex items-center gap-2 rounded-full border border-border px-4 py-2 text-sm transition hover:border-accent-ring"
            >
              {theme === "dark" ? <Moon size={16} /> : <Sun size={16} />}
              {theme === "dark" ? "Dark" : "Light"}
            </button>
          </Section>

          {/* Accent color */}
          <Section
            icon={<Palette size={18} />}
            title="Accent color"
            desc="Pick the highlight color used across the app."
            stack
          >
            <div className="mt-3 grid grid-cols-3 gap-2.5 sm:grid-cols-4">
              {ACCENTS.map((a) => {
                const active = accent === a.name;
                return (
                  <button
                    key={a.name}
                    data-accent={a.name}
                    onClick={() => setAccent(a.name)}
                    aria-label={a.label}
                    title={a.label}
                    className={cn(
                      // local theme scope: data-accent gives this tile the preset's
                      // vars; the `dark` class pulls its dark values when in dark mode.
                      theme === "dark" && "dark",
                      "group rounded-xl border bg-bg p-2 text-left transition",
                      active
                        ? "border-accent ring-2 ring-accent"
                        : "border-border hover:border-accent-ring",
                    )}
                  >
                    {/* mini app preview */}
                    <div className="rounded-lg border border-border bg-surface p-2">
                      <div className="mb-1.5 h-2 w-7 rounded-full bg-accent" />
                      <div className="space-y-1">
                        <div className="h-1.5 w-full rounded bg-inset" />
                        <div className="h-1.5 w-2/3 rounded bg-inset" />
                      </div>
                    </div>
                    <div className="mt-1.5 flex items-center gap-1 px-0.5">
                      {active ? (
                        <Check size={13} strokeWidth={3} className="text-accent" />
                      ) : (
                        <span className="h-2 w-2 rounded-full bg-accent" />
                      )}
                      <span className="text-xs font-medium text-fg">{a.label}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          </Section>

          {/* Signature */}
          <Section
            icon={<PenLine size={18} />}
            title="Signature"
            desc="Appended to new messages you compose."
            stack
          >
            <div className="mt-3">
              <textarea
                value={sig}
                onChange={(e) => setSig(e.target.value)}
                rows={4}
                placeholder="Rajveer Mahida&#10;Software Engineer"
                className="w-full resize-none rounded-[var(--radius-lg)] border border-border bg-bg px-3 py-2.5 text-sm outline-none focus:border-accent-ring"
              />
              <div className="mt-2 flex justify-end">
                <Button
                  size="sm"
                  variant="primary"
                  disabled={sig === (s?.signature ?? "")}
                  onClick={() =>
                    save.mutate(
                      { signature: sig },
                      { onSuccess: () => toast.success("Signature saved") },
                    )
                  }
                >
                  Save signature
                </Button>
              </div>
            </div>
          </Section>

          {/* Notifications */}
          <Section
            icon={<Bell size={18} />}
            title="New-mail notifications"
            desc="Get a desktop/mobile push when mail arrives. Install the app for best results."
          >
            <NotificationsToggle />
          </Section>

          <RulesManager />

          {isAdmin && <DangerZone />}
        </div>
      </div>
    </div>
  );
}

/**
 * Deploying never touches the database. When new code ships migrations, an
 * admin applies them here — the same runner that initialized the database on
 * first visit (apps/api/src/migrations/runner.ts).
 */
function DatabaseSection() {
  const qc = useQueryClient();
  const status = useQuery({
    queryKey: ["admin", "migrations"],
    queryFn: api.migrationStatus,
    staleTime: 60_000,
  });
  const [busy, setBusy] = useState(false);
  const pending = status.data?.pending ?? [];

  if (!status.data || (status.data.managed && pending.length === 0)) return null;

  async function update() {
    setBusy(true);
    try {
      const res = await api.applyMigrations();
      toast.success(
        `Database updated (${res.applied.length} migration${res.applied.length === 1 ? "" : "s"})`,
      );
      await qc.invalidateQueries();
    } catch (err) {
      toast.error((err as Error).message);
      await qc.invalidateQueries({ queryKey: ["admin", "migrations"] });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section
      icon={<Database size={18} />}
      title={status.data.managed ? "Database update available" : "Database not managed"}
      desc={
        status.data.managed
          ? `This version needs ${pending.length} database migration${pending.length === 1 ? "" : "s"}: ${pending.join(", ")}. Some features may fail until it's applied.`
          : "This database has tables but no migration history, so Driftmail won't change it. Apply migrations with Wrangler instead."
      }
      stack
    >
      {status.data.managed && (
        <div className="mt-3">
          <Button variant="primary" size="sm" disabled={busy} onClick={() => void update()}>
            {busy ? "Updating…" : "Update database"}
          </Button>
        </div>
      )}
    </Section>
  );
}

function NotificationsToggle() {
  const [supported] = useState(() => pushSupported());
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    pushEnabled().then(setEnabled);
  }, []);

  if (!supported) return <span className="text-sm text-faint">Not supported here</span>;

  async function toggle() {
    setBusy(true);
    try {
      if (enabled) {
        await disablePush();
        setEnabled(false);
        toast.success("Notifications off");
      } else {
        const ok = await enablePush();
        setEnabled(ok);
        ok ? toast.success("Notifications on") : toast.error("Permission denied");
      }
    } catch (e) {
      toast.error((e as Error).message || "Failed");
    }
    setBusy(false);
  }

  return (
    <Button variant={enabled ? "soft" : "primary"} size="sm" onClick={toggle} disabled={busy}>
      {busy ? <Spinner /> : <Bell size={15} />}
      {enabled ? "Disable" : "Enable"}
    </Button>
  );
}


/**
 * Factory reset — wipe the instance back to /setup.
 *
 * Two gates on purpose: typing RESET keeps a wandering click harmless, and the
 * password re-entry keeps a hijacked or forgotten-open session from being
 * enough. The server enforces both; this dialog just collects them.
 */
function DangerZone() {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  async function reset() {
    setBusy(true);
    try {
      const res = await fetch("/api/admin/reset", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm, password }),
      });
      const body = (await res.json()) as { error?: string; warnings?: string[] };
      if (!res.ok) {
        toast.error(body.error ?? "Reset failed");
        return;
      }
      for (const w of body.warnings ?? []) toast.warning(w, { duration: 15000 });
      // The session, the account and the setup-status cache are all gone with
      // the data — a full load lands cleanly on /setup.
      window.location.href = "/setup";
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-8 space-y-3">
      <p className="text-xs font-semibold uppercase tracking-wider text-red-700/70 dark:text-red-400/80">
        Danger zone
      </p>

      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        className="rounded-2xl border border-red-500/20 bg-red-500/8 p-5 dark:border-red-500/15 dark:bg-red-950/35"
      >
        <div className="flex items-center gap-4">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-red-500/10 text-red-600 dark:text-red-400">
            <ShieldAlert size={18} />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="font-medium text-fg">Factory reset</h3>
            <p className="text-sm text-muted">
              Erase everything — mail, people, domains, credentials — and return this deployment to
              its setup screen.
            </p>
          </div>
          <Button
            variant="outline"
            className="shrink-0 border-red-500/25 text-red-700 hover:bg-red-500/10 dark:text-red-400 dark:hover:bg-red-500/10"
            onClick={() => setOpen(true)}
          >
            Reset…
          </Button>
        </div>
      </motion.div>

      <Dialog.Root
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) {
            setConfirm("");
            setPassword("");
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(26rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border bg-elevated p-5 shadow-[var(--shadow-lg)]">
            <Dialog.Title className="font-display text-lg font-semibold">
              Reset this instance?
            </Dialog.Title>
            <Dialog.Description className="mt-2 text-sm text-muted">
              Every message, attachment, person, domain and credential is permanently deleted, and
              Cloudflare stops routing mail here. The deployment returns to its first-run setup.
              There is no undo.
            </Dialog.Description>

            <label className="mt-4 block text-xs font-semibold uppercase tracking-wider text-muted">
              Type RESET
            </label>
            <input
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className="mt-1.5 w-full rounded-[var(--radius-lg)] border border-border bg-bg px-3 py-2 font-mono text-sm outline-none focus:border-accent-ring"
            />

            <label className="mt-3 block text-xs font-semibold uppercase tracking-wider text-muted">
              Your password
            </label>
            <PasswordInput
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1.5 w-full rounded-[var(--radius-lg)] border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent-ring"
            />

            <div className="mt-5 flex justify-end gap-2">
              <Button onClick={() => setOpen(false)}>Cancel</Button>
              <Button
                variant="primary"
                disabled={confirm !== "RESET" || !password || busy}
                onClick={() => void reset()}
              >
                {busy ? "Erasing…" : "Erase everything"}
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
