import { ArrowRight } from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import { COPY } from "../copy.js";
import { useOnboardingFlow } from "../onboarding-flow.js";

/**
 * Invitee step 1. Joining is already settled by the invite acceptance flow;
 * this screen confirms the selected team before the member connects their
 * computer and creates their agent.
 */
export function StepWelcome() {
  const { teamDisplayName, goNext } = useOnboardingFlow();
  return (
    <div className="flex flex-col" style={{ width: "100%", gap: "var(--sp-5)" }}>
      <p className="text-body" style={{ margin: 0, color: "var(--fg-3)" }}>
        {COPY.invitee.welcomeBody.pre}
        <span className="font-semibold" style={{ color: "var(--fg)" }}>
          {teamDisplayName ?? "your team"}
        </span>
        {COPY.invitee.welcomeBody.post}
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
