import { Check } from "lucide-react";
import { STEP_COPY } from "./copy.js";
import { useOnboardingFlow } from "./onboarding-flow.js";
import { stepVisualState } from "./steps.js";

/**
 * Vertical progress rail down the left of the onboarding shell. Shows every
 * step, the one you're on, and the ones you've finished. Finished steps are
 * clickable so the user can step back to review or change an answer; future
 * steps are inert (no skipping ahead).
 */
export function ProgressRail() {
  const { sequence, activeIndex, goTo } = useOnboardingFlow();

  return (
    <ol className="flex flex-col" style={{ gap: 0, margin: 0, padding: 0, listStyle: "none" }}>
      {sequence.map((id, index) => {
        const state = stepVisualState(index, activeIndex);
        const copy = STEP_COPY[id];
        const isLast = index === sequence.length - 1;
        const clickable = state === "complete";
        return (
          <li key={id} className="flex" style={{ gap: "var(--sp-3)" }}>
            {/* circle + connector column */}
            <div className="flex flex-col items-center" style={{ width: "var(--sp-5)" }}>
              <span
                aria-hidden="true"
                className="mono text-caption inline-flex items-center justify-center"
                style={{
                  width: "var(--sp-5)",
                  height: "var(--sp-5)",
                  flexShrink: 0,
                  borderRadius: 999,
                  background: state === "pending" ? "var(--bg)" : "color-mix(in oklch, var(--accent) 10%, var(--bg))",
                  border:
                    state === "pending"
                      ? "var(--hairline) solid var(--border-faint)"
                      : `var(--hairline) solid var(--accent)`,
                  color: state === "pending" ? "var(--fg-4)" : "var(--accent)",
                  fontWeight: state === "active" ? 600 : 400,
                }}
              >
                {state === "complete" ? <Check className="h-3 w-3" /> : index + 1}
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
                        ? "var(--accent)"
                        : "color-mix(in oklch, var(--border-faint) 60%, transparent)",
                  }}
                />
              )}
            </div>

            {/* label */}
            <div style={{ paddingBottom: "var(--sp-4)", paddingTop: "var(--sp-0_5)" }}>
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
                  {copy.label}
                </button>
              ) : (
                <span
                  className="text-label"
                  style={{
                    color: state === "active" ? "var(--fg)" : "var(--fg-4)",
                    fontWeight: state === "active" ? 600 : 400,
                  }}
                >
                  {copy.label}
                </span>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
