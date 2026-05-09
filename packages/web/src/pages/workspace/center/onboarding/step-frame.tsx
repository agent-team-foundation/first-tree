import { Check } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Shared visuals for the Step 2 / Step 3 stepper rail. Lives outside the
 * per-step body files because both step2-body and step3-intro-body render
 * inside the same vertical rail — extracting here lets either file import
 * without forcing a circular dep through onboarding-view.
 */

export function StepRailLine() {
  return (
    <div
      aria-hidden="true"
      style={{
        position: "absolute",
        top: "var(--sp-5)",
        bottom: "var(--sp-5)",
        left: "calc(var(--sp-2_5) - var(--hairline))",
        width: "var(--hairline)",
        background: "color-mix(in oklch, var(--border-faint) 56%, transparent)",
      }}
    />
  );
}

export function StepFrame({
  number,
  state,
  children,
}: {
  number: string;
  state: "idle" | "active" | "complete";
  children: ReactNode;
}) {
  const isActive = state === "active";
  const isComplete = state === "complete";

  return (
    <section
      className="grid"
      style={{
        gridTemplateColumns: "var(--sp-5) 1fr",
        columnGap: "var(--sp-3)",
        marginTop: number === "01" ? 0 : "var(--sp-5)",
        position: "relative",
      }}
    >
      <div
        className="mono text-caption flex items-center justify-center"
        style={{
          width: "var(--sp-5)",
          height: "var(--sp-5)",
          borderRadius: 999,
          background: isActive || isComplete ? "color-mix(in oklch, var(--accent) 8%, var(--bg))" : "var(--bg)",
          border:
            isActive || isComplete
              ? "var(--hairline) solid var(--accent)"
              : "var(--hairline) solid var(--border-faint)",
          color: isActive || isComplete ? "var(--accent)" : "var(--fg-4)",
          zIndex: 1,
        }}
      >
        {isComplete ? <Check className="h-3 w-3" /> : number}
      </div>
      <div style={{ minHeight: "var(--sp-6)", paddingBottom: "var(--sp-1)" }}>{children}</div>
    </section>
  );
}
