import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { PasswordInput, Button, Spinner } from "@/components/primitives";
import { ApiError } from "@/api/client";
import { setupApi, type Capability, type TokenCheck } from "@/api/setup";
import type { StepProps } from "../SetupPage";
import { Actions, Field, Notice, StepHeader, inputClass } from "./shared";

/** The new account-owned tokens (Manage Account → Account API Tokens). */
const ACCOUNT_TOKEN_URL = "https://dash.cloudflare.com/?to=/:account/api-tokens";
// The older user-owned token editor lives at dash.cloudflare.com/profile/api-tokens;
// its recipe sits in a <details> below, so no separate link constant is needed.

/** What to tick in Cloudflare, before any token has been checked. Once one is,
 *  the live results from the server replace this list. */
const SCOPES: Capability[] = [
  {
    id: "workers.read",
    group: "Account",
    permission: "Workers Scripts",
    level: "Read",
    why: "prove this token's account runs this Worker, and find its name",
    required: true,
    ok: false,
  },
  {
    id: "zone.read",
    group: "Zone",
    permission: "Zone",
    level: "Read",
    why: "list the domains you can choose from",
    required: true,
    ok: false,
  },
  {
    id: "email_routing.read",
    group: "Zone",
    permission: "Email Routing Rules",
    level: "Edit",
    why: "point your domain's catch-all at this Worker",
    required: true,
    ok: false,
  },
  {
    id: "email_addresses.read",
    // Account, not Zone: destination addresses are account-wide, and that is the
    // only place Cloudflare's token editor offers this permission.
    group: "Account",
    permission: "Email Routing Addresses",
    level: "Edit",
    why: "verify forwarding destinations",
    required: false,
    ok: false,
  },
  {
    id: "dns.read",
    group: "Zone",
    permission: "DNS",
    level: "Edit",
    why: "write the MX and SPF records for you",
    required: false,
    ok: false,
  },
];

/**
 * One policy of the account-token editor, as a follow-along recipe: the scope to
 * pick in the dropdown, then category → permission → level for each row. Every
 * cell mirrors the editor's own wording, because "search around for something
 * like X" is what kept going wrong.
 */
