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
      className={cn("flex items-baseline gap-3 shrink-0", className)}
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
