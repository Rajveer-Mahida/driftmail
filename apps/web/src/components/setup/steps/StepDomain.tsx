import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, Spinner } from "@/components/primitives";
import { ApiError } from "@/api/client";
import { setupApi, type SetupZone } from "@/api/setup";
import type { StepProps } from "../SetupPage";
import { Actions, Field, Notice, StepHeader, inputClass } from "./shared";

export function StepDomain({ next, back, skip, patch }: StepProps) {
  const zones = useQuery({ queryKey: ["setup", "zones"], queryFn: setupApi.zones });
  const [selected, setSelected] = useState<SetupZone | null>(null);
  const [acceptAll, setAcceptAll] = useState(true);
  const [pattern, setPattern] = useState("");
  const [fallback, setFallback] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mxWarning, setMxWarning] = useState<string[] | null>(null);

  async function add(confirmOverwriteMx = false) {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await setupApi.addDomain({
        zoneId: selected.id,
        domain: selected.name,
        acceptAll,
        allowedPattern: acceptAll ? undefined : pattern.trim(),
        fallbackForwardTo: fallback.trim() || undefined,
        primary: true,
        confirmOverwriteMx,
      });
      patch({ domain: selected.name, managedDns: selected.managedDns });
      next("routing");
    } catch (err) {
      const body = (err as ApiError & { body?: { error?: string; currentMx?: string[] } }).body;
      if (body?.error === "mx_in_use" && body.currentMx) {
        setMxWarning(body.currentMx);
      } else {
        setError(err instanceof ApiError ? err.message : "Couldn't add that domain");
      }
    } finally {
      setBusy(false);
    }
  }

  if (zones.isLoading) return <Spinner className="text-accent" />;

  if (zones.error) {
    return (
      <>
        <StepHeader title="Pick your mail domain" />
        <Notice tone="error">{(zones.error as Error).message}</Notice>
        <Actions onBack={back} onSkip={skip} skipLabel="Skip — add a domain later">
          <Button onClick={() => zones.refetch()}>Try again</Button>
        </Actions>
      </>
    );
  }

  const list = zones.data?.zones ?? [];

  return (
    <>
      <StepHeader
        title="Pick your mail domain"
        blurb="Every address on it arrives here — no per-address setup, ever."
      />

      {error && <Notice tone="error">{error}</Notice>}

      {mxWarning && (
        // The one genuinely destructive thing this wizard does. Enabling Email
        // Routing rewrites the zone's MX records, so a domain currently
        // delivering to Google or Fastmail would silently stop.
        <Notice tone="warn">
          <p className="mb-2 font-medium">
            {selected?.name} currently receives mail somewhere else.
          </p>
          <p className="mb-2">These MX records will be replaced:</p>
          <ul className="mb-3 list-disc pl-5 font-mono text-xs">
            {mxWarning.map((mx) => (
              <li key={mx}>{mx}</li>
            ))}
          </ul>
          <div className="flex gap-2">
            <Button onClick={() => setMxWarning(null)}>Cancel</Button>
            <Button variant="primary" onClick={() => void add(true)} disabled={busy}>
              Yes, deliver mail here instead
            </Button>
          </div>
        </Notice>
      )}

      {!list.length && (
        <Notice tone="warn">
          No active zones on this Cloudflare account. Add your domain to Cloudflare first, then come
          back.
        </Notice>
      )}

      <div className="mb-5 space-y-2">
        {list.map((z) => (
          <button
            key={z.id}
            type="button"
            onClick={() => setSelected(z)}
            className={`flex w-full items-center gap-3 rounded-[var(--radius-lg)] border p-3 text-left transition ${
              selected?.id === z.id
                ? "border-accent-ring bg-accent/5"
                : "border-border hover:border-accent-ring/40"
            }`}
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{z.name}</span>
              <span className="block text-xs text-faint">
                {z.added
                  ? "already added"
                  : z.routing.enabled
                    ? "Email Routing already on"
                    : "Email Routing off"}
              </span>
            </span>
            {!z.managedDns && (
              <span className="shrink-0 rounded-full bg-amber-500/10 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-300">
                DNS not on Cloudflare
              </span>
            )}
            {z.currentMx.length > 0 && (
              <span className="shrink-0 rounded-full bg-amber-500/10 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-300">
                receives elsewhere
              </span>
            )}
          </button>
        ))}
      </div>

      <div className="mb-2 border-t border-border pt-5">
        <Field label="Which addresses to accept">
          <div className="space-y-2">
            <label className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                checked={acceptAll}
                onChange={() => setAcceptAll(true)}
                className="mt-1"
              />
              <span>
                <span className="block">Every address on this domain</span>
                <span className="block text-xs text-faint">
                  Recommended — a true catch-all, so you can invent an address on the spot.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                checked={!acceptAll}
                onChange={() => setAcceptAll(false)}
                className="mt-1"
              />
              <span>Only addresses matching a pattern</span>
            </label>
          </div>
        </Field>

        {!acceptAll && (
          <Field label="Pattern" hint="Comma-separated. * matches any run of characters.">
            <input
              value={pattern}
              onChange={(e) => setPattern(e.target.value)}
              placeholder="career@example.com, *.shop@example.com"
              className={`${inputClass} font-mono text-sm`}
            />
          </Field>
        )}

        <Field
          label="Where unroutable mail goes"
          hint="Optional. Leave empty to bounce it back to the sender."
        >
          <input
            type="email"
            value={fallback}
            onChange={(e) => setFallback(e.target.value)}
            placeholder="you@gmail.com"
            className={inputClass}
          />
        </Field>
      </div>

      <Actions onBack={back} onSkip={skip} skipLabel="Skip — add a domain later">
        <Button variant="primary" onClick={() => void add()} disabled={!selected || busy}>
          {busy ? <Spinner /> : "Add domain"}
        </Button>
      </Actions>
    </>
  );
}
