import type { AgentMainStatus } from "@first-tree/shared";
import { ArrowRight } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { scrollToAgentTimeline } from "../../lib/scroll-to-agent-timeline.js";
import { cn } from "../../lib/utils.js";

/**
 * A status element that jumps to the agent's place in the timeline, with a
 * hover-revealed `→` so the affordance is discoverable (the bare
 * `cursor:pointer` alone read as plain text). Used by the compose activity rail;
 * the Participants roster intentionally keeps lifecycle labels static.
 *
 * `anchored` gates the affordance: only when the agent's timeline anchor is
 * actually mounted (see `useMountedAnchors`) is the element clickable and the
 * `→` shown. When it isn't, the children render as a plain static span — no
 * pointer, no arrow, no silent no-op click.
 *
 * Chrome-free (no bg/border): it inherits the surrounding colour and only adds
 * the fading arrow, keeping the light rail / row visuals intact.
 */
export function TimelineJumpButton({
  agentId,
  main,
  anchored,
  ariaLabel,
  className,
  style,
  children,
}: {
  agentId: string;
  main: AgentMainStatus;
  /** Whether this agent's timeline anchor is currently mounted. */
  anchored: boolean;
  ariaLabel: string;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  if (!anchored) {
    // Anchor not mounted (e.g. a non-primary agent's events, or an old message
    // outside the 50-message window) → show the status, but don't pretend it's
    // a working jump.
    return (
      <span className={cn("inline-flex min-w-0 items-center", className)} style={{ gap: 4, ...style }}>
        {children}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => scrollToAgentTimeline(agentId, main)}
      aria-label={ariaLabel}
      className={cn("group inline-flex min-w-0 items-center", className)}
      style={{
        gap: 4,
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
        className="h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-60"
        style={{ color: "var(--fg-4)" }}
      />
    </button>
  );
}
