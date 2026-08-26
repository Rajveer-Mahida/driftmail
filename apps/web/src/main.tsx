import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { Toaster } from "sonner";
import { TooltipProvider } from "@/components/primitives";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { router, queryClient } from "@/router";
import { useUI } from "@/lib/store";
import "@/index.css";

function ThemedToaster() {
  const theme = useUI((s) => s.theme);
  return (
    <Toaster
      theme={theme}
      position="bottom-right"
      toastOptions={{
        style: {
          background: "var(--elevated)",
          color: "var(--fg)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          fontFamily: "var(--font-sans)",
        },
      }}
    />
  );
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider delayDuration={300} skipDelayDuration={0}>
          <RouterProvider router={router} />
          <ThemedToaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
