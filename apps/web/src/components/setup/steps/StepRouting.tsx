import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, Spinner } from "@/components/primitives";
import { setupApi } from "@/api/setup";
import type { StepProps } from "../SetupPage";
import { Actions, DnsRecordTable, Notice, StepHeader } from "./shared";

/** Fast at first, then backing off — most of the time this resolves in seconds
 *  on Cloudflare DNS, and the slow case is measured in hours. */
const POLL_FAST_MS = 3_000;
const POLL_SLOW_MS = 10_000;
const FAST_FOR_MS = 30_000;
const GIVE_UP_MS = 15 * 60_000;

export function StepRouting({ next, back, skip, state }: StepProps) {
  const [startedAt] = useState(() => Date.now());
  const [elapsed, setElapsed] = useState(0);

  const status = useQuery({
    queryKey: ["setup", "domain-status", state.domain],
    queryFn: () => setupApi.domainStatus(state.domain),
    enabled: !!state.domain,
    refetchInterval: (q) => {
      if (q.state.data?.routing_state === "ready") return false;
      if (Date.now() - startedAt > GIVE_UP_MS) return false;
      return Date.now() - startedAt < FAST_FOR_MS ? POLL_FAST_MS : POLL_SLOW_MS;
    },
  });

  useEffect(() => {
    const t = setInterval(() => setElapsed(Date.now() - startedAt), 1000);
    return () => clearInterval(t);
  }, [startedAt]);

  if (!state.domain) {
    return (
      <>
        <StepHeader title="DNS" blurb="No domain was added, so there's nothing to check yet." />
        <Actions onBack={back}>
          <Button variant="primary" onClick={() => next("sending")}>
            Continue
          </Button>
        </Actions>
      </>
    );
  }

  const data = status.data;
  const ready = data?.routing_state === "ready";
  const timedOut = elapsed > GIVE_UP_MS && !ready;

  return (
    <>
      <StepHeader
        title={ready ? `${state.domain} is receiving mail` : "Waiting for DNS"}
        blurb={
          state.managedDns
            ? "Driftmail wrote these records for you. They're usually live within a minute."
            : "This domain's DNS isn't on Cloudflare, so these records have to be added by hand."
        }
      />

      {ready ? (
        <Notice tone="ok">
          MX records are live and the catch-all points at <strong>{data?.worker}</strong>. Anything
          sent to {state.domain} will arrive here.
        </Notice>
      ) : timedOut ? (
        <Notice tone="warn">
          Still not visible. DNS usually takes under a minute on Cloudflare and up to 24 hours
          elsewhere. You can carry on — mail will start arriving as soon as it propagates.
        </Notice>
      ) : (
        <Notice>
          <span className="inline-flex items-center gap-2">
            <Spinner /> Checking public DNS…
          </span>
        </Notice>
      )}

      <DnsRecordTable records={data?.records ?? []} />

      {data && (
        <ul className="mb-4 space-y-1 text-xs text-muted">
          <li>
            {data.checks.mx_live ? "✓" : "…"} MX records visible in public DNS
            {data.checks.observed_mx.length > 0 && !data.checks.mx_live && (
              <span className="text-faint"> — currently {data.checks.observed_mx.join(", ")}</span>
            )}
          </li>
          <li>{data.checks.spf_live ? "✓" : "…"} SPF record visible</li>
          <li>
            {data.catch_all_ok ? "✓" : "…"} Catch-all rule points at this Worker
            {!data.catch_all_ok && data.worker && (
              <span className="text-faint"> — expected {data.worker}</span>
            )}
          </li>
        </ul>
      )}

      <Actions onBack={back} onSkip={skip} skipLabel="Continue in the background">
        <Button variant="primary" onClick={() => next("sending")} disabled={!ready && !timedOut}>
          Continue
        </Button>
      </Actions>
    </>
  );
}
