import { ArrowRight } from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import { COPY } from "../copy.js";
import { useOnboardingFlow } from "../onboarding-flow.js";

/**
 * Invitee step 1: a warm landing that names the team they just joined. One
 * personalized line — no setup work, no step list (the progress bar names
 * where they are once they start) — so the jump from "I clicked an invite
 * link" to "I'm configuring things" isn't jarring.
 */
export function StepWelcome() {
  const { teamDisplayName, goNext } = useOnboardingFlow();
  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-4)" }}>
      <p className="text-body" style={{ margin: 0, color: "var(--fg-2)" }}>
        You're now part of{" "}
        <span className="font-semibold" style={{ color: "var(--fg)" }}>
          {teamDisplayName ?? "your team"}
        </span>
        . To get started, let's create your own agent.
      </p>
      <div className="flex">
        <Button type="button" onClick={goNext}>
          <span>{COPY.getStarted}</span>
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
