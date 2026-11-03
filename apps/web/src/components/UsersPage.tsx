import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { AdminUserRow, DomainsResponse, SettingsResponse } from "@email/shared";
import { Button, ConfirmDialog, Spinner } from "@/components/primitives";
import { ApiError } from "@/api/client";

type UsersResponse = { users: AdminUserRow[] };
type PreviewResponse = {
  address: string;
  result:
    | { kind: "deliver"; user: { handle: string; email: string } | null; reason: string }
    | { kind: "reject"; code: string };
};

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "include",
    headers: init?.body ? { "content-type": "application/json" } : undefined,
    ...init,
  });
  const json = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) throw new ApiError(res.status, json?.error ?? res.statusText);
  return json as T;
}

const REASON_LABEL: Record<string, string> = {
  alias: "an alias you created",
  alias_base: "an alias, ignoring the +tag",
  handle: "their handle",
  email: "their login address",
  subaddress: "their handle used as a sub-address",
  catchall: "the domain's catch-all",
};

const REJECT_LABEL: Record<string, string> = {
  bad_address: "that isn't a usable address",
  unknown_domain: "this instance doesn't handle that domain",
  disabled_alias: "that alias is turned off",
  disabled_owner: "that mailbox is disabled",
  not_allowed: "the domain only accepts addresses matching its pattern",
  no_owner: "nothing claims it, and the domain has no catch-all",
};

const inputClass =
  "w-full rounded-[var(--radius-lg)] border border-border bg-bg px-3 py-2 text-sm outline-none transition focus:border-accent-ring focus:ring-4 focus:ring-accent-ring/20";

