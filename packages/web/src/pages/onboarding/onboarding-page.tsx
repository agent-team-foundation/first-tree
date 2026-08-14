import { useRef } from "react";
import { Navigate } from "react-router";
import { useAuth } from "../../auth/auth-context.js";
import { OnboardingFlowProvider, useOnboardingFlow } from "./onboarding-flow.js";
import { OnboardingShell } from "./onboarding-shell.js";
import { StepConnectComputer } from "./steps/step-connect-computer.js";
import { StepCreateAgent } from "./steps/step-create-agent.js";
import { StepGetStarted } from "./steps/step-get-started.js";
import { StepStartChat } from "./steps/step-start-chat.js";
import { StepTeam } from "./steps/step-team.js";
import { resolveOnboardingPath, shouldLeaveOnboarding } from "./steps.js";

/**
 * Standalone, full-screen onboarding flow at `/onboarding`. Lives outside
 * the workspace chrome (no rail / top bar) so a brand-new user sees one
 * clear thing at a time. The workspace root (`/`) bounces incomplete users
 * here; once setup is terminally complete this route bounces back to `/`.
 *
 * The "bounce back" is an ENTRY-time guard, decided ONCE when `/me` first
 * loads — not a live leash re-checked every render. The admin path has
 * start-chat AFTER create-agent, and creating the agent flips
 * `currentOrgHasPersonalAgent` true (the flow's own `refreshMe` surfaces it the
 * moment the agent comes online). A
 * per-render check therefore ejected an actively-onboarding user the instant
 * they made their agent, skipping those steps. Freezing the decision at entry
 * lets them finish; they leave via the explicit `completeAndEnterChat`
 * navigate at the end of start-chat (or `finishLater`).
 *
 * The ref freeze only protects the current component instance, so a full page
 * reload recomputes from `/me`. The membership completion stamp is therefore
 * the terminal gate: it stays null between create-agent and start-chat, while
 * Team-agent quick start writes only a resumable suppressor; optional external
 * Context access does not write onboarding completion.
 */
export function OnboardingPage() {
  const { meLoaded, role, onboardingStep, onboardingDismissedAt, onboardingCompletedAt, currentOrgHasPersonalAgent } =
    useAuth();
  const leaveDecision = useRef<boolean | null>(null);

  if (!meLoaded) {
    return <div className="min-h-screen bg-background" />;
  }
  // A confirmed Member never enters the legacy invitee wizard: they go to the
  // existing Team page. The invitee path below remains only for the
  // unresolved-role recovery state and the explicit onboarding preview.
  if (role === "member") {
    return <Navigate to="/team" replace />;
  }
  if (leaveDecision.current === null) {
    leaveDecision.current = shouldLeaveOnboarding({
      meLoaded,
      onboardingStep,
      onboardingSuppressedAt: onboardingDismissedAt,
      currentOrgHasPersonalAgent,
      onboardingCompletedAt,
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
    case "create-team":
      return <StepTeam />;
    case "connect-computer":
      return <StepConnectComputer />;
    case "create-agent":
      return <StepCreateAgent />;
    case "start-chat":
      return <StepStartChat />;
    case "get-started":
      return <StepGetStarted />;
    default:
      return null;
  }
}