function PolicyRecipe({
  title,
  scope,
  rows,
  check,
}: {
  title: string;
  scope: string;
  /** [capability id, category, permission, level] — the id ties the row to the
   *  live check result, so the verdict lands on the row being followed instead
   *  of in a second table repeating the same permissions. */
  rows: Array<[id: string, category: string, permission: string, level: string]>;
  check: TokenCheck | null;
}) {
  const byId = new Map((check?.capabilities ?? []).map((cap) => [cap.id, cap]));
  return (
    <div className="mb-3 overflow-hidden rounded-[var(--radius-lg)] border border-border">
      <div className="border-b border-border bg-surface/60 px-3 py-2 text-xs">
        <span className="font-medium">{title}</span>
        <span className="text-faint"> · scope: </span>
        <span className="font-mono text-muted">{scope}</span>
      </div>
      <table className="w-full text-left text-xs">
        <thead>
          <tr className="text-faint">
            {check && <th className="pb-1 pl-3 pt-2 font-normal" aria-label="status" />}
            <th className="px-3 pb-1 pt-2 font-normal">Category</th>
            <th className="px-3 pb-1 pt-2 font-normal">Permission</th>
            <th className="px-3 pb-1 pt-2 font-normal">Tick</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([id, category, permission, level]) => {
            const cap = byId.get(id);
            return (
              <tr key={permission} className="border-t border-border align-top">
                {check && (
                  <td className="py-1.5 pl-3">
                    <span
                      aria-label={cap?.ok ? "granted" : "missing"}
                      className={
                        cap?.ok
                          ? "text-emerald-600 dark:text-emerald-400"
                          : cap?.required
                            ? "text-red-600 dark:text-red-400"
                            : "text-amber-600 dark:text-amber-400"
                      }
                    >
                      {cap?.ok ? "✓" : "✕"}
                    </span>
                  </td>
                )}
                <td className="px-3 py-1.5 text-faint">{category}</td>
                <td className="px-3 py-1.5 font-mono">{permission}</td>
                <td className="px-3 py-1.5 font-medium">
                  {level}
                  {check && cap && !cap.ok && cap.detail && (
                    <span className="mt-0.5 block font-sans font-normal text-red-600/80 dark:text-red-400/80">
                      {cap.detail}
                    </span>
                  )}
                  {check && cap?.ok && cap.detail && (
                    <span className="mt-0.5 block font-sans font-normal text-faint">
                      {cap.detail}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * `checked` is what turns this from instructions into a diagnosis.
 *
 * Before a token is checked, every row is just something to tick in Cloudflare.
 * After, each row says whether THIS token can actually do it — which is the
 * difference between "here's a list, go compare it yourself" and being told
 * precisely which permission is missing.
 */
function PermissionTable({ rows, checked }: { rows: Capability[]; checked: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[26rem] text-left text-xs">
        <thead>
          <tr className="text-faint">
            {checked && <th className="pb-1 pr-2 font-normal" />}
            {/* "Account/Zone" is how the USER token editor arranges its rows.
                The account editor arranges by product category instead — the
                mapping list under the table covers that one. */}
            <th className="pb-1 pr-2 font-normal">Scope</th>
            <th className="pb-1 pr-2 font-normal">Permission</th>
            <th className="pb-1 pr-2 font-normal">Level</th>
            <th className="pb-1 font-normal">So it can…</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((cap) => (
            <tr key={cap.id} className="border-t border-border align-top">
              {checked && (
                <td className="py-1.5 pr-2">
                  <span
                    aria-label={cap.ok ? "granted" : "missing"}
                    className={
                      cap.ok
                        ? "text-emerald-600 dark:text-emerald-400"
                        : cap.required
                          ? "text-red-600 dark:text-red-400"
                          : "text-amber-600 dark:text-amber-400"
                    }
                  >
                    {cap.ok ? "✓" : "✕"}
                  </span>
                </td>
              )}
              <td className="py-1.5 pr-2 text-faint">{cap.group}</td>
              <td className="py-1.5 pr-2">{cap.permission}</td>
              <td className="py-1.5 pr-2 font-medium">{cap.level}</td>
              <td className="py-1.5 text-faint">
                {cap.why}
                {!cap.required && !checked && " (optional)"}
                {checked && !cap.ok && !cap.required && " — optional; you'd add DNS records by hand"}
                {checked && !cap.ok && cap.detail && (
                  <span className="mt-0.5 block text-red-600/80 dark:text-red-400/80">
                    {cap.detail}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The claim.
 *
 * The Cloudflare token is not just configuration here — it is the proof that
 * whoever is filling this in owns the account running this Worker. That is why
 * the admin account is created in the same request: one atomic step, so an
 * unclaimed deployment cannot be taken over by whoever finds the URL first.
 */
export function StepCloudflare({ next, back, patch }: StepProps) {
  const qc = useQueryClient();
  const [mode, setMode] = useState<"cf" | "token">("cf");
  const [showHelp, setShowHelp] = useState(true);
  const [cfToken, setCfToken] = useState("");
  const [setupToken, setSetupToken] = useState("");
  const [accountId, setAccountId] = useState("");
  const [needAccountId, setNeedAccountId] = useState(false);
  const [check, setCheck] = useState<TokenCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [email, setEmail] = useState("");
  const [handle, setHandle] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const derivedHandle = handle || email.split("@")[0] || "";

  /** Find out what the token can do, without committing to it. */
  async function runCheck({ keepError = false } = {}) {
    setChecking(true);
    if (!keepError) setError(null);
    try {
      const result = await setupApi.checkToken(cfToken.trim(), {
        accountId: accountId.trim() || undefined,
      });
      setCheck(result);
      // A failure is only actionable next to the list, so open it.
      if (!result.ok) setShowHelp(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't check that token");
    } finally {
      setChecking(false);
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await setupApi.claim({
        ...(mode === "cf" ? { cfToken: cfToken.trim() } : { setupToken: setupToken.trim() }),
        ...(accountId.trim() ? { accountId: accountId.trim() } : {}),
        email: email.trim(),
        handle: derivedHandle,
        password,
      });

      patch({
        adminEmail: email.trim(),
        workerName: res.worker.name,
        workerSource: res.worker.source,
        hasCloudflare: mode === "cf",
        domain: res.servingZone?.name ?? "",
      });

      const adopted = Object.values(res.adopted ?? {}).reduce((n, v) => n + v, 0);
      if (adopted > 0) {
        toast.success(`Existing mail moved into your inbox (${adopted} rows).`);
      }
      // The claim signs you in, so everything cached before it is stale.
      await qc.invalidateQueries();
      next(res.nextStep);
    } catch (err) {
      const code = (err as ApiError & { code?: string }).code;
      if (code === "account_undetermined") {
        // A tightly scoped token may not be allowed to list accounts. Asking for
        // the id is the difference between "works" and "works for me".
        setNeedAccountId(true);
      }
      setError(err instanceof ApiError ? err.message : "Setup failed");
      // A rejected claim is usually a permissions problem, and the table says
      // which one. Awaited, and keeping the error: firing it unawaited let the
      // two messages race and contradict each other on screen.
      if (mode === "cf" && cfToken.trim() && !check) await runCheck({ keepError: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit}>
      <StepHeader
        title="Connect Cloudflare, and create your account"
        blurb="The token proves this deployment is yours, and lets Driftmail configure your own mail routing without you touching the dashboard."
      />

      {error && <Notice tone="error">{error}</Notice>}

      {check &&
        (check.ok ? (
          error ? (
            <Notice tone="warn">
              The token's permissions are all fine, so the problem above isn't a missing
              permission. Most often the token belongs to a different Cloudflare account than the
              one running this Worker.
            </Notice>
          ) : (
            <Notice tone="ok">This token has everything setup needs.</Notice>
          )
        ) : (
          <Notice tone="error">
            {check.missingRequired.length === 1
              ? "One permission is missing — it's marked below."
              : `${check.missingRequired.length} permissions are missing — they're marked below.`}{" "}
            Add them to the same token in Cloudflare, or make a new one, then check again.
          </Notice>
        ))}

      {mode === "cf" ? (
        <>
          <Field
            label="Cloudflare API token"
            hint={
              <>
                Stored in this app's database.{" "}
                <button
                  type="button"
                  className="text-accent hover:underline"
                  onClick={() => setShowHelp((v) => !v)}
                >
                  {showHelp ? "Hide the setup steps" : "How do I make one?"}
                </button>
              </>
            }
          >
            <textarea
              autoFocus
              rows={3}
              value={cfToken}
              onChange={(e) => {
                setCfToken(e.target.value);
                // A previous result says nothing about a different token.
                setCheck(null);
              }}
              placeholder="Paste the token value here"
              className={`${inputClass} resize-none font-mono text-xs`}
            />
          </Field>

          <div className="-mt-2 mb-4">
            <Button type="button" onClick={() => void runCheck()} disabled={!cfToken.trim() || checking}>
              {checking ? <Spinner /> : check ? "Check again" : "Check permissions"}
            </Button>
          </div>

          {showHelp && (
            <div className="mb-4 rounded-[var(--radius-lg)] border border-border bg-bg p-4 text-sm">
              <p className="mb-2 text-muted">
                Make an{" "}
                <a
                  href={ACCOUNT_TOKEN_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="text-accent hover:underline"
                >
                  Account API token
                </a>{" "}
                (Manage Account → Account API Tokens → Create Token) with{" "}
                <strong className="text-fg">two policies</strong> — a policy only lists the
                permissions that exist at its scope, which is why everything can't go in one:
              </p>

              <PolicyRecipe
                title="Policy 1"
                scope="Entire Account"
                check={check}
                rows={[
                  ["workers.read", "Developer Platform", "Workers Scripts", "Read"],
                  ["email_addresses.read", "Email & Messaging", "Email Routing Addresses", "Edit"],
                ]}
              />
              <PolicyRecipe
                title="Policy 2 — Add policy, then change its scope"
                scope="Specified Domains → your mail domain"
                check={check}
                rows={[
                  ["email_routing.read", "Email & Messaging", "Email Routing Rules", "Edit"],
                  ["zone.read", "DNS & Zones", "Zone", "Read"],
                  ["dns.read", "DNS & Zones", "DNS", "Edit"],
                ]}
              />

              <p className="mb-3 text-xs text-faint">
                Category names are where each entry lives; the search box finds them faster. Menu
                wording drifts — "Edit" may appear as "Write" — so after creating the token,{" "}
                <strong className="text-muted">Check permissions</strong> above is the authority.
                Skip anything else the search surfaces (Suppressions, "Email Routing{" "}
                <em>Account</em> Rules" — that one is read-only and not the same thing).
              </p>

              {check && (
                <p className="mb-3 text-xs text-faint">
                  An <strong className="text-muted">Edit</strong> permission is checked as far as
                  its read half — a token with Read but not Edit passes here and fails later at
                  the write.
                </p>
              )}

              <details className="mb-3 text-xs text-muted">
                <summary className="cursor-pointer">
                  Using the older user token instead? (My Profile → API Tokens)
                </summary>
                <div className="mt-2">
                  <p className="mb-2">
                    Create Token → Create Custom Token, then add these rows; scope{" "}
                    <strong className="text-fg">Zone Resources</strong> to your mail domain:
                  </p>
                  <PermissionTable rows={SCOPES} checked={false} />
                </div>
              </details>

              <p className="text-xs text-faint">
                <strong className="text-muted">Where the token lives.</strong> It is stored in this
                app's database, so anyone with access to your Cloudflare account — or anyone who
                can deploy code to this Worker — can read it. That is the same exposure as a Worker
                secret. You can revoke it any time in the Cloudflare dashboard.
              </p>
            </div>
          )}

          {needAccountId && (
            <Field
              label="Cloudflare account ID"
              hint="That token can't list your Cloudflare accounts, so it needs to be told which one. You'll find the ID in the dashboard URL, or on any domain's Overview page."
            >
              <input
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
                className={`${inputClass} font-mono text-xs`}
              />
            </Field>
          )}
        </>
      ) : (
        <Field
          label="Setup token"
          hint="The value of the SETUP_TOKEN secret you set on this Worker."
        >
          <PasswordInput
            autoFocus
            value={setupToken}
            onChange={(e) => setSetupToken(e.target.value)}
            className={inputClass}
          />
        </Field>
      )}

      <button
        type="button"
        className="mb-5 text-xs text-muted hover:text-fg hover:underline"
        onClick={() => setMode((m) => (m === "cf" ? "token" : "cf"))}
      >
        {mode === "cf"
          ? "I'd rather not hand over a Cloudflare token — use a setup token instead"
          : "Use a Cloudflare API token instead"}
      </button>

      <div className="mb-1 border-t border-border pt-5">
        <h3 className="mb-4 text-sm font-medium">Your account</h3>
        <Field label="Email address" hint="This is your login, and your first mail address.">
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            className={inputClass}
          />
        </Field>
        <Field
          label="Handle"
          hint={
            derivedHandle
              ? `Mail to ${derivedHandle}@, ${derivedHandle}.anything@ and anything-${derivedHandle}@ all reach you.`
              : "The short name that routes mail to you."
          }
        >
          <input
            value={handle}
            onChange={(e) => setHandle(e.target.value.toLowerCase())}
            placeholder={email.split("@")[0] || "you"}
            className={inputClass}
          />
        </Field>
        <Field label="Password" hint="At least 12 characters.">
          <PasswordInput
            required
            minLength={12}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={inputClass}
          />
        </Field>
      </div>

      <Actions onBack={back}>
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? <Spinner /> : "Connect and continue"}
        </Button>
      </Actions>
    </form>
  );
}
