import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/api/client";
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
} from "lucide-react";
import {
  useSettings,
  useSetSettings,
  useDomains,
  useDisconnectDomain,
} from "@/api/hooks";
import { useUI } from "@/lib/store";
import { PasswordInput, Button, Spinner, Tip } from "@/components/primitives";
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

          {/* Domains — admin-only (the whole API is), and only once a
              Cloudflare token is stored. */}
          {isAdmin && s?.domain_management && <DomainsSection />}

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

function Section({
  icon,
  title,
  desc,
  children,
  stack,
}: {
  icon: React.ReactNode;
  title: string;
  desc: string;
  children: React.ReactNode;
  stack?: boolean;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-2xl border border-border bg-elevated p-5"
    >
      <div className={cn("flex gap-4", !stack && "items-center")}>
        <span className="mt-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-inset text-muted">
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="font-medium">{title}</h3>
          <p className="text-sm text-muted">{desc}</p>
          {stack && children}
        </div>
        {!stack && <div className="shrink-0">{children}</div>}
      </div>
    </motion.div>
  );
}

/**
 * The mail domains this instance handles.
 *
 * Only rendered once a Cloudflare API token is stored — every /api/domains
 * route returns 503 otherwise. Adding a domain happens in the setup wizard,
 * which has the room to explain what enabling Email Routing does to the zone's
 * existing MX records; this is the after-the-fact view.
 */
