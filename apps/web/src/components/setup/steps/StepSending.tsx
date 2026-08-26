import { useState } from "react";
import { toast } from "sonner";
import { Button, Spinner } from "@/components/primitives";
import { ApiError } from "@/api/client";
import { setupApi, type DnsRow } from "@/api/setup";
import type { StepProps } from "../SetupPage";
import { Actions, DnsRecordTable, Field, Notice, StepHeader, inputClass } from "./shared";

type Choice = "resend" | "cloudflare" | "none";

const OPTIONS: { id: Choice; title: string; badge?: string; points: string[] }[] = [
  {
    id: "resend",
    title: "Resend",
    badge: "Recommended",
    points: [
      "3,000 emails a month free",
      "Paste an API key — Driftmail writes the DNS records for you",
      "A third party handles your outgoing mail",
    ],
  },
  {
    id: "cloudflare",
    title: "Cloudflare Email Sending",
    points: [
      "No third party, no extra account",
      "Free only to addresses you've verified in Cloudflare",
      "Sending to anyone else needs the Workers Paid plan",
    ],
  },
  {
    id: "none",
    title: "Receive only",
    points: ["Nothing to set up", "Compose and reply stay disabled", "You can turn this on later"],
  },
];

export function StepSending({ next, back, skip, state }: StepProps) {
  const [choice, setChoice] = useState<Choice>("resend");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [records, setRecords] = useState<DnsRow[]>([]);
  const [verified, setVerified] = useState(false);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await setupApi.sending({
        provider: choice,
        apiKey: apiKey.trim() || undefined,
        domain: state.domain || undefined,
      });
      setRecords(res.records ?? []);
      setVerified(res.send_state === "verified");
      if (choice === "none" || res.send_state === "verified") {
        next("extras");
      } else {
        toast.message("DNS records added — verification usually takes a minute.");
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't set that up");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <StepHeader
        title="How should Driftmail send mail?"
        blurb="Optional — receiving already works. You can change this any time."
      />

      {error && <Notice tone="error">{error}</Notice>}

      <div className="mb-5 space-y-2">
        {OPTIONS.map((o) => (
          <button
            key={o.id}
            type="button"
            onClick={() => setChoice(o.id)}
            className={`block w-full rounded-[var(--radius-lg)] border p-3 text-left transition ${
              choice === o.id
                ? "border-accent-ring bg-accent/5"
                : "border-border hover:border-accent-ring/40"
            }`}
          >
            <span className="mb-1 flex items-center gap-2">
              <span className="font-medium">{o.title}</span>
              {o.badge && (
                <span className="rounded-full bg-accent/10 px-2 py-0.5 text-xs text-accent">
                  {o.badge}
                </span>
              )}
            </span>
            <ul className="space-y-0.5 text-xs text-muted">
              {o.points.map((p) => (
                <li key={p}>· {p}</li>
              ))}
            </ul>
          </button>
        ))}
      </div>

      {choice === "resend" && (
        <Field
          label="Resend API key"
          hint={
            <>
              From{" "}
              <a
                href="https://resend.com/api-keys"
                target="_blank"
                rel="noreferrer"
                className="text-accent hover:underline"
              >
                resend.com/api-keys
              </a>
              . Driftmail will add the verification records to {state.domain || "your domain"} for you.
            </>
          }
        >
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="re_..."
            className={`${inputClass} font-mono text-sm`}
          />
        </Field>
      )}

      {choice === "cloudflare" && (
        <Notice tone="warn">
          Cloudflare only sends to destination addresses you've verified unless you're on the
          Workers Paid plan. If you pick this on the free plan, replies to most people will be
          rejected.
        </Notice>
      )}

      {records.length > 0 && (
        <>
          <Notice tone={verified ? "ok" : "info"}>
            {verified
              ? "Sending is verified."
              : "Records added. Verification usually completes within a minute — you can continue and check back in Settings."}
          </Notice>
          <DnsRecordTable records={records} />
        </>
      )}

      <Actions onBack={back} onSkip={skip} skipLabel="Decide later">
        <Button
          variant="primary"
          onClick={save}
          disabled={busy || (choice === "resend" && !apiKey.trim())}
        >
          {busy ? <Spinner /> : choice === "none" ? "Continue" : "Set up sending"}
        </Button>
      </Actions>
    </>
  );
}
