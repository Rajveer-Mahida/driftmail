import type { ReactNode } from "react";
import { Button } from "@/components/primitives";
import type { DnsRow } from "@/api/setup";

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className="mb-4 block">
      <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted">
        {label}
      </span>
      {children}
      {hint && <span className="mt-1.5 block text-xs text-faint">{hint}</span>}
    </label>
  );
}

export const inputClass =
  "w-full rounded-[var(--radius-lg)] border border-border bg-bg px-4 py-3 text-fg outline-none transition focus:border-accent-ring focus:ring-4 focus:ring-accent-ring/20";

export function StepHeader({ title, blurb }: { title: string; blurb?: ReactNode }) {
  return (
    <div className="mb-5">
      <h2 className="font-display text-lg font-semibold tracking-tight">{title}</h2>
      {blurb && <p className="mt-1.5 text-sm text-muted">{blurb}</p>}
    </div>
  );
}

export function Actions({
  onBack,
  onSkip,
  skipLabel = "Skip for now",
  children,
}: {
  onBack?: () => void;
  onSkip?: () => void;
  skipLabel?: string;
  children: ReactNode;
}) {
  return (
    <div className="mt-6 flex items-center gap-2">
      {onBack && (
        <Button type="button" onClick={onBack}>
          Back
        </Button>
      )}
      <div className="flex-1" />
      {onSkip && (
        <Button type="button" onClick={onSkip}>
          {skipLabel}
        </Button>
      )}
      {children}
    </div>
  );
}

export function Notice({
  tone = "info",
  children,
}: {
  tone?: "info" | "warn" | "error" | "ok";
  children: ReactNode;
}) {
  const styles = {
    info: "border-border bg-bg text-muted",
    ok: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    warn: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    error: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
  }[tone];
  return <div className={`mb-4 rounded-[var(--radius-lg)] border p-3 text-sm ${styles}`}>{children}</div>;
}

/** The DNS records an integration needs, with whatever we know about each. */
export function DnsRecordTable({ records }: { records: DnsRow[] }) {
  if (!records.length) return null;
  const copyAll = () =>
    navigator.clipboard.writeText(
      records
        .map((r) => [r.type, r.name, r.priority ?? "", r.content].filter(Boolean).join("\t"))
        .join("\n"),
    );

  return (
    <div className="mb-4">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted">
          DNS records
        </span>
        <button type="button" onClick={copyAll} className="text-xs text-accent hover:underline">
          Copy all
        </button>
      </div>
      <div className="overflow-x-auto rounded-[var(--radius-lg)] border border-border">
        <table className="w-full min-w-[32rem] text-left font-mono text-xs">
          <thead className="bg-bg text-faint">
            <tr>
              <th className="px-3 py-2 font-normal">Type</th>
              <th className="px-3 py-2 font-normal">Name</th>
              <th className="px-3 py-2 font-normal">Value</th>
              <th className="px-3 py-2 font-normal">State</th>
            </tr>
          </thead>
          <tbody>
            {records.map((r) => (
              <tr key={`${r.type}-${r.name}-${r.content}`} className="border-t border-border">
                <td className="px-3 py-2">{r.type}</td>
                <td className="px-3 py-2 break-all">{r.name}</td>
                <td className="px-3 py-2 break-all">
                  {r.priority != null ? `${r.priority} ` : ""}
                  {r.content}
                </td>
                <td className="px-3 py-2">
                  <StatusPill status={r.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function StatusPill({ status }: { status: DnsRow["status"] }) {
  const map = {
    pending: ["text-faint", "waiting"],
    written: ["text-amber-600 dark:text-amber-400", "created"],
    live: ["text-emerald-600 dark:text-emerald-400", "live"],
    conflict: ["text-amber-600 dark:text-amber-400", "conflict"],
    failed: ["text-red-600 dark:text-red-400", "failed"],
  } as const;
  const [cls, label] = map[status] ?? map.pending;
  return <span className={cls}>{label}</span>;
}