function DomainsSection() {
  const qc = useQueryClient();
  const domains = useDomains(true);
  const disconnect = useDisconnectDomain();
  const [busy, setBusy] = useState<string | null>(null);
  /** The domain whose Remove has been clicked once — confirmation pending. */
  const [confirming, setConfirming] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [mxConfirm, setMxConfirm] = useState<{ zoneId: string; name: string; mx: string[] } | null>(
    null,
  );

  const zones = useQuery({
    queryKey: ["domains", "zones"],
    queryFn: api.listZones,
    enabled: adding,
    staleTime: 30_000,
  });

  async function add(zoneId: string, name: string, confirmOverwriteMx = false) {
    setBusy(name);
    try {
      await api.addDomain({ zoneId, domain: name, confirmOverwriteMx });
      toast.success(`${name} now routes here`, {
        description: "Mail to any address on it will arrive in this inbox.",
      });
      setAdding(false);
      setMxConfirm(null);
      await qc.invalidateQueries({ queryKey: ["domains"] });
      await qc.invalidateQueries({ queryKey: ["settings"] });
    } catch (err) {
      const body = (err as ApiError & { body?: { error?: string; currentMx?: string[] } }).body;
      if (body?.error === "mx_in_use" && body.currentMx) {
        setMxConfirm({ zoneId, name, mx: body.currentMx });
      } else {
        toast.error((err as Error).message);
      }
    } finally {
      setBusy(null);
    }
  }

  const rows = domains.data?.domains ?? [];
  const worker = domains.data?.worker;

  // The server only re-checks DNS and flips routing_state inside GET
  // /api/domains/:domain/status, and the setup wizard is otherwise its only
  // caller. Poll it here for any domain still settling, or one added from this
  // page reads "waiting for DNS" forever no matter what its records say.
  const pendingNames = rows
    .filter((d) => d.routing_state === "pending_dns" || d.routing_state === "enabling")
    .map((d) => d.domain);
  const pendingStatus = useQuery({
    queryKey: ["domains", "status", pendingNames],
    enabled: pendingNames.length > 0,
    refetchInterval: 15_000,
    queryFn: () =>
      Promise.all(pendingNames.map((name) => api.domainStatus(name).catch(() => null))),
  });
  useEffect(() => {
    const fresh = pendingStatus.data ?? [];
    const changed = fresh.some(
      (st, i) =>
        st &&
        st.routing_state !== rows.find((d) => d.domain === pendingNames[i])?.routing_state,
    );
    if (changed) void qc.invalidateQueries({ queryKey: ["domains"] });
  }, [pendingStatus.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const STATE_LABEL: Record<string, string> = {
    ready: "receiving mail",
    pending_dns: "waiting for DNS",
    enabling: "enabling…",
    error: "needs attention",
    none: "not routing yet",
  };

  return (
    <Section
      icon={<Globe size={18} />}
      title="Domains"
      desc={
        worker
          ? `Mail for these domains arrives at this worker (${worker}).`
          : "Mail domains handled by this instance."
      }
      stack
    >
      <div className="mt-3 space-y-2">
        {domains.isPending && (
          <div className="flex items-center gap-2 text-sm text-muted">
            <Spinner className="text-accent" /> Loading…
          </div>
        )}

        {domains.isError && (
          <p className="text-sm text-muted">
            {(domains.error as Error).message ||
              "Couldn't reach Cloudflare — check the token's scopes."}
          </p>
        )}

        {domains.isSuccess && rows.length === 0 && (
          <p className="text-sm text-muted">
            No domains yet, so nothing can arrive. Add one to start receiving mail.
          </p>
        )}

        {rows.map((d) => {
          const removable = rows.length > 1 && d.is_primary !== 1;
          return (
            <div
              key={d.domain}
              className="flex items-center gap-3 rounded-xl border border-border bg-bg px-4 py-3"
            >
              {/* Name + badges on one line, status on its own line below — the
                  previous single-line layout wrapped into vertical soup as soon
                  as a domain had both a badge and an error. */}
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate font-mono text-sm">{d.domain}</span>
                  {d.is_primary === 1 && (
                    <span className="shrink-0 rounded-full bg-accent/10 px-2 py-0.5 text-xs text-accent">
                      primary
                    </span>
                  )}
                </div>
                <p className="truncate text-xs text-muted" title={d.routing_error ?? undefined}>
                  {STATE_LABEL[d.routing_state] ?? d.routing_state}
                  {d.send_state === "verified" && " · sending verified"}
                  {d.routing_error && ` · ${d.routing_error}`}
                </p>
              </div>

              <div className="flex shrink-0 items-center gap-1.5">
                {d.is_primary !== 1 && (
                  <Button
                    size="sm"
                    disabled={busy === `primary:${d.domain}`}
                    onClick={() => {
                      setBusy(`primary:${d.domain}`);
                      api
                        .makePrimaryDomain(d.domain)
                        .then(async () => {
                          toast.success(`${d.domain} is now the primary domain`);
                          await qc.invalidateQueries({ queryKey: ["domains"] });
                          await qc.invalidateQueries({ queryKey: ["settings"] });
                        })
                        .catch((e) => toast.error((e as Error).message))
                        .finally(() => setBusy(null));
                    }}
                  >
                    Make primary
                  </Button>
                )}
                {removable ? (
                  <Button size="sm" onClick={() => setConfirming(d.domain)}>
                    Remove
                  </Button>
                ) : (
                  <Tip
                    label={
                      rows.length === 1
                        ? "The only domain can't be removed — add another first."
                        : "The primary domain can't be removed — make another primary first."
                    }
                  >
                    <span>
                      <Button size="sm" disabled>
                        Remove
                      </Button>
                    </span>
                  </Tip>
                )}
              </div>
            </div>
          );
        })}

        {/* Removal is destructive enough for a real dialog: the inline confirm
            squeezed into the row and pushed everything else into wrapping. */}
        <Dialog.Root open={!!confirming} onOpenChange={(o) => !o && setConfirming(null)}>
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" />
            <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(26rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border bg-elevated p-5 shadow-[var(--shadow-lg)]">
              <Dialog.Title className="font-display text-lg font-semibold">
                Remove {confirming}?
              </Dialog.Title>
              <Dialog.Description className="mt-2 text-sm text-muted">
                Mail sent to any address on {confirming} will stop arriving here. Messages you
                already received are kept.
              </Dialog.Description>
              <div className="mt-5 flex justify-end gap-2">
                <Button onClick={() => setConfirming(null)}>Keep it</Button>
                <Button
                  variant="primary"
                  disabled={!!confirming && busy === confirming}
                  onClick={() => {
                    const domain = confirming!;
                    setBusy(domain);
                    disconnect.mutate(domain, {
                      onSuccess: (res: unknown) => {
                        const r = res as { warning?: string };
                        if (r.warning) toast.warning(r.warning, { duration: 12000 });
                        else toast.success(`${domain} no longer routes here`);
                      },
                      onError: (e) => toast.error((e as Error).message),
                      onSettled: () => {
                        setBusy(null);
                        setConfirming(null);
                      },
                    });
                  }}
                >
                  {confirming && busy === confirming ? "Removing…" : "Remove domain"}
                </Button>
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>

        {mxConfirm && (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
            <p className="mb-1 font-medium">{mxConfirm.name} currently receives mail elsewhere.</p>
            <p className="mb-2 text-xs text-muted">These MX records will be replaced:</p>
            <ul className="mb-3 list-disc pl-5 font-mono text-xs">
              {mxConfirm.mx.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => setMxConfirm(null)}>
                Cancel
              </Button>
              <Button
                size="sm"
                variant="primary"
                onClick={() => void add(mxConfirm.zoneId, mxConfirm.name, true)}
              >
                Yes, deliver mail here instead
              </Button>
            </div>
          </div>
        )}

        {adding ? (
          <div className="space-y-2 rounded-xl border border-border bg-bg p-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted">
                Domains on your Cloudflare account
              </span>
              <button
                type="button"
                className="text-xs text-muted hover:text-fg"
                onClick={() => setAdding(false)}
              >
                Close
              </button>
            </div>
            {zones.isPending && (
              <div className="flex items-center gap-2 text-sm text-muted">
                <Spinner className="text-accent" /> Loading…
              </div>
            )}
            {zones.isError && (
              <p className="text-sm text-muted">{(zones.error as Error).message}</p>
            )}
            {(zones.data?.zones ?? [])
              .filter((z) => !z.added)
              .map((z) => (
                <div key={z.id} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-sm">{z.name}</span>
                  {z.currentMx.length > 0 && (
                    <span className="shrink-0 rounded-full bg-amber-500/10 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-300">
                      receives elsewhere
                    </span>
                  )}
                  <Button size="sm" disabled={busy === z.name} onClick={() => void add(z.id, z.name)}>
                    {busy === z.name ? "Adding…" : "Add"}
                  </Button>
                </div>
              ))}
          </div>
        ) : (
          <Button onClick={() => setAdding(true)}>Add a domain</Button>
        )}

        <p className="pt-1 text-xs text-faint">
          Every address on an added domain arrives here. Removing a domain stops its mail and
          keeps messages already received.
        </p>
      </div>
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
