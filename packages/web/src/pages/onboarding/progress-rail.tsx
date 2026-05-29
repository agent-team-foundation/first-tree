import { Bot, Check, GitBranch, type LucideIcon, MonitorSmartphone, Rocket, Sparkles, Users } from "lucide-react";
import { resolveStepLabel } from "./copy.js";
import { useOnboardingFlow } from "./onboarding-flow.js";
import { type StepId, stepVisualState } from "./steps.js";

/** Per-step glyphs — warmer + faster to scan than bare numbers. */
const STEP_ICON: Record<StepId, LucideIcon> = {
  team: Users,
  "connect-code": GitBranch,
  "connect-computer": MonitorSmartphone,
  "create-agent": Bot,
  kickoff: Rocket,
  welcome: Sparkles,
};

/**
 * Vertical progress rail down the left of the onboarding shell. Shows every
 * step with its full label (no truncation — vertical space is cheap), the one
 * you're on, and the ones you've finished. Finished steps are clickable to step
 * back; future steps are inert (no skipping ahead) but visible so the whole
 * journey is previewable up front.
 */
export function ProgressRail() {
  const { sequence, activeIndex, goTo, path } = useOnboardingFlow();

  return (
    <ol className="flex flex-col" style={{ gap: 0, margin: 0, padding: 0, listStyle: "none" }}>
      {sequence.map((id, index) => {
        const state = stepVisualState(index, activeIndex);
        const label = resolveStepLabel(id, path);
        const isLast = index === sequence.length - 1;
        const clickable = state === "complete";
        const Icon = STEP_ICON[id];

        return (
          <li key={id} className="flex" style={{ gap: "var(--sp-3)" }}>
            {/* icon disc + connector column */}
            <div className="flex flex-col items-center" style={{ width: "var(--sp-6)" }}>
              <span
                aria-hidden="true"
                className="inline-flex items-center justify-center"
                style={{
                  width: "var(--sp-6)",
                  height: "var(--sp-6)",
                  flexShrink: 0,
                  borderRadius: 999,
                  background:
                    state === "active"
                      ? "var(--primary)"
                      : state === "complete"
                        ? "color-mix(in oklch, var(--primary) 12%, var(--bg))"
                        : "var(--bg)",
                  border:
                    state === "pending"
                      ? "var(--hairline) solid var(--border-faint)"
                      : "var(--hairline) solid var(--primary)",
                  color:
                    state === "active"
                      ? "var(--color-primary-foreground)"
                      : state === "complete"
                        ? "var(--primary)"
                        : "var(--fg-4)",
                }}
              >
                {state === "complete" ? <Check className="h-3.5 w-3.5" /> : <Icon className="h-3.5 w-3.5" />}
              </span>
              {!isLast && (
                <span
                  aria-hidden="true"
                  style={{
                    width: "var(--hairline)",
                    flex: 1,
                    minHeight: "var(--sp-5)",
                    margin: "var(--sp-1) 0",
                    background:
                      state === "complete"
                        ? "var(--primary)"
                        : "color-mix(in oklch, var(--border-faint) 60%, transparent)",
                  }}
                />
              )}
            </div>

            {/* full step label */}
            <div style={{ paddingBottom: isLast ? 0 : "var(--sp-4)", paddingTop: "var(--sp-0_5)", minWidth: 0 }}>
              {clickable ? (
                <button
                  type="button"
                  onClick={() => goTo(index)}
                  className="text-label font-medium"
                  style={{
                    background: "transparent",
                    border: 0,
                    padding: 0,
                    cursor: "pointer",
                    color: "var(--fg-2)",
                    textAlign: "left",
                  }}
                >
                  {label}
                </button>
              ) : (
                <span
                  className="text-label"
                  aria-current={state === "active" ? "step" : undefined}
                  style={{
                    color: state === "active" ? "var(--fg)" : "var(--fg-4)",
                    fontWeight: state === "active" ? 600 : 400,
                  }}
                >
                  {label}
                </span>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
