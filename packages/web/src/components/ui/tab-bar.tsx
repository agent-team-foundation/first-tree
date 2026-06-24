import { type ButtonHTMLAttributes, forwardRef, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "../../lib/utils.js";

// Workspace-style underline tab bar.
//
// Usage:
//   <TabBar>
//     <Tab active>Members<TabBadge>5</TabBadge></Tab>
//     <Tab>All agents<TabBadge>12</TabBadge></Tab>
//   </TabBar>

type TabBarProps = HTMLAttributes<HTMLDivElement>;

export const TabBar = forwardRef<HTMLDivElement, TabBarProps>(function TabBar({ className, style, ...rest }, ref) {
  return (
    <div
      ref={ref}
      className={cn("flex items-end", className)}
      style={{
        gap: 2,
        // minHeight (not a fixed height) so the bar grows with its content / focus
        // ring. NOTE: the active Tab's marginBottom:-1 makes its border-box one
        // pixel taller than the bar, and a horizontally-scrolling consumer
        // (overflowX:auto) coerces overflow-y to auto → a spurious VERTICAL
        // scrollbar over that extra pixel. minHeight does NOT fix that; the
        // consumer must also set overflowY:hidden
        // (see TabsNav in agent-detail.tsx).
        minHeight: 34,
        padding: "0 var(--sp-5)",
        borderBottom: "var(--hairline) solid var(--border)",
        background: "var(--bg-raised)",
        ...style,
      }}
      {...rest}
    />
  );
});

type TabProps = {
  active?: boolean;
  onClick?: () => void;
  children: ReactNode;
  /** Shows a neutral "unsaved changes" dot after the label. */
  dirty?: boolean;
  className?: string;
} & Pick<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "role" | "aria-selected" | "aria-controls" | "aria-disabled" | "disabled" | "id" | "title"
>;

export function Tab({ active, onClick, children, dirty, className, disabled, ...rest }: TabProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        // No border-radius: the active state is a straight bottom border, and a
        // corner radius would bow its ends upward into little hooks.
        "inline-flex items-center gap-1.5 bg-transparent text-body font-medium focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
        className,
      )}
      style={{
        padding: "var(--sp-1_75) var(--sp-3)",
        marginBottom: -1,
        borderBottom: `var(--hairline-bold) solid ${active ? "var(--primary)" : "transparent"}`,
        color: disabled ? "var(--fg-4)" : active ? "var(--fg)" : "var(--fg-3)",
        cursor: disabled ? "not-allowed" : "pointer",
        transition: "color 0.12s",
      }}
      onMouseEnter={(e) => {
        if (!active && !disabled) e.currentTarget.style.color = "var(--fg)";
      }}
      onMouseLeave={(e) => {
        if (!active && !disabled) e.currentTarget.style.color = "var(--fg-3)";
      }}
      {...rest}
    >
      {children}
      {dirty && <TabDirtyDot />}
    </button>
  );
}

/** Small neutral dot marking a tab whose section has unsaved draft changes. */
export function TabDirtyDot() {
  return (
    <span
      role="img"
      aria-label="unsaved changes"
      style={{
        width: "var(--sp-1_5)",
        height: "var(--sp-1_5)",
        borderRadius: "50%",
        background: "var(--fg-4)",
        flexShrink: 0,
      }}
    />
  );
}

export function TabBadge({ children }: { children: ReactNode }) {
  return (
    <span className="mono text-caption" style={{ color: "var(--fg-4)" }}>
      {children}
    </span>
  );
}
