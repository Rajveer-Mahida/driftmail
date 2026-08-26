import { useState } from "react";
import { toast } from "sonner";
import { Button, Spinner } from "@/components/primitives";
import { setupApi } from "@/api/setup";
import type { StepProps } from "../SetupPage";
import { Actions, Field, Notice, StepHeader, inputClass } from "./shared";

export function StepExtras({ next, back, skip, state }: StepProps) {
  const [push, setPush] = useState(true);
  const [anthropicKey, setAnthropicKey] = useState("");
  const [signature, setSignature] = useState("");
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  async function save() {
    setBusy(true);
    setErrors({});
    try {
      const res = await setupApi.extras({
        enablePush: push,
        vapidSubject: state.adminEmail ? `mailto:${state.adminEmail}` : undefined,
        anthropicKey: anthropicKey.trim() || undefined,
        signature: signature.trim() || undefined,
      });
      // Each of these is independent, so a bad AI key shouldn't discard the
      // signature you just typed.
      if (res.errors && Object.keys(res.errors).length) {
        setErrors(res.errors);
        toast.error("Some extras couldn't be set up — see below.");
        return;
      }
      next("done");
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <StepHeader
        title="A few optional extras"
        blurb="All of these can wait. Skip the whole step if you'd rather get to your inbox."
      />

      <label className="mb-4 flex items-start gap-3 rounded-[var(--radius-lg)] border border-border p-3">
        <input
          type="checkbox"
          checked={push}
          onChange={(e) => setPush(e.target.checked)}
          className="mt-1"
        />
        <span>
          <span className="block text-sm font-medium">New-mail notifications</span>
          <span className="block text-xs text-muted">
            Generates a signing key inside this Worker — nothing to paste, nothing to install.
          </span>
        </span>
      </label>
      {errors.push && <Notice tone="error">{errors.push}</Notice>}

      <Field
        label="Anthropic API key"
        hint="Optional. Powers thread summaries and suggested replies."
      >
        <input
          type="password"
          value={anthropicKey}
          onChange={(e) => setAnthropicKey(e.target.value)}
          placeholder="sk-ant-..."
          className={`${inputClass} font-mono text-sm`}
        />
      </Field>
      {errors.ai && <Notice tone="error">{errors.ai}</Notice>}

      <Field label="Signature" hint="Appended to new messages you compose.">
        <textarea
          rows={3}
          value={signature}
          onChange={(e) => setSignature(e.target.value)}
          className={`${inputClass} resize-none`}
        />
      </Field>

      <Actions onBack={back} onSkip={skip} skipLabel="Skip all">
        <Button variant="primary" onClick={save} disabled={busy}>
          {busy ? <Spinner /> : "Save and finish"}
        </Button>
      </Actions>
    </>
  );
}
