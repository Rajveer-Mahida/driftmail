import { useEffect } from "react";
import { Outlet, Navigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { api, ApiError } from "@/api/client";
import { AnimatePresence } from "framer-motion";
import { Sidebar } from "@/components/Sidebar";
import { ChangePasswordGate } from "@/components/ChangePasswordGate";
import { Compose } from "@/components/Compose";
import { CommandPalette } from "@/components/CommandPalette";
import { KeyboardHelp } from "@/components/KeyboardHelp";
import { Button, Spinner } from "@/components/primitives";
import { useUI } from "@/lib/store";
import { useShortcuts } from "@/lib/useShortcuts";

export function AppShell() {
  const composeOpen = useUI((s) => s.composeOpen);
  const { openCompose, setPalette, setHelp } = useUI();

  // ⌘K / Ctrl-K toggles the command palette (works even from inputs).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette(!useUI.getState().paletteOpen);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setPalette]);

  useShortcuts({
    c: () => openCompose(),
    "?": () => setHelp(true),
  });

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["auth", "me"],
    queryFn: api.me,
    retry: false,
    staleTime: 60_000,
  });

  const unauthorized = error instanceof ApiError && error.status === 401;
  // Someone signing in with a temporary password gets nothing but the change
  // form, because leaving that account usable is how a handover becomes a
  // permanent shared credential.
  const mustChangePassword =
    data?.user.must_change_pw ||
    (error instanceof ApiError && error.status === 403 && error.message === "password_change_required");

  if (mustChangePassword) return <ChangePasswordGate />;

  if (isLoading) {
    return (
      <div className="app-backdrop grid h-full place-items-center">
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="flex items-center gap-3 text-muted"
        >
          <Spinner className="text-accent" />
          <span className="text-sm">Opening your inbox…</span>
        </motion.div>
      </div>
    );
  }

  if (error) {
    // A 401 means the session is gone — typically after the tab has sat in the
    // background and refetch-on-focus revalidated it. Redirect declaratively:
    // an effect + `return null` used to leave a permanently blank page whenever
    // the navigation didn't take, which is the worst possible failure here.
    if (unauthorized) return <Navigate to="/login" replace />;
    if (mustChangePassword) return <ChangePasswordGate />;
    return (
      <div className="app-backdrop grid h-full place-items-center p-6">
        <div className="max-w-sm text-center">
          <p className="font-display text-lg font-medium">Can’t reach your inbox</p>
          <p className="mt-1 text-sm text-muted">
            {(error as Error).message || "Something went wrong."}
          </p>
          <Button
            variant="primary"
            className="mt-4"
            onClick={() => refetch()}
            disabled={isFetching}
          >
            {isFetching ? "Retrying…" : "Retry"}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="app-backdrop flex h-full overflow-hidden">
      <Sidebar />
      <main className="flex min-w-0 flex-1 overflow-hidden md:p-2 md:pl-0">
        <div className="flex min-w-0 flex-1 overflow-hidden bg-surface md:rounded-2xl md:border md:border-border md:shadow-[var(--shadow-md)]">
          <Outlet />
        </div>
      </main>
      <AnimatePresence>{composeOpen && <Compose />}</AnimatePresence>
      <CommandPalette />
      <KeyboardHelp />
    </div>
  );
}
