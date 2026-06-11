import type { ReactNode } from "react";
import { useNavigate } from "react-router";
import { useAuth } from "../../auth/auth-context.js";
import { FirstTreeLogo } from "../../components/first-tree-logo.js";
import { Button } from "../../components/ui/button.js";
import { COPY, STEP_COPY } from "./copy.js";
import { useOnboardingFlow } from "./onboarding-flow.js";

/**
 * Chrome for the standalone "build your Context Tree" recovery surface.
 *
 * Deliberately NOT `OnboardingShell`: this is a short, focused task for a user
 * who already finished onboarding, not the first-run wizard. So it drops the
 * 3-step `StepProgress` rail (the recovery is two adjacent steps, and a "Step 3
 * of 3" indicator would read as a regression), and replaces "I'll finish later"
 * with a plain "Back to workspace" (their workspace already exists). The
 * "Finish setup" eyebrow keeps the continuity framing — finishing the one thing
 * they skipped — without re-opening the wizard.
 *
 * Layout mirrors `OnboardingShell` (single centered column, fixed top anchor)
 * so the reused step components render identically; only the chrome differs.
 */
export function BuildTreeShell({ children }: { children: ReactNode }) {
  const { activeStep } = useOnboardingFlow();
  const { logout } = useAuth();
  const navigate = useNavigate();
  const copy = STEP_COPY[activeStep];

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      <header className="flex items-center justify-between" style={{ padding: "var(--sp-4) var(--sp-5)" }}>
        <span className="inline-flex items-center" style={{ gap: "var(--sp-2)", color: "var(--fg)" }}>
          <FirstTreeLogo width={22} height={25} />
          <span className="text-label font-semibold">{COPY.productName}</span>
        </span>
        <div className="inline-flex items-center" style={{ gap: "var(--sp-4)" }}>
          <Button type="button" variant="link" className="h-auto p-0 text-label" onClick={() => navigate("/")}>
            Back to workspace
          </Button>
          <Button type="button" variant="link" className="h-auto p-0 text-label" onClick={logout}>
            Sign out
          </Button>
        </div>
      </header>

      <div
        className="flex-1 min-h-0 flex flex-col items-center"
        style={{
          overflowY: "auto",
          // COUPLED (same as onboarding-shell.tsx): this 6rem top-anchor is tuned
          // to the repo picker's `calc(100vh - 33rem)` fill cap in flow-ui.tsx.
          // The recovery connect-code step reuses that picker, so if you change
          // this, re-tune that cap too (and the copy in onboarding-shell.tsx).
          paddingTop: "6rem",
          paddingBottom: "var(--sp-8)",
          paddingInline: "var(--sp-5)",
        }}
      >
        <main
          className="min-w-0"
          style={{
            width: "34rem",
            maxWidth: "100%",
            flexShrink: 0,
            display: "flex",
            flexDirection: "column",
            minHeight: 0,
          }}
        >
          <div key={activeStep} className="onboarding-shell-step fade-in">
            {/* One constant title for the whole surface — the per-step kickoff
                heading is suppressed (StepKickoff `recovery`) so this carries
                both steps; connect-code keeps its own action line as a subtitle. */}
            <h1 className="text-title font-semibold" style={{ margin: "0 0 var(--sp-3)", color: "var(--fg)" }}>
              {COPY.buildTree.title}
            </h1>
            {copy.title ? (
              <p className="text-subtitle font-medium" style={{ margin: "0 0 var(--sp-2_5)", color: "var(--fg-2)" }}>
                {copy.title}
              </p>
            ) : null}
            {copy.why ? (
              <p className="text-body" style={{ margin: "0 0 var(--sp-6)", color: "var(--fg-3)" }}>
                {copy.why}
              </p>
            ) : null}
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
