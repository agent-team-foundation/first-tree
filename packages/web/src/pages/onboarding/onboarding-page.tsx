import { Navigate } from "react-router";
import { useAuth } from "../../auth/auth-context.js";
import { OnboardingFlowProvider, useOnboardingFlow } from "./onboarding-flow.js";
import { OnboardingShell } from "./onboarding-shell.js";
import { ProgressRail } from "./progress-rail.js";
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
 */
export function OnboardingPage() {
  const { meLoaded, role, onboardingStep, onboardingDismissedAt, onboardingCompletedAt } = useAuth();

  if (!meLoaded) {
    return <div className="min-h-screen bg-background" />;
  }
  if (shouldLeaveOnboarding({ meLoaded, onboardingStep, onboardingDismissedAt, onboardingCompletedAt })) {
    return <Navigate to="/" replace />;
  }

  const path = resolveOnboardingPath(role);
  return (
    <OnboardingFlowProvider path={path}>
      <OnboardingShell rail={<ProgressRail />}>
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
