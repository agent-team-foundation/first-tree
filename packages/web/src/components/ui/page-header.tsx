import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/utils.js";

type PageHeaderProps = HTMLAttributes<HTMLDivElement> & {
  title: ReactNode;
  subtitle?: ReactNode;
  right?: ReactNode;
};

export function PageHeader({ title, subtitle, right, className, style, ...rest }: PageHeaderProps) {
  return (
    <div
      className={cn("flex items-baseline gap-3 shrink-0", className)}
      style={{
        padding: "12px 20px 10px",
        borderBottom: "1px solid var(--border-faint)",
        background: "var(--bg-raised)",
        ...style,
      }}
      {...rest}
    >
      <h1
        className="m-0"
        style={{
          fontSize: 16,
          fontWeight: 600,
          letterSpacing: -0.2,
          color: "var(--fg)",
        }}
      >
        {title}
      </h1>
      {subtitle && <span style={{ fontSize: 11.5, color: "var(--fg-3)" }}>{subtitle}</span>}
      <div style={{ flex: 1 }} />
      {right}
    </div>
  );
}
