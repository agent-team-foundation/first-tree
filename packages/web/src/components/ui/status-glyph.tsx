import type { CSSProperties } from "react";
import type { AgentStatusPulse, AgentStatusShape } from "../../lib/agent-status-view.js";
import { cn } from "../../lib/utils.js";

const PULSE_CLASS: Record<NonNullable<AgentStatusPulse>, string> = {
  working: "agent-status-pulse--working",
  "needs-you": "agent-status-pulse--needs-you",
};

/**
 * The shared low-level status indicator atom: one renderer for the §9.1
 * shape vocabulary (color + shape + pulse). Both the runtime-A `StateDot`
 * and the composite `AgentStatusChip` draw through this, so a "working"
 * agent reads identically no matter which subsystem drives it — the visual
 * grammar is unified even though the two enums are not (see
 * agent-status.ts).
 *
 * `colorVar` is always a `var(--state-*)` / `var(--fg-*)` token reference.
 */
export function StatusGlyph({
  colorVar,
  shape,
  pulse = null,
  size = 8,
  className,
  ariaLabel,
}: {
  colorVar: string;
  shape: AgentStatusShape;
  pulse?: AgentStatusPulse;
  size?: number;
  className?: string;
  ariaLabel?: string;
}) {
  const a11y = ariaLabel ? { role: "img", "aria-label": ariaLabel } : { "aria-hidden": true };
  const box: CSSProperties = { width: size, height: size, flexShrink: 0 };

  if (shape === "triangle") {
    return (
      <span
        className={cn("inline-block shrink-0", className)}
        style={{ ...box, background: colorVar, clipPath: "polygon(50% 0%, 100% 100%, 0% 100%)", borderRadius: 1 }}
        {...a11y}
      />
    );
  }

  if (shape === "hollow") {
    return (
      <span
        className={cn("inline-block shrink-0", className)}
        style={{ ...box, borderRadius: "50%", border: `var(--hairline) solid ${colorVar}`, background: "transparent" }}
        {...a11y}
      />
    );
  }

  if (shape === "pause") {
    // Two vertical bars (⏸) — a distinct shape from the offline hollow ring,
    // so "paused" and "offline" never read the same at a glance.
    const barWidth = Math.max(2, Math.round(size * 0.3));
    const gap = Math.max(2, Math.round(size * 0.24));
    const bar: CSSProperties = { width: barWidth, height: size, borderRadius: 1, background: colorVar };
    return (
      <span
        className={cn("inline-flex shrink-0 items-center justify-center", className)}
        style={{ ...box, gap }}
        {...a11y}
      >
        <span style={bar} />
        <span style={bar} />
      </span>
    );
  }

  // shape === "dot": a solid disc. working / needs-you breathe the disc's own
  // opacity (no concentric ring) so every status point keeps an identical
  // footprint — a long roster column stays aligned regardless of state.
  return (
    <span
      className={cn("inline-block shrink-0", pulse ? PULSE_CLASS[pulse] : null, className)}
      style={{ ...box, borderRadius: "50%", background: colorVar }}
      {...a11y}
    />
  );
}
