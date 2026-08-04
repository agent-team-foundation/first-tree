import { useState } from "react";
import {
  ONBOARDING_ORIENTATION_CONTINUE_MESSAGE,
  OnboardingOrientation,
} from "../components/chat/onboarding-orientation.js";
import { Button } from "../components/ui/button.js";

/** DEV-only visual review surface for the real inline first-chat Orientation. */
export function OnboardingOrientationPreviewPage() {
  const [completed, setCompleted] = useState(false);

  return (
    <main className="min-h-screen bg-background p-4 sm:p-8">
      <div className="mx-auto max-w-3xl">
        <header className="mb-6 flex flex-wrap items-end justify-between" style={{ gap: "var(--sp-3)" }}>
          <div>
            <p className="mono text-caption text-muted-foreground">DEV PREVIEW · REAL COMPONENT</p>
            <h1 className="text-title font-semibold">First-chat Orientation</h1>
            <p className="text-body text-muted-foreground">
              Resize to a narrow phone width to review the mobile layout.
            </p>
          </div>
          <div className="flex" style={{ gap: "var(--sp-2)" }}>
            <Button type="button" variant={!completed ? "default" : "outline"} onClick={() => setCompleted(false)}>
              Pending
            </Button>
            <Button type="button" variant={completed ? "default" : "outline"} onClick={() => setCompleted(true)}>
              Completed
            </Button>
          </div>
        </header>

        <section aria-label="First chat message preview" className="border-y border-border py-4">
          <div className="grid" style={{ gridTemplateColumns: "var(--sp-5) 1fr", gap: "var(--sp-2)" }}>
            <span
              aria-hidden="true"
              className="flex size-5 items-center justify-center rounded-full bg-secondary text-caption font-semibold"
            >
              G
            </span>
            <div className="min-w-0">
              <p className="mono text-body font-semibold">Gandy</p>
              <p className="text-body mt-1">
                Nova, welcome aboard.
                <br />
                <br />
                Please help me get started with First Tree.
              </p>
              <OnboardingOrientation
                key={completed ? "completed" : "pending"}
                completed={completed}
                continuing={false}
                onContinue={() => setCompleted(true)}
              />
            </div>
          </div>
          {completed ? (
            <div className="mt-4 flex flex-col border-t border-border pt-4" style={{ gap: "var(--sp-4)" }}>
              <div>
                <p className="mono text-body font-semibold">Gandy</p>
                <p className="text-body mt-1">{ONBOARDING_ORIENTATION_CONTINUE_MESSAGE}</p>
              </div>
              <div>
                <p className="mono text-body font-semibold">Nova</p>
                <p className="text-body mt-1 text-muted-foreground">
                  The existing first-task guidance begins here after the visible continue message wakes the agent.
                </p>
              </div>
            </div>
          ) : null}
        </section>
      </div>
    </main>
  );
}
