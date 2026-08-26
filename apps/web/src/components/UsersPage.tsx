import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { AdminUserRow, SettingsResponse } from "@email/shared";
import { Button, Spinner } from "@/components/primitives";
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

  if (settings.data && settings.data.user.role !== "admin") {
    return (
      <div className="grid h-full place-items-center p-6 text-sm text-muted">
        Only an administrator can manage people.
      </div>
    );
  }

  return (
    <div className="mx-auto h-full w-full max-w-3xl overflow-y-auto p-6">
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
                        <Button onClick={() => reset.mutate(u.id)}>Reset password</Button>
                        <Button
                          onClick={() => update.mutate({ id: u.id, body: { disabled: !u.disabled } })}
                        >
                          {u.disabled ? "Enable" : "Disable"}
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

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
    </div>
  );
}
