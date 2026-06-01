import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/utils.js";

type FilterPillProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  active?: boolean;
  count?: ReactNode;
  warn?: boolean;
};

export function FilterPill({ active, count, warn, className, children, style, ...rest }: FilterPillProps) {
  return (
    <button
      type="button"
      className={cn(
        // Bordered control: focus deepens its own border to --ring (single
        // line, per DESIGN.md §13) instead of adding an offset ring outside the
        // resting border. Border *color* lives here so `focus-visible:border-ring`
        // can win; width/style stay inline (hairline) to preserve the look.
        "mono inline-flex items-center gap-1 text-caption leading-[1.6] focus-visible:outline-none focus-visible:border-ring",
        active ? "border-border-strong" : "border-border",
        className,
      )}
      style={{
        padding: "var(--sp-0_5) var(--sp-1_75)",
        borderRadius: 3,
        borderWidth: "var(--hairline)",
        borderStyle: "solid",
        background: active ? "var(--bg-active)" : "transparent",
        color: active ? "var(--fg)" : "var(--fg-3)",
        cursor: "pointer",
        ...style,
      }}
      {...rest}
    >
      {children}
      {count !== undefined && (
        <span
          className="mono"
          style={{
            color: warn && typeof count === "number" && count > 0 ? "var(--state-error)" : "var(--fg-4)",
          }}
        >
          {count}
        </span>
      )}
    </button>
  );
}
