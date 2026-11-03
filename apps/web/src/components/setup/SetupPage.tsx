import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { motion } from "framer-motion";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { setupApi, type SetupStep } from "@/api/setup";
import { Spinner } from "@/components/primitives";
import { Logomark } from "@/components/Logomark";
import { StepWelcome } from "./steps/StepWelcome";
import { StepCloudflare } from "./steps/StepCloudflare";
import { StepDomain } from "./steps/StepDomain";
import { StepRouting } from "./steps/StepRouting";
import { StepSending } from "./steps/StepSending";
import { StepExtras } from "./steps/StepExtras";
import { StepDone } from "./steps/StepDone";

/** Order matters: it drives both the stepper and "which steps are behind me". */
const STEPS: { id: SetupStep; label: string }[] = [
  { id: "welcome", label: "Start" },
  { id: "cloudflare", label: "Cloudflare" },
  { id: "domain", label: "Domain" },
  { id: "routing", label: "DNS" },
  { id: "sending", label: "Sending" },
  { id: "extras", label: "Extras" },
  { id: "done", label: "Done" },
];

export type StepProps = {
  /** Advance and persist. */
  next: (to?: SetupStep) => void;
  back: () => void;
  /** Record that this step was passed over, then advance. */
  skip: () => void;
  state: SetupState;
  patch: (s: Partial<SetupState>) => void;
};

/** What the wizard learns as it goes. Server-side progress is the source of
 *  truth for *which* step; this is the detail the steps hand each other. */
export type SetupState = {
  hostname: string;
  workerName: string;
  workerSource: string;
  adminEmail: string;
  domain: string;
  managedDns: boolean;
  hasCloudflare: boolean;
};

export function SetupPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ["setup", "status"], queryFn: setupApi.status });

  const [step, setStep] = useState<SetupStep | null>(null);
  const [state, setState] = useState<SetupState>({
    hostname: "",
    workerName: "",
    workerSource: "",
    adminEmail: "",
    domain: "",
    managedDns: true,
    hasCloudflare: false,
  });

  // Progress lives on the server, so a refresh — or finishing on another
  // device — resumes exactly where it left off rather than starting over.
  useEffect(() => {
    if (!status.data) return;
    if (status.data.complete) {
      navigate({ to: "/" });
      return;
    }
    // "worker" was a step in older versions; an instance paused there resumes
    // at the domain step, which now uses the detected or default Worker name.
    const resumed = (status.data.step as string) === "worker" ? "domain" : status.data.step;
    setStep((current) => current ?? (status.data.claimed ? resumed : "welcome"));
    setState((s) => ({ ...s, hostname: status.data.hostname ?? s.hostname }));
  }, [status.data, navigate]);

  if (status.isLoading || !step) {
    return (
      <div className="app-backdrop grid min-h-full place-items-center">
        <Spinner className="text-accent" />
      </div>
    );
  }

  const index = STEPS.findIndex((s) => s.id === step);

  const goto = (to: SetupStep) => setStep(to);
  const next = (to?: SetupStep) => goto(to ?? STEPS[Math.min(index + 1, STEPS.length - 1)].id);
  const back = () => goto(STEPS[Math.max(index - 1, 0)].id);
  const skip = () => {
    void setupApi.skip(step).catch(() => {});
    next();
  };

  const props: StepProps = {
    next,
    back,
    skip,
    state,
    patch: (s) => setState((prev) => ({ ...prev, ...s })),
  };

  const finish = async () => {
    await setupApi.complete().catch(() => {});
    await qc.invalidateQueries();
    navigate({ to: "/" });
  };

  return (
    <div className="app-backdrop min-h-full overflow-y-auto p-6">
      <div className="mx-auto w-full max-w-2xl py-10">
        <header className="mb-8 flex items-center gap-3">
          <div className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-accent text-accent-fg shadow-[var(--shadow-md)]">
            <Logomark size={24} />
          </div>
          <div className="min-w-0">
            <h1 className="font-display text-xl font-semibold tracking-tight">Set up Driftmail</h1>
            <p className="truncate text-xs text-muted">{state.hostname || "this deployment"}</p>
          </div>
        </header>

        <nav aria-label="Setup progress" className="mb-6 flex flex-wrap gap-1.5">
          {STEPS.map((s, i) => {
            const done = i < index;
            return (
              <button
                key={s.id}
                type="button"
                // Going back to review a finished step is fine; skipping ahead
                // past the cursor is not, because later steps need earlier answers.
                disabled={i > index}
                onClick={() => goto(s.id)}
                className={`rounded-full px-3 py-1 text-xs transition ${
                  i === index
                    ? "bg-accent text-accent-fg"
                    : done
                      ? "bg-surface text-muted hover:text-fg"
                      : "text-faint"
                }`}
              >
                {s.label}
              </button>
            );
          })}
        </nav>

        <motion.div
          key={step}
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ type: "spring", stiffness: 260, damping: 26 }}
          className="rounded-2xl border border-border bg-surface/80 p-6 shadow-[var(--shadow-lg)] backdrop-blur"
        >
          {step === "welcome" && <StepWelcome {...props} />}
          {step === "cloudflare" && <StepCloudflare {...props} />}
          {step === "domain" && <StepDomain {...props} />}
          {step === "routing" && <StepRouting {...props} />}
          {step === "sending" && <StepSending {...props} />}
          {step === "extras" && <StepExtras {...props} />}
          {step === "done" && <StepDone {...props} onFinish={finish} />}
        </motion.div>
      </div>
    </div>
  );
}
