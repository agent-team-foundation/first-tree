import { Check } from "lucide-react";
import { useAuth } from "../../auth/auth-context.js";
import { Button } from "../../components/ui/button.js";
import { PageHeader } from "../../components/ui/page-header.js";

/**
 * Settings → Setup. Surfaces the onboarding stepper's enable/disable
 * state so users can come back to the guided setup after dismissing it
 * (or vice versa). The stepper itself is reversible via PATCH
 * `/me/onboarding`; this is the UI affordance that exposes that.
 *
 * Design rationale: dismissing onboarding from the workspace stepper is
 * cheap (one click), and without a recovery path it becomes a hostile
 * one-way action. This page is the recovery path.
 */
export function SettingsSetupPage() {
  const { onboardingStep, onboardingDismissedAt, dismissOnboarding, restoreOnboarding } = useAuth();
  const isDismissed = !!onboardingDismissedAt;

  // Mirror the stepper `✕` gate exactly — only `completed` (i.e. has at
  // least one client + one non-human managed agent) lets you hide. Letting
  // a `create_agent`-state user dismiss from here but not from the stepper
  // itself is the kind of asymmetric affordance that makes UI feel buggy.
  const canHide = onboardingStep === "completed";

  return (
    <div>
      <PageHeader title="Setup" subtitle="Onboarding guide controls" />
      <div style={{ padding: "var(--sp-4) var(--sp-5) var(--sp-7)", maxWidth: 640 }}>
        <div
          style={{
            padding: "var(--sp-4)",
            background: "var(--surface-1)",
            border: "var(--hairline) solid var(--border-faint)",
            borderRadius: "var(--radius-input)",
          }}
        >
          <div className="flex items-baseline" style={{ gap: "var(--sp-2)", marginBottom: "var(--sp-1)" }}>
            <h2 className="text-subtitle font-semibold" style={{ margin: 0, color: "var(--fg)" }}>
              Setup guide
            </h2>
            {isDismissed ? null : (
              <span
                className="text-label"
                style={{
                  color: "color-mix(in oklch, var(--accent) 30%, var(--fg))",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "var(--sp-1)",
                }}
              >
                <Check className="h-3 w-3" />
                Active
              </span>
            )}
          </div>
          <p className="text-body" style={{ margin: 0, color: "var(--fg-3)" }}>
            {isDismissed
              ? "The onboarding stepper is hidden. Bring it back if you want to walk through Step 3 (build your context-tree)."
              : "The onboarding stepper is shown above your workspace. You can hide it any time once your agent is set up."}
          </p>

          <div style={{ marginTop: "var(--sp-4)" }}>
            {isDismissed ? (
              <Button type="button" onClick={() => void restoreOnboarding()}>
                Resume setup
              </Button>
            ) : (
              <Button
                type="button"
                variant="outline"
                onClick={() => void dismissOnboarding()}
                disabled={!canHide}
                title={canHide ? undefined : "Finish setting up your agent first"}
              >
                Hide setup guide
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
