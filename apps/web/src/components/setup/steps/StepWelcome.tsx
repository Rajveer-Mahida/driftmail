import { Button } from "@/components/primitives";
import type { StepProps } from "../SetupPage";
import { Actions, StepHeader } from "./shared";

const PLAN = [
  ["Connect Cloudflare", "One API token, so this app can configure your mail itself."],
  ["Pick a domain", "Every address on it will arrive here."],
  ["Wait for DNS", "Usually under a minute on Cloudflare."],
  ["Choose how to send", "Optional — you can receive without it."],
  ["Extras", "Notifications, AI, a signature. All optional."],
];

export function StepWelcome({ next }: StepProps) {
  return (
    <>
      <StepHeader
        title="Let's set up your inbox"
        blurb="Five short steps. Nothing changes on your Cloudflare account until you confirm it."
      />
      <ol className="mb-2 space-y-3">
        {PLAN.map(([title, blurb], i) => (
          <li key={title} className="flex gap-3">
            <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-bg text-xs text-muted">
              {i + 1}
            </span>
            <div>
              <div className="text-sm font-medium">{title}</div>
              <div className="text-xs text-muted">{blurb}</div>
            </div>
          </li>
        ))}
      </ol>
      <Actions>
        <Button variant="primary" onClick={() => next("cloudflare")}>
          Get started
        </Button>
      </Actions>
    </>
  );
}