export function UsersPage() {
  const qc = useQueryClient();
  const settings = useQuery<SettingsResponse>({
    queryKey: ["settings"],
    queryFn: () => req<SettingsResponse>("/api/settings"),
  });
  const users = useQuery({
    queryKey: ["admin", "users"],
    queryFn: () => req<UsersResponse>("/api/admin/users"),
  });

  const [email, setEmail] = useState("");
  const [handle, setHandle] = useState("");
  const [tempPassword, setTempPassword] = useState<{ email: string; password: string } | null>(null);
  const [preview, setPreview] = useState("");
  /** Pending confirmation: which user, and which of the two heavy actions. */
  const [pending, setPending] = useState<{ user: AdminUserRow; kind: "reset" | "disable" } | null>(
    null,
  );

  const refresh = () => qc.invalidateQueries({ queryKey: ["admin", "users"] });

  const create = useMutation({
    mutationFn: () =>
      req<{ user: AdminUserRow; temp_password: string }>("/api/admin/users", {
        method: "POST",
        body: JSON.stringify({ email: email.trim(), handle: handle.trim() || undefined }),
      }),
    onSuccess: (res) => {
      // Shown once, and only here: it is never stored in a readable form, and
      // the account is forced to change it at first sign-in.
      setTempPassword({ email: res.user.email, password: res.temp_password });
      setEmail("");
      setHandle("");
      void refresh();
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const update = useMutation({
    mutationFn: (v: { id: string; body: Record<string, unknown> }) =>
      req(`/api/admin/users/${v.id}`, { method: "PATCH", body: JSON.stringify(v.body) }),
    onSuccess: () => void refresh(),
    onError: (err) => toast.error((err as Error).message),
  });

  const reset = useMutation({
    mutationFn: (id: string) =>
      req<{ temp_password: string }>(`/api/admin/users/${id}/reset-password`, { method: "POST" }),
    onSuccess: (res, id) => {
      const user = users.data?.users.find((u) => u.id === id);
      setTempPassword({ email: user?.email ?? "", password: res.temp_password });
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const routeCheck = useQuery({
    queryKey: ["admin", "preview", preview],
    queryFn: () =>
      req<PreviewResponse>(`/api/admin/routing/preview?address=${encodeURIComponent(preview)}`),
    enabled: preview.includes("@"),
  });

  const domainsQ = useQuery({
    queryKey: ["admin", "domains"],
    queryFn: () => req<DomainsResponse>("/api/domains"),
  });

  const setCatchall = useMutation({
    mutationFn: (v: { domain: string; userId: string | null }) =>
      req(`/api/admin/domains/${encodeURIComponent(v.domain)}/catchall`, {
        method: "POST",
        body: JSON.stringify({ userId: v.userId }),
      }),
    onSuccess: (_res, v) => {
      toast.success(
        v.userId ? `Catch-all set for ${v.domain}` : `Catch-all removed for ${v.domain}`,
      );
      void qc.invalidateQueries({ queryKey: ["admin", "domains"] });
      void refresh();
    },
    onError: (err) => toast.error((err as Error).message),
  });

  if (settings.data && settings.data.user.role !== "admin") {
    return (
      <div className="grid h-full min-w-0 flex-1 place-items-center p-6 text-sm text-muted">
        Only an administrator can manage people.
      </div>
    );
  }

  return (
    // Same shell contract as SettingsPage/DraftsPage: the route root is the
    // flex-1 scroll region, and a centered column lives inside it. A w-full
    // root here fought the AppShell flex row and slid under the sidebar.
    <div className="scroll-thin h-full min-w-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-8 md:px-10">
      <h1 className="mb-1 font-display text-2xl font-semibold tracking-tight">People</h1>
      <p className="mb-6 text-sm text-muted">
        Everyone here gets their own inbox. Mail is routed by handle, so{" "}
        <span className="font-mono">handle@</span>, <span className="font-mono">handle.tag@</span>{" "}
        and <span className="font-mono">tag-handle@</span> all reach the same person.
      </p>

      {tempPassword && (
        <div className="mb-6 rounded-[var(--radius-lg)] border border-amber-500/30 bg-amber-500/10 p-4">
          <p className="mb-2 text-sm font-medium">
            Temporary password for {tempPassword.email}
          </p>
          <p className="mb-3 font-mono text-sm">{tempPassword.password}</p>
          <p className="mb-3 text-xs text-muted">
            This is the only time it's shown. They'll be asked to change it when they first sign in.
          </p>
          <div className="flex gap-2">
            <Button
              onClick={() => {
                void navigator.clipboard.writeText(tempPassword.password);
                toast.success("Copied");
              }}
            >
              Copy
            </Button>
            <Button onClick={() => setTempPassword(null)}>Done</Button>
          </div>
        </div>
      )}

      <section className="mb-8 rounded-2xl border border-border bg-surface/60 p-4">
        <h2 className="mb-3 text-sm font-medium">Add someone</h2>
        <div className="flex flex-wrap gap-2">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="them@example.com"
            className={`${inputClass} min-w-48 flex-1`}
          />
          <input
            value={handle}
            onChange={(e) => setHandle(e.target.value.toLowerCase())}
            placeholder={email.split("@")[0] || "handle"}
            className={`${inputClass} w-40`}
          />
          <Button
            variant="primary"
            disabled={!email.includes("@") || create.isPending}
            onClick={() => create.mutate()}
          >
            {create.isPending ? <Spinner /> : "Add"}
          </Button>
        </div>
      </section>

      <section className="mb-8">
        {users.isLoading ? (
          <Spinner className="text-accent" />
        ) : (
          <div className="overflow-x-auto rounded-2xl border border-border">
            <table className="w-full min-w-[36rem] text-left text-sm">
              <thead className="bg-bg text-xs text-faint">
                <tr>
                  <th className="px-4 py-2 font-normal">Person</th>
                  <th className="px-4 py-2 font-normal">Handle</th>
                  <th className="px-4 py-2 font-normal">Mail</th>
                  <th className="px-4 py-2 font-normal">Role</th>
                  <th className="px-4 py-2 font-normal" />
                </tr>
              </thead>
              <tbody>
                {(users.data?.users ?? []).map((u) => (
                  <tr key={u.id} className="border-t border-border">
                    <td className="px-4 py-3">
                      <div className="truncate">{u.name ?? u.email}</div>
                      {u.name && <div className="truncate text-xs text-faint">{u.email}</div>}
                      {u.catchall_domains.length > 0 && (
                        <div className="text-xs text-faint">
                          catch-all for {u.catchall_domains.join(", ")}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs">{u.handle}</td>
                    <td className="px-4 py-3 text-xs text-muted">
                      {u.message_count} messages · {u.alias_count} aliases
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs ${
                          u.disabled
                            ? "bg-red-500/10 text-red-600 dark:text-red-400"
                            : u.role === "admin"
                              ? "bg-accent/10 text-accent"
                              : "text-muted"
                        }`}
                      >
                        {u.disabled ? "disabled" : u.role}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-1">
                        {/* Both of these hit a real person: a reset signs them
                            out of every device; a disable also bounces their
                            mail. Re-enabling is harmless and stays instant. */}
                        <Button onClick={() => setPending({ user: u, kind: "reset" })}>
                          Reset password
                        </Button>
                        {u.disabled ? (
                          <Button
                            onClick={() => update.mutate({ id: u.id, body: { disabled: false } })}
                          >
                            Enable
                          </Button>
                        ) : (
                          <Button onClick={() => setPending({ user: u, kind: "disable" })}>
                            Disable
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {(domainsQ.data?.domains.length ?? 0) > 0 && (
        <section className="mb-8 rounded-2xl border border-border bg-surface/60 p-4">
          <h2 className="mb-1 text-sm font-medium">Catch-all</h2>
          <p className="mb-3 text-xs text-muted">
            Mail that no alias or handle claims is delivered to this person, so{" "}
            <span className="font-mono">anything@</span> on the domain reaches an inbox. With no
            one set, unmatched mail bounces.
          </p>
          <div className="space-y-2">
            {domainsQ.data?.domains.map((d) => (
              <div key={d.domain} className="flex flex-wrap items-center gap-2">
                <span className="w-48 truncate font-mono text-xs">{d.domain}</span>
                <select
                  value={d.catchall_user_id ?? ""}
                  disabled={setCatchall.isPending}
                  onChange={(e) =>
                    setCatchall.mutate({ domain: d.domain, userId: e.target.value || null })
                  }
                  className={`${inputClass} max-w-72 flex-1`}
                >
                  <option value="">No one — unmatched mail bounces</option>
                  {(users.data?.users ?? [])
                    .filter((u) => !u.disabled)
                    .map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name ?? u.email} ({u.handle})
                      </option>
                    ))}
                </select>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="rounded-2xl border border-border bg-surface/60 p-4">
        <h2 className="mb-1 text-sm font-medium">Where would mail go?</h2>
        <p className="mb-3 text-xs text-muted">
          Sub-address routing is the one part of this that can surprise you, so you can just ask.
        </p>
        <input
          value={preview}
          onChange={(e) => setPreview(e.target.value.toLowerCase())}
          placeholder="netflix.rajveer@example.com"
          className={`${inputClass} mb-3 font-mono`}
        />
        {routeCheck.data && (
          <p className="text-sm">
            {routeCheck.data.result.kind === "deliver" ? (
              <>
                → <strong>{routeCheck.data.result.user?.handle ?? "unknown"}</strong>
                <span className="text-muted">
                  {" "}
                  , matched by {REASON_LABEL[routeCheck.data.result.reason] ?? routeCheck.data.result.reason}
                </span>
              </>
            ) : (
              <span className="text-amber-600 dark:text-amber-400">
                Rejected — {REJECT_LABEL[routeCheck.data.result.code] ?? routeCheck.data.result.code}
              </span>
            )}
          </p>
        )}
      </section>

      <ConfirmDialog
        open={!!pending}
        onOpenChange={(o) => !o && setPending(null)}
        title={
          pending?.kind === "reset"
            ? `Reset ${pending.user.email}'s password?`
            : `Disable ${pending?.user.email}?`
        }
        description={
          pending?.kind === "reset"
            ? "They're signed out of every device, and you'll get a temporary password to hand them — shown once."
            : "They can't sign in, and mail to their addresses bounces until re-enabled. Their mailbox is kept."
        }
        confirmLabel={pending?.kind === "reset" ? "Reset password" : "Disable account"}
        busy={reset.isPending || update.isPending}
        onConfirm={() => {
          if (!pending) return;
          if (pending.kind === "reset") {
            reset.mutate(pending.user.id, { onSettled: () => setPending(null) });
          } else {
            update.mutate(
              { id: pending.user.id, body: { disabled: true } },
              { onSettled: () => setPending(null) },
            );
          }
        }}
      />
      </div>
    </div>
  );
}
