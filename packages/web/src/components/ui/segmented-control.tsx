import type { ReactNode } from "react";
import { cn } from "../../lib/utils.js";

type SegmentedOption<T extends string> = { value: T; label: ReactNode };

type SegmentedControlProps<T extends string> = {
  options: ReadonlyArray<SegmentedOption<T>>;
  value: T;
  onChange: (next: T) => void;
  className?: string;
};

/**
 * SegmentedControl — N-way mutually exclusive toggle for scope-like
 * choices. Visually distinct from `FilterPill` (which is a standalone
 * chip) by being a connected strip with shared borders, conveying
 * "one of N" semantics natively. Used in the workspace rail for the
 * Active/Archived/All scope so it reads as a clearly different
 * dimension from the multi-select origin pills/popover.
 *
 * Each segment is a button with `aria-pressed`. We deliberately do NOT
 * use `role="radio"`/`role="group"` because biome's `useSemanticElements`
 * would push us toward a `<fieldset>` + `<input type=radio>` form
 * pattern that adds zero a11y for an in-page view toggle.
 */
export function SegmentedControl<T extends string>({ options, value, onChange, className }: SegmentedControlProps<T>) {
  return (
    <div
      className={cn("inline-flex items-stretch", className)}
      style={{
        // `alignSelf: flex-start` prevents the parent flex column from
        // stretching the control to fill the column width. Without it
        // the last segment swallows all leftover space and the strip
        // looks lopsided.
        alignSelf: "flex-start",
        borderRadius: 4,
        border: "var(--hairline) solid var(--border)",
        background: "var(--bg-raised)",
        overflow: "hidden",
      }}
    >
      {options.map((opt, i) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            aria-pressed={active}
            onClick={() => {
              if (!active) onChange(opt.value);
            }}
            className="mono text-caption leading-[1.6]"
            style={{
              // `flex: 1 1 0` + `textAlign: center` makes every segment
              // share the strip width equally, so the active state is a
              // uniform rectangle regardless of label length.
              flex: "1 1 0",
              textAlign: "center",
              padding: "var(--sp-0_5) var(--sp-2)",
              border: 0,
              borderLeft: i === 0 ? undefined : "var(--hairline) solid var(--border)",
              background: active ? "var(--bg-active)" : "transparent",
              color: active ? "var(--fg)" : "var(--fg-3)",
              cursor: active ? "default" : "pointer",
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
