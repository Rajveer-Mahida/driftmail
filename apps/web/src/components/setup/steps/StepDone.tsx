import { useQuery } from "@tanstack/react-query";
import { Button, Spinner } from "@/components/primitives";
import { setupApi } from "@/api/setup";
import type { StepProps } from "../SetupPage";
import { Actions, StepHeader } from "./shared";

type Props = StepProps & { onFinish: () => void };

function Row({ ok, label, detail }: { ok: boolean; label: string; detail?: string }) {
  return (
    <li className="flex items-start gap-3 border-b border-border py-2.5 last:border-0">
      <span
        className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full text-xs ${
          ok
            ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
            : "bg-amber-500/15 text-amber-600 dark:text-amber-400"
        }`}
      >
        {ok ? "✓" : "!"}
      </span>
      <span className="min-w-0">
        <span className="block text-sm">{label}</span>
        {detail && <span className="block text-xs text-muted">{detail}</span>}
      </span>
    </li>
  );
}

export function StepDone({ state, next, onFinish }: Props) {
  const domain = useQuery({
    queryKey: ["setup", "domain-status", state.domain],
    queryFn: () => setupApi.domainStatus(state.domain),
    enabled: !!state.domain,
  });

  const routingReady = domain.data?.routing_state === "ready";

  return (
    <>
      <StepHeader
        title="You're set up"
        blurb="Anything still amber will keep working in the background — nothing here blocks you."
      />

      <ul className="mb-2">
        <Row ok={state.hasCloudflare} label="Cloudflare connected" detail={state.workerName} />
        <Row
          ok={!!state.domain}
          label={state.domain ? `${state.domain} added` : "No mail domain yet"}
          detail={state.domain ? undefined : "Add one in Settings → Domains to start receiving."}
        />
        <Row
          ok={routingReady}
          label="DNS live"
          detail={
            domain.isLoading
              ? "checking…"
              : routingReady
                ? undefined
                : "Still propagating. Mail will arrive as soon as it does."
          }
        />
      </ul>

      {state.domain && routingReady && (
        <p className="mb-2 rounded-[var(--radius-lg)] border border-border bg-bg p-3 text-sm text-muted">
          Try it: send something to{" "}
          <span className="font-mono text-fg">anything@{state.domain}</span> — or{" "}
          <span className="font-mono text-fg">anything.{state.adminEmail.split("@")[0]}@{state.domain}</span>{" "}
          — and it will land in your inbox.
        </p>
      )}

      <Actions onBack={() => next("extras")}>
        <Button variant="primary" onClick={onFinish}>
          {domain.isLoading ? <Spinner /> : "Open your inbox"}
        </Button>
      </Actions>
    </>
  );
}
