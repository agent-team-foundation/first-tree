import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/utils.js";

type PageHeaderProps = HTMLAttributes<HTMLDivElement> & {
  title: ReactNode;
  subtitle?: ReactNode;
  right?: ReactNode;
};

/**
 * Flat page header. No background fill, no border-bottom — separation comes
 * from spacing and from the relative weight of the title vs the body below.
 * The optional `right` slot stays right-aligned for primary actions.
 */
export function PageHeader({ title, subtitle, right, className, style, ...rest }: PageHeaderProps) {
  return (
    <div
      // `flex-wrap` only changes anything when the title + subtitle + action
      // slot can't share one line (narrow phones with a long title and a
      // right-side button); on desktop it's a no-op. The action slot drops
      // to the next line instead of colliding with the title.
      className={cn("flex flex-wrap items-baseline gap-3 shrink-0", className)}
      style={{
        padding: "var(--sp-4) var(--sp-5) var(--sp-3)",
        ...style,
      }}
      {...rest}
    >
      <h1 className="m-0 text-subtitle" style={{ color: "var(--fg)" }}>
        {title}
      </h1>
      {subtitle && (
        <span className="text-label" style={{ color: "var(--fg-3)" }}>
          {subtitle}
        </span>
      )}
      <div style={{ flex: 1 }} />
      {right}
    </div>
  );
}
