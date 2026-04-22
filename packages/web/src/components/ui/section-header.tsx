import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/utils.js";

type SectionHeaderProps = HTMLAttributes<HTMLDivElement> & {
  children: ReactNode;
  right?: ReactNode;
};

export function SectionHeader({ children, right, className, style, ...rest }: SectionHeaderProps) {
  return (
    <div
      className={cn(
        // `text-eyebrow` bundles size/weight/letter-spacing/line-height.
        // Size was bumped from var(--sp-2_25) to var(--sp-2_5) in the unified scale — Windows
        // ClearType can't render var(--sp-2_25) text cleanly at 125% DPI.
        "mono flex items-center justify-between uppercase text-eyebrow",
        className,
      )}
      style={{
        padding: "var(--sp-1_75) var(--sp-3_5)",
        color: "var(--fg-4)",
        background: "var(--bg-raised)",
        borderBottom: "var(--hairline) solid var(--border-faint)",
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
      className={cn("mono uppercase text-caption", className)}
      style={{ color: "var(--fg-3)", ...style }}
      {...rest}
    />
  );
}
