import { Check } from "lucide-react";
import { Navigate, useNavigate } from "react-router";
import { useAuth } from "../../auth/auth-context.js";
import { Button } from "../../components/ui/button.js";
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
  // Terminal state — the wizard finished. It's one-shot; subsequent team-name
  // edits go through the header-left TeamSwitcher and agent edits go through
  // /agents/:uuid. Nothing to surface here, so redirect away.
  if (onboardingCompletedAt) {
    return <Navigate to="/settings/computers" replace />;
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

  // Page heading is owned by the Settings layout (see settings.tsx). Setup
  // carries no lead — its old subtitle ("Finish or revisit your setup") just
  // restated the label; the "Guided setup" section says the rest.
  return (
    <div style={{ padding: "var(--sp-4) var(--sp-5) var(--sp-7)" }}>
      <Section
        title="Guided setup"
        description={
          isDismissed
            ? "Setup is hidden. Resume it to finish connecting your agent and your team's Context Tree."
            : "You can hide the guided setup any time once your agent is ready."
        }
        action={isDismissed ? null : <ActiveBadge />}
      >
        {/* Section renders children flush against its top divider; without
              this the button sits on the hairline ("压线"). Scoped here rather
              than in the shared Section (used on 18 surfaces) to keep this PR
              to onboarding — the shared component's flush children is a latent
              issue worth its own styling pass. */}
        <div style={{ paddingTop: "var(--sp-3)" }}>
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
              title={canHide ? undefined : "Finish setting up your agent first"}
            >
              Hide setup guide
            </Button>
          )}
        </div>
      </Section>
    </div>
  );
}

function ActiveBadge() {
  return (
    <span
      className="text-label inline-flex items-center"
      style={{
        gap: "var(--sp-1)",
        color: "var(--fg-confirm)",
      }}
    >
      <Check className="h-3 w-3" />
      Active
    </span>
  );
}
