import type { CSSProperties } from "react";
import { cn } from "../lib/utils.js";

/**
 * Unified agent reference renderer — used wherever one agent references
 * another (delegate column in the list, identity section, delegate
 * dropdown, mention previews). Collapses the three previous ad-hoc
 * renderings into a single component so tweaks only happen once.
 *
 * Display contract (see first-tree-context:agent-hub/agent-naming.md §3.3):
 *   - `displayName` is the primary (human) label.
 *   - `name` is shown as the @-prefixed mention target, in monospace, dim.
 *   - When only one of the two is set, the chip still reads naturally:
 *       • no displayName  → just `@name`
 *       • no name (rare, e.g. soft-deleted)  → just displayName
 *       • neither         → em-dash placeholder
 *
 * `variant` selects between "inline" (default, for use inside table cells
 * and prose) and "stacked" (for dropdown options where vertical real estate
 * is available and the `@name` can wrap under the display name).
 */
/**
 * Tone preset controlling how the chip blends with the surrounding cell.
 *   - `neutral` (default): display name in `--fg`, `@name` in `--fg-3`.
 *   - `accent`: both halves render in `--accent-dim`, matching the
 *     delegate-column affordance the list tables used before <AgentChip>
 *     existed. Use when the chip should "pop" as a cross-reference.
 */
export type AgentChipTone = "neutral" | "accent";

export type AgentChipProps = {
  name: string | null | undefined;
  displayName: string | null | undefined;
  /** Render stacked (displayName on top, `@name` below) instead of inline. */
  variant?: "inline" | "stacked";
  /** Color treatment — see `AgentChipTone` docstring. */
  tone?: AgentChipTone;
  /** Fallback shown when both fields are empty (e.g. soft-deleted row). */
  emptyLabel?: string;
  className?: string;
  style?: CSSProperties;
  title?: string;
};

export function AgentChip({
  name,
  displayName,
  variant = "inline",
  tone = "neutral",
  emptyLabel = "—",
  className,
  style,
  title,
}: AgentChipProps) {
  const hasName = typeof name === "string" && name.length > 0;
  const hasDisplay = typeof displayName === "string" && displayName.length > 0;

  if (!hasName && !hasDisplay) {
    return (
      <span className={cn("mono text-label", className)} style={{ color: "var(--fg-4)", ...style }} title={title}>
        {emptyLabel}
      </span>
    );
  }

  // Use the more descriptive label as the tooltip fallback when the caller
  // didn't pass one explicitly — hovering the chip should reveal whichever
  // label isn't already on screen.
  const computedTitle =
    title ?? (hasName && hasDisplay ? `${displayName} (@${name})` : hasDisplay ? displayName : `@${name}`);

  const primaryColor = tone === "accent" ? "var(--accent-dim)" : undefined;
  const slugColor = tone === "accent" ? "var(--accent-dim)" : "var(--fg-3)";

  if (variant === "stacked") {
    return (
      <span
        className={cn("inline-flex flex-col leading-tight", className)}
        style={{ gap: 1, ...style }}
        title={computedTitle ?? undefined}
      >
        {hasDisplay && (
          <span className="text-body" style={{ color: primaryColor }}>
            {displayName}
          </span>
        )}
        {hasName && (
          <span className="mono text-caption" style={{ color: slugColor }}>
            @{name}
          </span>
        )}
      </span>
    );
  }

  return (
    <span
      className={cn("inline-flex items-baseline gap-1.5", className)}
      style={style}
      title={computedTitle ?? undefined}
    >
      {hasDisplay && <span style={{ color: primaryColor }}>{displayName}</span>}
      {hasName && (
        <span className="mono text-caption" style={{ color: slugColor }}>
          @{name}
        </span>
      )}
    </span>
  );
}
