import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { motion } from "framer-motion";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { setupApi } from "@/api/setup";
import { toast } from "sonner";
import { api, ApiError } from "@/api/client";
import { Button, Spinner } from "@/components/primitives";
import { Logomark } from "@/components/Logomark";

export function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const qc = useQueryClient();

  // A deployment can be claimed but not finished — someone closed the tab
  // partway through the wizard. Signed out, that state is otherwise a dead end:
  // the account may not exist yet, and nothing on this page hints at /setup.
  const setup = useQuery({
    queryKey: ["setup", "status"],
    queryFn: setupApi.status,
    staleTime: Infinity,
    retry: false,
  });
  const unfinished = setup.data?.claimed === true && setup.data.complete === false;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.login(email, password);
      await qc.invalidateQueries();
      navigate({ to: "/" });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Login failed");
      setBusy(false);
    }
  }

  return (
    <div className="app-backdrop grid min-h-full place-items-center p-6">
      <motion.div
        initial={{ opacity: 0, y: 16, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: "spring", stiffness: 260, damping: 26 }}
        className="w-full max-w-sm"
      >
        <div className="mb-8 text-center">
          <div className="mx-auto mb-5 grid h-14 w-14 place-items-center rounded-2xl bg-accent text-accent-fg shadow-[var(--shadow-md)]">
            <Logomark size={30} />
          </div>
          <h1 className="font-display text-3xl font-semibold tracking-tight">Driftmail</h1>
          <p className="mt-1.5 text-sm text-muted">Your private inbox, beautifully quiet.</p>
        </div>

        <form
          onSubmit={onSubmit}
          className="rounded-2xl border border-border bg-surface/80 p-6 shadow-[var(--shadow-lg)] backdrop-blur"
        >
          <label className="mb-2 block text-xs font-semibold uppercase tracking-wider text-muted">
            Email
          </label>
          <input
            type="email"
            autoFocus
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            className="mb-4 w-full rounded-[var(--radius-lg)] border border-border bg-bg px-4 py-3 text-fg outline-none transition focus:border-accent-ring focus:ring-4 focus:ring-accent-ring/20"
          />
          <label className="mb-2 block text-xs font-semibold uppercase tracking-wider text-muted">
            Password
          </label>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••••"
            className="mb-4 w-full rounded-[var(--radius-lg)] border border-border bg-bg px-4 py-3 text-fg outline-none transition focus:border-accent-ring focus:ring-4 focus:ring-accent-ring/20"
          />
          <Button type="submit" variant="primary" className="w-full" disabled={busy}>
            {busy ? <Spinner /> : "Enter inbox"}
          </Button>
        </form>

        {unfinished && (
          <p className="mt-4 text-center text-sm text-muted">
            Setup isn't finished yet.{" "}
            <Link to="/setup" className="text-accent hover:underline">
              Pick up where you left off
            </Link>
          </p>
        )}
      </motion.div>
    </div>
  );
}
