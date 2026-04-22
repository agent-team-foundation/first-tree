import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/utils.js";

// Workspace-style underline tab bar.
//
// Usage:
//   <TabBar>
//     <Tab active>Members<TabBadge>5</TabBadge></Tab>
//     <Tab>All agents<TabBadge>12</TabBadge></Tab>
//   </TabBar>

type TabBarProps = HTMLAttributes<HTMLDivElement>;

export function TabBar({ className, style, ...rest }: TabBarProps) {
  return (
    <div
      className={cn("flex items-end", className)}
      style={{
        gap: 2,
        height: 34,
        padding: "0 20px",
        borderBottom: "1px solid var(--border)",
        background: "var(--bg-raised)",
        ...style,
      }}
      {...rest}
    />
  );
}

type TabProps = {
  active?: boolean;
  onClick?: () => void;
  children: ReactNode;
};

export function Tab({ active, onClick, children }: TabProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 bg-transparent"
      style={{
        padding: "7px 12px",
        marginBottom: -1,
        borderBottom: `2px solid ${active ? "var(--accent)" : "transparent"}`,
        fontSize: 12,
        fontWeight: 500,
        color: active ? "var(--fg)" : "var(--fg-3)",
        cursor: "pointer",
        transition: "color 0.12s",
      }}
      onMouseEnter={(e) => {
        if (!active) e.currentTarget.style.color = "var(--fg)";
      }}
      onMouseLeave={(e) => {
        if (!active) e.currentTarget.style.color = "var(--fg-3)";
      }}
    >
      {children}
    </button>
  );
}

export function TabBadge({ children }: { children: ReactNode }) {
  return (
    <span className="mono" style={{ fontSize: 10, color: "var(--fg-4)" }}>
      {children}
    </span>
  );
}
