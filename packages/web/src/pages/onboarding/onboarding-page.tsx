import { useRef } from "react";
import { Navigate } from "react-router";
import { useAuth } from "../../auth/auth-context.js";
import { OnboardingFlowProvider, useOnboardingFlow } from "./onboarding-flow.js";
import { OnboardingShell } from "./onboarding-shell.js";
import { StepConnectCode } from "./steps/step-connect-code.js";
import { StepConnectComputer } from "./steps/step-connect-computer.js";
import { StepCreateAgent } from "./steps/step-create-agent.js";
import { StepKickoff } from "./steps/step-kickoff.js";
import { StepTeam } from "./steps/step-team.js";
import { StepWelcome } from "./steps/step-welcome.js";
import { resolveOnboardingPath, shouldLeaveOnboarding } from "./steps.js";

/**
 * Standalone, full-screen onboarding flow at `/onboarding`. Lives outside
 * the workspace chrome (no rail / top bar) so a brand-new user sees one
 * clear thing at a time. The workspace root (`/`) bounces incomplete users
 * here; once setup is terminally complete this route bounces back to `/`.
 *
 * The "bounce back" is an ENTRY-time guard, decided ONCE when `/me` first
 * loads — not a live leash re-checked every render. Both admin and invitee
 * have steps AFTER create-agent (admin: connect-code + kickoff; invitee:
 * kickoff), and creating the agent flips `currentOrgHasUsableAgent` true (the
 * flow's own `refreshMe` surfaces it the moment the agent comes online). A
 * per-render check therefore ejected an actively-onboarding user the instant
 * they made their agent, skipping those steps. Freezing the decision at entry
 * lets them finish; they leave via the explicit `completeAndEnterChat`
 * navigate at the end of kickoff (or `finishLater`).
 */
export function OnboardingPage() {
  const { meLoaded, role, onboardingStep, onboardingDismissedAt, currentOrgHasUsableAgent } = useAuth();
  const leaveDecision = useRef<boolean | null>(null);

  if (!meLoaded) {
    return <div className="min-h-screen bg-background" />;
  }
  if (leaveDecision.current === null) {
    leaveDecision.current = shouldLeaveOnboarding({
      meLoaded,
      onboardingStep,
      onboardingDismissedAt,
      currentOrgReady: currentOrgHasUsableAgent,
    });
  }
  if (leaveDecision.current) {
    return <Navigate to="/" replace />;
  }

  const path = resolveOnboardingPath(role);
  return (
    <OnboardingFlowProvider path={path}>
      <OnboardingShell>
        <OnboardingBody />
      </OnboardingShell>
    </OnboardingFlowProvider>
  );
}

function OnboardingBody() {
  const { activeStep } = useOnboardingFlow();
  switch (activeStep) {
    case "team":
      return <StepTeam />;
    case "connect-code":
      return <StepConnectCode />;
    case "connect-computer":
      return <StepConnectComputer />;
    case "create-agent":
      return <StepCreateAgent />;
    case "kickoff":
      return <StepKickoff />;
    case "welcome":
      return <StepWelcome />;
    default:
      return null;
  }
}
