import { useEffect, useState } from "react";
import { Navigate } from "react-router";
import { useAuth } from "../../auth/auth-context.js";
import { Button } from "../../components/ui/button.js";
import { BuildTreeShell } from "./build-tree-shell.js";
import { OnboardingFlowProvider, useOnboardingFlow } from "./onboarding-flow.js";
import { BuildTreeAgentPanel } from "./steps/build-tree-agent-panel.js";
import { StepConnectCode } from "./steps/step-connect-code.js";
import { StepKickoff } from "./steps/step-kickoff.js";
import { useNeedsTreeSetup } from "./use-needs-tree-setup.js";

/**
 * Standalone "build your Context Tree" recovery surface at `/build-tree`.
 *
 * For the admin who finished onboarding without ever connecting code (so the
 * skipped kickoff never provisioned a tree). It reuses the onboarding provider
 * and the `connect-code` → `kickoff` step components — they already register
 * source repos, ensure the Context Tree binding for the tree setup lane, and
 * send the resilient tree setup kickoff — under recovery chrome. See
 * docs/superpowers/specs/2026-06-10-build-tree-recovery-design.md.
 *
 * It does NOT reuse the `/onboarding` route: that route bounces any user whose
 * org already has a usable agent (`shouldLeaveOnboarding`), which a completed
 * admin does — so recovery needs its own surface, gated on tree-absence instead.
 */
export function BuildTreePage() {
  const { meLoaded } = useAuth();
  const { needsTreeSetup, isLoading, isError, refetch } = useNeedsTreeSetup();

  if (!meLoaded || isLoading) {
    return <div className="min-h-screen bg-background" />;
  }
  // The binding probe failed — the answer is indeterminate. Do NOT bounce to the
  // workspace (a transient blip would silently kick an eligible admin out and
  // the entry points would just send them back). Offer a retry instead.
  if (isError) {
    return (
      <div
        className="flex h-screen flex-col items-center justify-center bg-background"
        style={{ gap: "var(--sp-3)", padding: "var(--sp-5)", textAlign: "center" }}
      >
        <p className="text-body" style={{ color: "var(--fg-2)" }}>
          Couldn't check your team's setup. Try again in a moment.
        </p>
        <Button type="button" variant="outline" size="sm" onClick={refetch}>
          Try again
        </Button>
      </div>
    );
  }
  // Nothing to recover (member, still onboarding, or the tree already exists) →
  // back to the workspace. Also covers the post-build moment if the user lands
  // here again after the binding was created.
  if (!needsTreeSetup) {
    return <Navigate to="/" replace />;
  }

  return (
    <OnboardingFlowProvider path="admin">
      <BuildTreeShell>
        <BuildTreeBody />
      </BuildTreeShell>
    </OnboardingFlowProvider>
  );
}

function BuildTreeBody() {
  const { activeStep, goTo, sequence } = useOnboardingFlow();

  // Pin to connect-code on mount. The provider infers connect-code for a
  // completed admin, but a stale persisted step (a prior onboarding in this
  // tab) could push the initial index to kickoff. Gate rendering on `pinned`
  // so the first frame is never the wrong step.
  const [pinned, setPinned] = useState(false);
  useEffect(() => {
    const idx = sequence.indexOf("connect-code");
    if (idx >= 0) goTo(idx);
    setPinned(true);
  }, [goTo, sequence]);

  // The agent picker reports whether the org has a usable agent; disable
  // "Build tree & start" until it does, so a no-agent org can't click into a
  // "No agent found" error. Starts false (disabled while the picker loads).
  const [agentReady, setAgentReady] = useState(false);

  if (!pinned) return null;

  switch (activeStep) {
    case "connect-code":
      // Recovery requires a repo to proceed (no skip) — the tree can't be built
      // without source repos to seed from.
      return <StepConnectCode recovery />;
    case "kickoff":
      // The agent picker lives on THIS step — "who builds the tree" is a build
      // decision, rendered next to "Start building", not on the connect-code step.
      return (
        <StepKickoff
          recovery
          agentPicker={<BuildTreeAgentPanel onReady={setAgentReady} />}
          buildDisabled={!agentReady}
        />
      );
    default:
      return null;
  }
}
