import { FirstTreeLogo } from "../../../components/first-tree-logo.js";
import { Button } from "../../../components/ui/button.js";
import { useOnboardingState } from "../../../hooks/use-onboarding-state.js";

export function EmptyState() {
  const { step, openModal } = useOnboardingState();
  const onboardingIncomplete = step !== null && step !== "completed";

  if (onboardingIncomplete) {
    const stepLabel =
      step === "connect"
        ? "Connect your computer to create your first agent."
        : step === "create_agent"
          ? "Create your first agent to start collaborating."
          : "Finish setup to start collaborating.";
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="text-center max-w-sm">
          <FirstTreeLogo width={36} height={40} className="mx-auto mb-3 text-primary opacity-60" />
          <div className="text-subtitle mb-1">No agents yet</div>
          <div className="text-body text-muted-foreground mb-4">{stepLabel}</div>
          <Button onClick={openModal}>Resume setup</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex items-center justify-center p-8">
      <div className="text-center max-w-sm">
        <FirstTreeLogo width={36} height={40} className="mx-auto mb-3 text-primary opacity-60" />
        <div className="text-subtitle mb-1">Select a chat</div>
        <div className="text-body text-muted-foreground">
          Pick an agent from the roster to view its sessions, or open a chat to start collaborating.
        </div>
      </div>
    </div>
  );
}
