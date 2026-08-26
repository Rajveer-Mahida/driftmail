import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import * as Switch from "@radix-ui/react-switch";
import { motion } from "framer-motion";
import { toast } from "sonner";
import { ArrowLeft, Check, Sun, Moon, Mail, Globe, Palette, PenLine, ShieldCheck, Bell } from "lucide-react";
import {
  useSettings,
  useSetSettings,
  useDomains,
  useDisconnectDomain,
} from "@/api/hooks";
import { useUI } from "@/lib/store";
import { Button, Spinner } from "@/components/primitives";
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

          {/* Domains — only when CF_TOKEN is configured on the worker */}
          {s?.domain_management && <DomainsSection />}

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
  const domains = useDomains(true);
  const disconnect = useDisconnectDomain();
  const [busy, setBusy] = useState<string | null>(null);

  const rows = domains.data?.domains ?? [];
  const worker = domains.data?.worker;

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

        {rows.map((d) => (
          <div
            key={d.domain}
            className="flex items-center gap-3 rounded-xl border border-border bg-bg px-4 py-3"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate font-mono text-sm">
                {d.domain}
                {d.is_primary === 1 && (
                  <span className="ml-2 rounded-full bg-accent/10 px-2 py-0.5 text-xs text-accent">
                    primary
                  </span>
                )}
              </p>
              <p className="text-xs text-muted">
                {STATE_LABEL[d.routing_state] ?? d.routing_state}
                {d.send_state === "verified" && " · sending verified"}
                {d.routing_error && ` · ${d.routing_error}`}
              </p>
            </div>
            <Button
              disabled={busy === d.domain}
              onClick={() => {
                setBusy(d.domain);
                disconnect.mutate(d.domain, {
                  onSuccess: () => toast.success(`${d.domain} no longer routes here`),
                  onError: (e) => toast.error((e as Error).message),
                  onSettled: () => setBusy(null),
                });
              }}
            >
              {busy === d.domain ? "Working…" : "Remove"}
            </Button>
          </div>
        ))}

        <p className="pt-1 text-xs text-faint">
          Removing a domain turns off its Email Routing and stops mail arriving. Messages already
          received are kept.
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
