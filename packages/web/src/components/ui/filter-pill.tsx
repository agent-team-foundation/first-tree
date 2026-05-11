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
      className={cn("mono inline-flex items-center gap-1 text-caption leading-[1.6]", className)}
      style={{
        padding: "var(--sp-0_5) var(--sp-1_75)",
        borderRadius: 3,
        border: `var(--hairline) solid ${active ? "var(--border-strong)" : "var(--border)"}`,
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
