import { lazy, Suspense, type ComponentType } from "react";
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import { QueryClient } from "@tanstack/react-query";
import { setupApi } from "@/api/setup";
import { AppShell } from "@/components/AppShell";
import { MailLayout } from "@/components/MailLayout";
import { EmptyDetail } from "@/components/EmptyDetail";
import { Spinner } from "@/components/primitives";
import { ErrorFallback } from "@/components/ErrorBoundary";

// Code-split the heavier leaf pages into their own chunks.
const named = <T extends Record<string, ComponentType<unknown>>>(
  loader: () => Promise<T>,
  key: keyof T,
) => lazy(() => loader().then((m) => ({ default: m[key] })));

const MailDetail = named(() => import("@/components/MailDetail"), "MailDetail");
const LoginPage = named(() => import("@/components/LoginPage"), "LoginPage");
const SettingsPage = named(() => import("@/components/SettingsPage"), "SettingsPage");
const DraftsPage = named(() => import("@/components/DraftsPage"), "DraftsPage");
const AliasesPage = named(() => import("@/components/AliasesPage"), "AliasesPage");
const SetupPage = named(() => import("@/components/setup/SetupPage"), "SetupPage");
const UsersPage = named(() => import("@/components/UsersPage"), "UsersPage");
const DomainsPage = named(() => import("@/components/DomainsPage"), "DomainsPage");

function Lazy({ children }: { children: React.ReactNode }) {
  return (
    <Suspense
      fallback={
        <div className="grid h-full w-full flex-1 place-items-center">
          <Spinner className="text-accent" />
        </div>
      }
    >
      {children}
    </Suspense>
  );
}

const rootRoute = createRootRoute({
  component: () => <Outlet />,
  /**
   * An unclaimed deployment has no accounts, so /login would be a dead end —
   * send people to the wizard instead. Asked once and cached: this is on the
   * path of every navigation.
   */
  beforeLoad: async ({ location }) => {
    const status = await queryClient
      .fetchQuery({
        queryKey: ["setup", "status"],
        queryFn: setupApi.status,
        staleTime: Infinity,
      })
      .catch(() => null);
    if (!status) return;

    const onSetup = location.pathname.startsWith("/setup");
    if (!status.claimed && !onSetup) throw redirect({ to: "/setup" });
    if (status.claimed && status.complete && onSetup) throw redirect({ to: "/" });
  },
});

const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/setup",
  // A sibling of /login, outside the shell: AppShell runs the session gate, and
  // the wizard has to render before a session can exist.
  component: () => (
    <Lazy>
      <SetupPage />
    </Lazy>
  ),
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: () => (
    <Lazy>
      <LoginPage />
    </Lazy>
  ),
});

const shellRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "shell",
  component: AppShell,
});

const mailLayoutRoute = createRoute({
  getParentRoute: () => shellRoute,
  id: "mailLayout",
  component: MailLayout,
});

const indexRoute = createRoute({
  getParentRoute: () => mailLayoutRoute,
  path: "/",
  component: EmptyDetail,
});

const mailRoute = createRoute({
  getParentRoute: () => mailLayoutRoute,
  path: "/mail/$id",
  component: () => (
    <Lazy>
      <MailDetail />
    </Lazy>
  ),
});

const settingsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/settings",
  component: () => (
    <Lazy>
      <SettingsPage />
    </Lazy>
  ),
});

const draftsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/drafts",
  component: () => (
    <Lazy>
      <DraftsPage />
    </Lazy>
  ),
});

const aliasesRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/aliases",
  component: () => (
    <Lazy>
      <AliasesPage />
    </Lazy>
  ),
});

const usersRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/users",
  component: () => (
    <Lazy>
      <UsersPage />
    </Lazy>
  ),
});

const domainsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/domains",
  component: () => (
    <Lazy>
      <DomainsPage />
    </Lazy>
  ),
});

const routeTree = rootRoute.addChildren([
  setupRoute,
  loginRoute,
  shellRoute.addChildren([
    mailLayoutRoute.addChildren([indexRoute, mailRoute]),
    settingsRoute,
    draftsRoute,
    aliasesRoute,
    usersRoute,
    domainsRoute,
  ]),
]);

/**
 * One client for the whole app.
 *
 * It lives here rather than in main.tsx because the root route's beforeLoad
 * needs it: two instances would each fetch the setup status, and could disagree
 * about whether this deployment has been claimed.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      retry: (count, err) => ((err as { status?: number })?.status === 401 ? false : count < 2),
      refetchOnWindowFocus: true,
    },
  },
});

export const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  scrollRestoration: true,
  // The router catches anything thrown inside a route component, so the
  // top-level ErrorBoundary never sees those. Without this, they fall back to
  // the router's bare default error component.
  defaultErrorComponent: ({ error, reset }) => (
    <ErrorFallback error={error as Error} onRetry={reset} />
  ),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
