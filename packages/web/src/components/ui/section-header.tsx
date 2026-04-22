import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/utils.js";

type SectionHeaderProps = HTMLAttributes<HTMLDivElement> & {
  children: ReactNode;
  right?: ReactNode;
};

export function SectionHeader({ children, right, className, style, ...rest }: SectionHeaderProps) {
  return (
    <div
      className={cn("mono flex items-center justify-between uppercase", className)}
      style={{
        padding: "7px 14px",
        fontSize: 9,
        letterSpacing: "0.12em",
        color: "var(--fg-4)",
        background: "var(--bg-raised)",
        borderBottom: "1px solid var(--border-faint)",
        ...style,
      }}
      {...rest}
    >
      <span>{children}</span>
      {right}
    </div>
  );
}

export function UppercaseLabel({ className, style, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn("mono uppercase", className)}
      style={{
        fontSize: 10,
        letterSpacing: "0.08em",
        color: "var(--fg-3)",
        ...style,
      }}
      {...rest}
    />
  );
}
