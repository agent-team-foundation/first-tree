import { Check } from "lucide-react";
import { Navigate, useNavigate } from "react-router";
import { useAuth } from "../../auth/auth-context.js";
import { Button } from "../../components/ui/button.js";
import { PageHeader } from "../../components/ui/page-header.js";
import { Section } from "../../components/ui/section.js";

/**
 * Settings → Onboarding. Surfaces the onboarding stepper's enable/disable
 * state so users can come back to the guided setup after dismissing it
 * (or vice versa). The stepper itself is reversible via PATCH
 * `/me/onboarding`; this is the UI affordance that exposes that.
 *
 * Design rationale: dismissing onboarding from the workspace stepper is
 * cheap (one click), and without a recovery path it becomes a hostile
 * one-way action. This page is the recovery path.
 */
export function SettingsOnboardingPage() {
  const navigate = useNavigate();
  const { onboardingStep, onboardingDismissedAt, onboardingCompletedAt, dismissOnboarding, restoreOnboarding } =
    useAuth();
  // Terminal state — Step 3 was completed. The wizard is one-shot;
  // subsequent config edits go through Settings → Team and /agents/:uuid.
  // Sidebar entry is also hidden, but a direct URL would still reach this
  // page without the guard.
  if (onboardingCompletedAt) {
    return <Navigate to="/settings/team" replace />;
  }
  const isDismissed = !!onboardingDismissedAt;

  // Mirror the stepper `✕` gate exactly — only `completed` (i.e. has at
  // least one client + one non-human managed agent) lets you hide. Letting
  // a `create_agent`-state user dismiss from here but not from the stepper
  // itself is the kind of asymmetric affordance that makes UI feel buggy.
  const canHide = onboardingStep === "completed";

  const handleResume = async (): Promise<void> => {
    await restoreOnboarding();
    navigate("/onboarding");
  };

  return (
    <>
      <PageHeader title="Setup" subtitle="Finish or revisit your setup" />
      <div style={{ padding: "var(--sp-2) var(--sp-5) var(--sp-7)" }}>
        <Section
          title="Guided setup"
          description={
            isDismissed
              ? "Setup is hidden. Resume it to finish connecting your AI teammate and your team's knowledge base."
              : "You can hide the guided setup any time once your AI teammate is ready."
          }
          action={isDismissed ? null : <ActiveBadge />}
        >
          {isDismissed ? (
            <Button type="button" size="sm" onClick={() => void handleResume()}>
              Resume setup
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void dismissOnboarding()}
              disabled={!canHide}
              title={canHide ? undefined : "Finish setting up your AI teammate first"}
            >
              Hide setup guide
            </Button>
          )}
        </Section>
      </div>
    </>
  );
}

function ActiveBadge() {
  return (
    <span
      className="text-label inline-flex items-center"
      style={{
        gap: "var(--sp-1)",
        color: "color-mix(in oklch, var(--accent) 35%, var(--fg))",
      }}
    >
      <Check className="h-3 w-3" />
      Active
    </span>
  );
}
