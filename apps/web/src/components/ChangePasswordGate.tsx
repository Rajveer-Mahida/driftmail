import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, ApiError } from "@/api/client";
import { Button, Spinner } from "@/components/primitives";

/**
 * Shown instead of the inbox when an account is still on the temporary password
 * an administrator handed out.
 *
 * The current password is still required: without it, an unattended session on
 * a shared machine is an account takeover rather than an inconvenience.
 */
export function ChangePasswordGate() {
  const qc = useQueryClient();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.changePassword(current, next);
      await qc.invalidateQueries();
      toast.success("Password changed");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Couldn't change your password");
      setBusy(false);
    }
  }

  return (
    <div className="app-backdrop grid h-full place-items-center p-6">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm rounded-2xl border border-border bg-surface/80 p-6 shadow-[var(--shadow-lg)] backdrop-blur"
      >
        <h1 className="font-display text-lg font-semibold tracking-tight">Choose a password</h1>
        <p className="mb-5 mt-1 text-sm text-muted">
          You're signed in with a temporary password. Pick your own to continue.
        </p>

        <label className="mb-2 block text-xs font-semibold uppercase tracking-wider text-muted">
          Temporary password
        </label>
        <input
          type="password"
          autoFocus
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          className="mb-4 w-full rounded-[var(--radius-lg)] border border-border bg-bg px-4 py-3 outline-none transition focus:border-accent-ring focus:ring-4 focus:ring-accent-ring/20"
        />

        <label className="mb-2 block text-xs font-semibold uppercase tracking-wider text-muted">
          New password
        </label>
        <input
          type="password"
          autoComplete="new-password"
          minLength={12}
          value={next}
          onChange={(e) => setNext(e.target.value)}
          className="mb-1 w-full rounded-[var(--radius-lg)] border border-border bg-bg px-4 py-3 outline-none transition focus:border-accent-ring focus:ring-4 focus:ring-accent-ring/20"
        />
        <p className="mb-4 text-xs text-faint">At least 12 characters.</p>

        <Button type="submit" variant="primary" className="w-full" disabled={busy}>
          {busy ? <Spinner /> : "Save and continue"}
        </Button>
      </form>
    </div>
  );
}
