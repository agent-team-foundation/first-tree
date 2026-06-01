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
 * SegmentedControl — N-way mutually exclusive picker rendered as a row
 * of ghost text buttons. Active segment lights up with `--bg-active`;
 * inactive segments are bare text and pick up a hover fade. No outer
 * box, no inter-segment dividers — the visual language matches navigation
 * items rather than a data chip strip, which is what we want for the
 * workspace rail's "view mode" controls.
 *
 * Active state is conveyed by background fill alone. Each segment also
 * carries `aria-pressed` so assistive tech announces the selection.
 */
export function SegmentedControl<T extends string>({ options, value, onChange, className }: SegmentedControlProps<T>) {
  return (
    <div
      className={cn("inline-flex items-center", className)}
      style={{
        gap: "var(--sp-0_5)",
      }}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            aria-pressed={active}
            onClick={() => {
              if (!active) onChange(opt.value);
            }}
            className={cn(
              "text-caption cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
              !active && "hover:bg-[var(--bg-hover)]",
            )}
            style={{
              padding: "var(--sp-0_5) var(--sp-1_5)",
              border: 0,
              borderRadius: 4,
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
