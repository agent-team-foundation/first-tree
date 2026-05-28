import type { ReactNode } from "react";
import { useNavigate } from "react-router";
import { useAuth } from "../../auth/auth-context.js";
import { FirstTreeLogo } from "../../components/first-tree-logo.js";
import { useToast } from "../../components/ui/toast.js";
import { COPY, STEP_COPY } from "./copy.js";
import { useOnboardingFlow } from "./onboarding-flow.js";

/**
 * Onboarding chrome: a slim top bar (brand + sign out / finish later) over a
 * clean background, then a two-column body — a left rail listing every step
 * (full labels, so the whole journey is visible up front) beside a focused
 * content column. No card/border/shadow; structure comes from the rail + a
 * top-anchored content column (centered horizontally, fixed vertical offset so
 * the rail never jumps between steps). On narrow screens the rail collapses
 * to a "Step N of M" line.
 *
 * Outcomes (the old "What you'll have" footer) were folded into each step's
 * `why` copy — one place for the user to read, less repetition, less density.
 */
export function OnboardingShell({ rail, children }: { rail: ReactNode; children: ReactNode }) {
  const { activeStep, activeIndex, sequence, finishLater, hasAgent } = useOnboardingFlow();
  const { logout } = useAuth();
  const { addToast } = useToast();
  const navigate = useNavigate();
  const copy = STEP_COPY[activeStep];

  return (
    // h-screen + overflow-hidden pins the app to the viewport, so the page can
    // never grow a vertical scrollbar. Long content is bounded by the repo
    // picker's own viewport-relative max-height (it scrolls internally), and the
    // body below has overflow-y:auto only as a last-resort fallback.
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      <header className="flex items-center justify-between" style={{ padding: "var(--sp-4) var(--sp-5)" }}>
        <span className="inline-flex items-center" style={{ gap: "var(--sp-2)", color: "var(--fg)" }}>
          <FirstTreeLogo width={22} height={25} />
          <span className="text-label font-semibold">{COPY.productName}</span>
        </span>
        <div className="inline-flex items-center" style={{ gap: "var(--sp-4)" }}>
          {/* "Finish later" only once a teammate exists — before that the
              workspace is empty, so leaving is a dead end. Sign out is always
              available so a user who can't finish right now isn't locked out. */}
          {hasAgent && (
            <button
              type="button"
              onClick={() => {
                // Tell the user where setup lives before dropping them into the
                // still-incomplete workspace — otherwise "finish later" reads as
                // "lose my progress". Settings → Setup has the Resume path.
                addToast({
                  title: "Setup paused",
                  description: "Pick up where you left off anytime in Settings → Setup.",
                  action: { label: "Open Settings", onClick: () => navigate("/settings/onboarding") },
                });
                void finishLater();
              }}
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

      {/* Body: the rail + content row is top-anchored at a fixed offset
          (paddingTop), so the left rail sits at the SAME vertical position on
          every step — it never jumps as content height changes. Short steps land
          in the upper third; a tall step fills downward from that same top. The
          repo picker's own max-height keeps even the tallest step on one screen.
          Centered horizontally. */}
      <div
        className="flex-1 min-h-0 flex flex-col items-center"
        style={{
          overflowY: "auto",
          // Fixed top-anchor offset for the rail + content. COUPLED: the repo
          // picker's fill cap in flow-ui.tsx (`calc(100vh - 33rem)`) is tuned to
          // this value — if you change it, re-tune that cap too.
          paddingTop: "6rem",
          paddingBottom: "var(--sp-8)",
          paddingInline: "var(--sp-5)",
        }}
      >
        <div className="flex flex-col md:flex-row md:items-start" style={{ gap: "var(--sp-8)", flexShrink: 0 }}>
          {/* Left rail — full step labels, top-aligned with the content. */}
          <aside className="hidden md:block" style={{ width: "13rem", flexShrink: 0, paddingTop: "var(--sp-1)" }}>
            {rail}
          </aside>

          <main
            className="min-w-0"
            style={{
              width: "34rem",
              maxWidth: "100%",
              flexShrink: 1,
              // The repo picker carries its own viewport-relative max-height, so a
              // long list scrolls inside itself and the whole step always fits —
              // no flex-height chain, nothing grows the page into a scrollbar.
              display: "flex",
              flexDirection: "column",
              minHeight: 0,
            }}
          >
            <div key={activeStep} className="onboarding-shell-step fade-in">
              {/* rail is hidden on narrow screens — keep a position cue */}
              <p
                className="text-eyebrow md:hidden"
                style={{ margin: "0 0 var(--sp-2)", color: "var(--fg-4)", textTransform: "uppercase" }}
              >
                Step {activeIndex + 1} of {sequence.length}
              </p>
              {copy.title ? (
                <h1 className="text-title font-semibold" style={{ margin: "0 0 var(--sp-2_5)", color: "var(--fg)" }}>
                  {copy.title}
                </h1>
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
    </div>
  );
}
