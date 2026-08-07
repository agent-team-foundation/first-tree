import type { ReactNode } from "react";
import { Link } from "react-router";
import { cn } from "../../lib/utils.js";

/**
 * Shared local-navigation item for entity detail and Settings sidebars.
 *
 * The active destination uses one quiet neutral fill and medium label weight;
 * section-specific rails and accent bars would create competing navigation
 * grammars inside the same dashboard.
 */
export function LocalNavLink({
  to,
  label,
  active,
  replace,
  ariaLabel,
  trailing,
}: {
  to: string;
  label: string;
  active: boolean;
  replace?: boolean;
  ariaLabel?: string;
  trailing?: ReactNode;
}) {
  return (
    <Link
      to={to}
      replace={replace}
      aria-current={active ? "page" : undefined}
      aria-label={ariaLabel}
      className={cn(
        "block w-full text-body transition-colors",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1",
      )}
    >
      <span
        className={cn("flex min-h-11 items-center justify-between", active ? "font-medium" : "font-normal")}
        style={{
          padding: "var(--sp-2) var(--sp-3)",
          borderRadius: "var(--radius-input)",
          color: active ? "var(--fg)" : "var(--fg-3)",
          background: active ? "var(--bg-hover)" : "transparent",
        }}
      >
        <span>{label}</span>
        {trailing}
      </span>
    </Link>
  );
}
