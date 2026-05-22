import type { ReactNode } from "react";
import { useAuth } from "../../auth/auth-context.js";
import { FirstTreeLogo } from "../../components/first-tree-logo.js";
import { COPY, STEP_COPY } from "./copy.js";
import { OutcomeList } from "./flow-ui.js";
import { useOnboardingFlow } from "./onboarding-flow.js";

/**
 * Full-screen onboarding chrome. Three regions:
 *   - left: the progress rail (which step you're on)
 *   - center: the active step — heading, one-line "why", and the form
 *   - right: "what you'll have" once this step is done, plus reassurance
 *
 * The center is the only thing that matters on a phone; the rail and the
 * outcomes panel are progressive enhancement on wider screens. A compact
 * "Step X of N" line keeps orientation on small screens where the rail is
 * hidden.
 */
export function OnboardingShell({ rail, children }: { rail: ReactNode; children: ReactNode }) {
  const { activeStep, activeIndex, sequence, finishLater, hasAgent } = useOnboardingFlow();
  const { logout } = useAuth();
  const copy = STEP_COPY[activeStep];

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="flex items-center justify-between" style={{ padding: "var(--sp-4) var(--sp-5)" }}>
        <span className="inline-flex items-center" style={{ gap: "var(--sp-2)", color: "var(--fg)" }}>
          <FirstTreeLogo width={22} height={25} />
          <span className="text-label font-semibold">{COPY.productName}</span>
        </span>
        <div className="inline-flex items-center" style={{ gap: "var(--sp-4)" }}>
          {/* "Finish later" only once a teammate exists — before that the
              workspace is empty, so leaving is a dead end. Sign out is always
              available so a user who can't finish right now isn't locked out
              of their account. */}
          {hasAgent && (
            <button
              type="button"
              onClick={() => void finishLater()}
              className="text-label"
              style={{ background: "transparent", border: 0, cursor: "pointer", color: "var(--fg-4)" }}
            >
              {COPY.finishLater}
            </button>
          )}
          <button
            type="button"
            onClick={logout}
            className="text-label"
            style={{ background: "transparent", border: 0, cursor: "pointer", color: "var(--fg-4)" }}
          >
            Sign out
          </button>
        </div>
      </header>

      {/* The band is vertically centered in the remaining height (margin:auto
          in a flex column) so short steps don't cling to the top with a big
          empty lower half; `overflow-y:auto` keeps tall steps scrollable. */}
      <div
        className="flex-1 flex flex-col"
        style={{ overflowY: "auto", padding: "var(--sp-6) var(--sp-5) var(--sp-10)" }}
      >
        <div
          className="flex flex-col lg:flex-row"
          style={{ width: "100%", maxWidth: "68rem", margin: "auto", gap: "var(--sp-8)" }}
        >
          {/* left rail (desktop) */}
          <aside className="hidden lg:block" style={{ width: "12rem", flexShrink: 0, paddingTop: "var(--sp-1)" }}>
            {rail}
          </aside>

          {/* center content */}
          <main className="flex-1 min-w-0" style={{ maxWidth: "34rem" }}>
            <div key={activeStep} className="onboarding-shell-step fade-in">
              <p
                className="text-eyebrow lg:hidden"
                style={{ margin: "0 0 var(--sp-2)", color: "var(--fg-4)", textTransform: "uppercase" }}
              >
                Step {activeIndex + 1} of {sequence.length}
              </p>
              <p className="text-eyebrow" style={{ margin: 0, color: "var(--accent)", textTransform: "uppercase" }}>
                {COPY.flowEyebrow}
              </p>
              <h1
                className="text-title font-semibold"
                style={{ margin: "var(--sp-2) 0 var(--sp-2_5)", color: "var(--fg)" }}
              >
                {copy.title}
              </h1>
              <p className="text-body" style={{ margin: "0 0 var(--sp-6)", color: "var(--fg-3)" }}>
                {copy.why}
              </p>
              {children}

              {/* On narrow screens the side panel is hidden — keep the "what
                  you'll have" reassurance inline so phone users don't lose it. */}
              <div
                className="xl:hidden"
                style={{
                  marginTop: "var(--sp-6)",
                  paddingTop: "var(--sp-4)",
                  borderTop: "var(--hairline) solid var(--border-faint)",
                }}
              >
                <p className="text-label font-semibold" style={{ margin: "0 0 var(--sp-3)", color: "var(--fg-2)" }}>
                  What you'll have
                </p>
                <OutcomeList items={copy.outcomes} />
              </div>
            </div>
          </main>

          {/* right outcomes panel (wide screens) */}
          <aside className="hidden xl:block" style={{ width: "16rem", flexShrink: 0, paddingTop: "var(--sp-6)" }}>
            <div
              style={{
                padding: "var(--sp-4)",
                borderRadius: "var(--radius-card, var(--radius-input))",
                background: "color-mix(in oklch, var(--bg-raised) 40%, transparent)",
                border: "var(--hairline) solid var(--border-faint)",
              }}
            >
              <p className="text-label font-semibold" style={{ margin: "0 0 var(--sp-3)", color: "var(--fg-2)" }}>
                What you'll have
              </p>
              <OutcomeList items={copy.outcomes} />
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
