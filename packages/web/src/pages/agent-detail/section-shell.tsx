import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/utils.js";

/**
 * Shared layout primitive for top-level anchored sections on the agent detail
 * page. Renders an H2 heading, optional caption, optional right-aligned actions,
 * and a body slot. The section element itself carries the anchor ID so the
 * left-sidebar jump-to scroll lands at the heading rather than the first child.
 */

export type SectionShellProps = {
  /** DOM id used as scroll target by the sidebar anchors. */
  anchorId: string;
  title: string;
  caption?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  /** Extra className on the outer section wrapper. */
  className?: string;
  /** Extra HTML attributes on the outer section. */
  sectionProps?: HTMLAttributes<HTMLElement>;
};

export function SectionShell({
  anchorId,
  title,
  caption,
  right,
  children,
  className,
  sectionProps,
}: SectionShellProps) {
  return (
    <section id={anchorId} className={cn("space-y-3", className)} {...sectionProps}>
      <div className="flex items-end justify-between gap-3">
        <div>
          <h2 className="text-subtitle" style={{ color: "var(--fg)" }}>
            {title}
          </h2>
          {caption && (
            <div className="text-caption" style={{ color: "var(--fg-3)" }}>
              {caption}
            </div>
          )}
        </div>
        {right}
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

/**
 * Visible horizontal divider between two top-level anchored sections. Used
 * mainly to hard-separate the Danger zone from the rest of the page.
 */
export function SectionDivider() {
  return (
    <hr
      aria-hidden
      style={{
        border: 0,
        borderTop: "var(--hairline) solid var(--border)",
        margin: "var(--sp-2) 0",
      }}
    />
  );
}
