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
        // Size was bumped from 9px to 10px in the unified scale — Windows
        // ClearType can't render 9px text cleanly at 125% DPI.
        "mono flex items-center justify-between uppercase text-eyebrow",
        className,
      )}
      style={{
        padding: "7px 14px",
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
      className={cn("mono uppercase text-caption", className)}
      style={{ color: "var(--fg-3)", ...style }}
      {...rest}
    />
  );
}
