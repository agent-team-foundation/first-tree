import { ArrowRight } from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import { COPY } from "../copy.js";
import { useOnboardingFlow } from "../onboarding-flow.js";

/**
 * Invitee step 1: a warm landing that names the team they just joined and
 * sets expectations for the two quick steps ahead (connect a computer,
 * create their AI teammate). No setup work here — just orientation so the
 * jump from "I clicked an invite link" to "I'm configuring things" isn't
 * jarring.
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
        . Your team's projects and knowledge base are already set up — you just need your own AI teammate.
      </p>
      <p className="text-label" style={{ margin: 0, color: "var(--fg-3)" }}>
        Two quick steps: connect a computer for it to run on, then give it a name.
      </p>
      <div className="flex">
        <Button type="button" onClick={goNext}>
          <span>{COPY.continue}</span>
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
