import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button, Spinner } from "@/components/primitives";
import { setupApi } from "@/api/setup";
import type { StepProps } from "../SetupPage";
import { Actions, Field, Notice, StepHeader, inputClass } from "./shared";

/**
 * Only shown when detection failed — a Worker cannot read its own script name,
 * so it has to be established from the account side, and that can be refused by
 * a narrowly scoped token.
 *
 * Getting this wrong is quiet and nasty: the catch-all would point at a Worker
 * that doesn't exist, Cloudflare would accept the mail, and it would be
 * delivered nowhere.
 */
export function StepWorker({ next, back, state, patch }: StepProps) {
  const [name, setName] = useState(state.workerName);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setupApi
      .worker()
      .then((w) => {
        setName((current) => current || w.name);
        patch({ workerSource: w.source, hostname: w.hostname });
      })
      .catch(() => {})
      .finally(() => setLoading(false));
    // Runs once on mount; `patch` is stable enough for that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function save() {
    setBusy(true);
    try {
      await setupApi.setWorker(name.trim());
      patch({ workerName: name.trim(), workerSource: "manual" });
      next("domain");
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <Spinner className="text-accent" />;

  return (
    <>
      <StepHeader
        title="Confirm this Worker's name"
        blurb="Cloudflare's catch-all rule points at a Worker by name, and a Worker can't read its own."
      />

      {state.workerSource === "custom_domain" || state.workerSource === "workers_dev" ? (
        <Notice tone="ok">
          Detected automatically from{" "}
          {state.workerSource === "custom_domain" ? "your custom domain" : "the workers.dev hostname"}.
        </Notice>
      ) : (
        <Notice tone="warn">
          Couldn't detect it automatically. You'll find it at the top of this Worker's page in the
          Cloudflare dashboard — it must match exactly.
        </Notice>
      )}

      <Field label="Worker name">
        <input
          value={name}
          onChange={(e) => setName(e.target.value.trim())}
          placeholder="driftmail"
          className={`${inputClass} font-mono text-sm`}
        />
      </Field>

      <Actions onBack={back}>
        <Button variant="primary" onClick={save} disabled={busy || !name.trim()}>
          {busy ? <Spinner /> : "Continue"}
        </Button>
      </Actions>
    </>
  );
}
