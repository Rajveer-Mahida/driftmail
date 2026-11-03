import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import * as Dialog from "@radix-ui/react-dialog";
import { toast } from "sonner";
import { ArrowLeft, Globe, Server } from "lucide-react";
import { api, ApiError } from "@/api/client";
import { setupApi } from "@/api/setup";
import { useDomains, useDisconnectDomain, useSettings } from "@/api/hooks";
import { Button, Spinner, Tip } from "@/components/primitives";
import { Section } from "@/components/Section";
import type { DomainRow } from "@email/shared";

/**
 * Admin page for the mail domains this instance serves. Everything here used to
 * live in a Settings section; it gets its own page because "add another
 * domain" is the main thing an operator does after setup.
 */
export function DomainsPage() {
  const navigate = useNavigate();
  const settings = useSettings();
  const s = settings.data;

  return (
    <div className="scroll-thin h-full min-w-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-2xl px-6 py-8 md:px-10">
        <button
          onClick={() => navigate({ to: "/" })}
          className="mb-6 inline-flex items-center gap-2 text-sm text-muted transition hover:text-fg"
        >
          <ArrowLeft size={16} /> Back to inbox
        </button>

        <h1 className="mb-2 font-display text-3xl font-semibold tracking-tight">Domains</h1>
        <p className="mb-8 text-sm text-muted">
          One Driftmail serves all your domains. Add a domain and every address on it arrives
          here — no extra deployment.
        </p>

        {settings.isPending && (
          <div className="flex items-center gap-2 text-sm text-muted">
            <Spinner className="text-accent" /> Loading…
          </div>
        )}

        {s && s.user.role !== "admin" && (
          <p className="text-sm text-muted">Only administrators can manage domains.</p>
        )}

        {s && s.user.role === "admin" && !s.domain_management && (
          <Section
            icon={<Globe size={18} />}
            title="Domain management is off"
            desc="This instance was claimed with a SETUP_TOKEN instead of a Cloudflare API token, so it can't configure Email Routing for you. Set up each domain's MX records and catch-all (to this Worker) in the Cloudflare dashboard."
            stack
          >
            <span />
          </Section>
        )}

        {s && s.user.role === "admin" && s.domain_management && (
          <div className="space-y-4">
            <DomainsSection />
            <WorkerNameSection />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The Worker the catch-all rules point at. Normally detected at setup (or the
 * "driftmail" default) and never touched; this is the fallback for a Worker
 * deployed under another name.
 */
function WorkerNameSection() {
  const qc = useQueryClient();
  const domains = useDomains(true);
  const current = domains.data?.worker ?? "";
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      await setupApi.setWorker(value.trim());
      toast.success("Worker name saved", {
        description: "Re-add a domain, or use Make primary, to repoint its catch-all.",
      });
      setEditing(false);
      await qc.invalidateQueries({ queryKey: ["domains"] });
    } catch (err) {
      const hint = (err as ApiError & { body?: { hint?: string } }).body?.hint;
      toast.error((err as Error).message, hint ? { description: hint } : undefined);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section
      icon={<Server size={18} />}
      title="Worker"
      desc="Email Routing delivers each domain's catch-all to this Worker, by name."
      stack
    >
      <div className="mt-3">
        {editing ? (
          <div className="flex items-center gap-2">
            <input
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="min-w-0 flex-1 rounded-lg border border-border bg-bg px-3 py-1.5 font-mono text-sm"
            />
            <Button size="sm" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={saving || !value.trim() || value.trim() === current}
              onClick={() => void save()}
            >
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate font-mono text-sm">{current || "—"}</span>
            <Button
              size="sm"
              onClick={() => {
                setValue(current);
                setEditing(true);
              }}
            >
              Change
            </Button>
          </div>
        )}
      </div>
    </Section>
  );
}

/**
 * The mail domains this instance handles. One Worker serves all of them:
 * adding a domain enables Email Routing on the zone and points its catch-all
 * here, so a second domain is a click, not a second deployment.
 *
 * Every /api/domains route needs a stored Cloudflare token (503 otherwise).
 */
function DomainsSection() {
  const qc = useQueryClient();
  const domains = useDomains(true);
  const disconnect = useDisconnectDomain();
  const [busy, setBusy] = useState<string | null>(null);
  /** The domain whose Remove has been clicked once — confirmation pending. */
  const [confirming, setConfirming] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  /** The domain whose accept/forward rules are open in the dialog. */
  const [editing, setEditing] = useState<DomainRow | null>(null);
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
                  {d.accept_all === 1 ? " · accepts every address" : ` · only ${d.allowed_pattern ?? "—"}`}
                  {d.forward_to && ` · copies to ${d.forward_to}`}
                  {d.send_state === "verified" && " · sending verified"}
                  {d.routing_error && ` · ${d.routing_error}`}
                </p>
              </div>

              <div className="flex shrink-0 items-center gap-1.5">
                <Button size="sm" onClick={() => setEditing(d)}>
                  Rules
                </Button>
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

        <DomainRulesDialog domain={editing} onClose={() => setEditing(null)} />

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
            {zones.isSuccess && zones.data.zones.every((z) => z.added) && (
              <p className="text-sm text-muted">
                Every domain this token can see is already added. To add another, put it on
                Cloudflare DNS in the same account, and make sure the token covers its zone.
              </p>
            )}
            {(zones.data?.zones ?? [])
              .filter((z) => !z.added)
              .map((z) => (
                <div key={z.id} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-sm">{z.name}</span>
                  {z.catchAllTarget && z.catchAllTarget !== worker ? (
                    <Tip
                      label={`Its catch-all currently delivers to the Worker "${z.catchAllTarget}". Adding it here moves that to ${worker ?? "this Worker"}.`}
                    >
                      <span className="shrink-0 rounded-full bg-amber-500/10 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-300">
                        used by {z.catchAllTarget}
                      </span>
                    </Tip>
                  ) : (
                    z.currentMx.length > 0 && (
                      <span className="shrink-0 rounded-full bg-amber-500/10 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-300">
                        receives elsewhere
                      </span>
                    )
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


/**
 * Which addresses a domain accepts, and where its mail is copied or sent when
 * nobody claims it. Saved with PATCH /api/domains/:domain.
 */
function DomainRulesDialog({ domain, onClose }: { domain: DomainRow | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [acceptAll, setAcceptAll] = useState(true);
  const [pattern, setPattern] = useState("");
  const [forwardTo, setForwardTo] = useState("");
  const [fallback, setFallback] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!domain) return;
    setAcceptAll(domain.accept_all === 1);
    setPattern(domain.allowed_pattern ?? "");
    setForwardTo(domain.forward_to ?? "");
    setFallback(domain.fallback_forward_to ?? "");
  }, [domain]);

  const name = domain?.domain ?? "";
  const field =
    "w-full rounded-lg border border-border bg-bg px-3 py-2 font-mono text-sm outline-none focus:border-accent-ring";

  async function save() {
    setSaving(true);
    try {
      await api.updateDomain(name, {
        acceptAll,
        allowedPattern: pattern,
        forwardTo: forwardTo.trim() || null,
        fallbackForwardTo: fallback.trim() || null,
      });
      toast.success(`Rules saved for ${name}`);
      await qc.invalidateQueries({ queryKey: ["domains"] });
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog.Root open={!!domain} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[calc(100vh-4rem)] w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-border bg-elevated p-5 shadow-[var(--shadow-lg)]">
          <Dialog.Title className="font-display text-lg font-semibold">Rules for {name}</Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-muted">
            Which addresses on {name} are accepted, and where mail is copied.
          </Dialog.Description>

          <fieldset className="mt-4 space-y-2">
            <legend className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted">
              Accept
            </legend>
            <label className="flex cursor-pointer items-start gap-2 text-sm">
              <input type="radio" name="accept" checked={acceptAll} onChange={() => setAcceptAll(true)} className="mt-1" />
              <span>
                Every address on {name}
                <span className="block text-xs text-muted">
                  Aliases, handles and the catch-all decide whose inbox it lands in.
                </span>
              </span>
            </label>
            <label className="flex cursor-pointer items-start gap-2 text-sm">
              <input type="radio" name="accept" checked={!acceptAll} onChange={() => setAcceptAll(false)} className="mt-1" />
              <span>
                Only these addresses
                <span className="block text-xs text-muted">
                  Everything else is refused — including your own handle unless you list it.
                </span>
              </span>
            </label>
          </fieldset>

          {!acceptAll && (
            <div className="mt-3">
              <label className="mb-1 block text-xs text-muted" htmlFor="rules-pattern">
                Addresses or patterns, comma-separated. <span className="font-mono">*</span> matches anything.
              </label>
              <textarea
                id="rules-pattern"
                rows={3}
                value={pattern}
                onChange={(e) => setPattern(e.target.value)}
                placeholder={`career@${name}, hr@${name}, *.shop@${name}`}
                className={field}
              />
              <p className="mt-1 text-xs text-faint">
                A +tag is ignored when matching, so career+linkedin@{name} counts as career@{name}.
              </p>
            </div>
          )}

          <div className="mt-4">
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted" htmlFor="rules-copy">
              Also copy delivered mail to
            </label>
            <input
              id="rules-copy"
              value={forwardTo}
              onChange={(e) => setForwardTo(e.target.value)}
              placeholder="you@gmail.com (optional)"
              className={field}
            />
          </div>

          <div className="mt-3">
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted" htmlFor="rules-fallback">
              Send refused mail to
            </label>
            <input
              id="rules-fallback"
              value={fallback}
              onChange={(e) => setFallback(e.target.value)}
              placeholder="Leave empty to bounce it"
              className={field}
            />
            <p className="mt-1 text-xs text-faint">
              Cloudflare only forwards to addresses verified under Email Routing → Destination
              addresses.
            </p>
          </div>

          <div className="mt-5 flex justify-end gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" disabled={saving} onClick={() => void save()}>
              {saving ? "Saving…" : "Save rules"}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
