import type { ReactNode } from "react";

/**
 * Section header for flat layouts. Reads as a real H2: title in
 * `text-subtitle` mixed case at full strength, count drifts to the right
 * in a quieter `fg-3` so it sits beside the title without competing.
 * Optional `right` slot (typically a subtle ghost action button).
 *
 * No background fill, no border line — vertical rhythm comes from generous
 * padding above and below the bar.
 */
export function FlatSectionHeader({
  children,
  count,
  right,
}: {
  children: ReactNode;
  count?: number;
  right?: ReactNode;
}) {
  return (
    <div
      className="flex items-baseline justify-between"
      style={{
        padding: "var(--sp-1) var(--sp-1) var(--sp-2)",
      }}
    >
      <div className="flex items-baseline" style={{ gap: "var(--sp-2)" }}>
        <h2 className="m-0 text-subtitle" style={{ color: "var(--fg)" }}>
          {children}
        </h2>
        {count !== undefined && (
          <span className="text-label" style={{ color: "var(--fg-4)" }}>
            {count}
          </span>
        )}
      </div>
      {right}
    </div>
  );
}
