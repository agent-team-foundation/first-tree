import { useOnboardingFlow } from "./onboarding-flow.js";
import { resolveStepProgress } from "./steps.js";

/**
 * Top-anchored progress for the onboarding content column: a thin segmented
 * line (one segment per journey step) over a quiet "Step N of M" meta. The step
 * name isn't repeated here — the page title right below already states it.
 * Replaces the old left rail — at 4 journey steps a full-height vertical rail
 * read half-empty and stole horizontal space, fighting the "lighter, less
 * pressure" goal. This lives inside the content column instead, so the layout
 * is a single centered column at every width (no desktop-rail / narrow-eyebrow
 * split) and the page reads lighter.
 *
 * Three segment states pull apart so the line reads as *progress*, not a
 * decorative divider (the one risk flagged for this treatment):
 *   - done    → muted primary (reached, behind you)
 *   - active  → full-strength primary (where you are — the one that pops)
 *   - todo    → faint track (ahead)
 *
 * Includes the opening and start-chat screens so the visible route matches the
 * canonical onboarding path.
 */
export function StepProgress() {
  const { path, activeStep } = useOnboardingFlow();
  const progress = resolveStepProgress(path, activeStep);
  if (!progress) return null;

  const { index, total } = progress;

  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-2_5)", marginBottom: "var(--sp-5)" }}>
      <div className="flex" style={{ gap: "var(--sp-1_5)" }} aria-hidden="true">
        {Array.from({ length: total }, (_, i) => {
          const state = i < index ? "done" : i === index ? "active" : "todo";
          return (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional and stable per render
              key={i}
              style={{
                height: "var(--sp-0_75)",
                flex: 1,
                borderRadius: "var(--radius-full)",
                background:
                  state === "active"
                    ? "var(--primary)"
                    : state === "done"
                      ? "color-mix(in oklch, var(--primary) 55%, var(--bg))"
                      : "var(--border)",
              }}
            />
          );
        })}
      </div>
      <p
        className="text-eyebrow"
        role="status"
        aria-live="polite"
        style={{ margin: 0, color: "var(--fg-4)", textTransform: "uppercase" }}
      >
        Step {index + 1} of {total}
      </p>
    </div>
  );
}
