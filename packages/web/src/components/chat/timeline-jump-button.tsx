import { ArrowRight } from "lucide-react";
import type { CSSProperties, MouseEvent, ReactNode } from "react";
import { scrollToAgentTimeline } from "../../lib/scroll-to-agent-timeline.js";
import type { TimelineAnchorKind } from "../../lib/use-mounted-anchors.js";
import { cn } from "../../lib/utils.js";

/**
 * A status element that jumps to the agent's place in the timeline. A quiet
 * trailing `→` makes the destination discoverable without introducing a
 * competing text action. Used by the compose live-activity inspector; the
 * Participants roster intentionally keeps lifecycle labels static.
 *
 * `anchored` gates the affordance: only when the agent's timeline anchor is
 * actually mounted (see `useMountedAnchors`) is the element clickable and the
 * `→` shown. When it isn't, the children render as a plain static div — no
 * pointer, no arrow, no silent no-op click.
 *
 * Chrome-free (no bg/border): it inherits the surrounding colour and only adds
 * the fading arrow, keeping the light rail / row visuals intact.
 */
export function TimelineJumpButton({
  agentId,
  target,
  anchored,
  ariaLabel,
  onNavigate,
  className,
  interactiveClassName,
  style,
  children,
}: {
  agentId: string;
  target: TimelineAnchorKind;
  /** Whether this agent's timeline anchor is currently mounted. */
  anchored: boolean;
  ariaLabel: string;
  /** Runs immediately before the timeline scroll (for example, to close a popover). */
  onNavigate?: () => void;
  className?: string;
  /** Classes applied only when the element is an actionable button. */
  interactiveClassName?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  if (!anchored) {
    // Anchor not mounted (for example, evidence outside a bounded timeline
    // window) → show the status, but don't pretend it is a working jump.
    return (
      <div className={cn("inline-flex min-w-0 items-center", className)} style={{ gap: "var(--sp-1)", ...style }}>
        {children}
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={(event: MouseEvent<HTMLButtonElement>) => {
        onNavigate?.();
        scrollToAgentTimeline(agentId, target, { focus: event.detail === 0 });
      }}
      aria-label={ariaLabel}
      className={cn("group inline-flex min-w-0 items-center", className, interactiveClassName)}
      style={{
        gap: "var(--sp-1)",
        border: 0,
        background: "transparent",
        padding: 0,
        cursor: "pointer",
        textAlign: "left",
        color: "inherit",
        ...style,
      }}
    >
      {children}
      <ArrowRight
        aria-hidden="true"
        className="h-3.5 w-3.5 shrink-0 opacity-70 transition-all group-hover:translate-x-0.5 group-hover:opacity-100 group-focus-visible:translate-x-0.5 group-focus-visible:opacity-100"
        style={{ color: "var(--fg-3)" }}
      />
    </button>
  );
}
