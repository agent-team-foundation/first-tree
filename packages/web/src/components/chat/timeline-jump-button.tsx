import type { AgentMainStatus } from "@first-tree/shared";
import { ArrowRight } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { scrollToAgentTimeline } from "../../lib/scroll-to-agent-timeline.js";
import { cn } from "../../lib/utils.js";

/**
 * A clickable status element that jumps to the agent's place in the timeline,
 * with a hover-revealed `→` so the affordance is discoverable (the bare
 * `cursor:pointer` alone read as plain text). Shared by the compose rail rows
 * and the AgentRow second-line status (pills / working chip) so the
 * "click a status → jump to its context" interaction is identical in both.
 *
 * Chrome-free (no bg/border): it inherits the surrounding colour and only adds
 * the fading arrow, keeping the light rail / row visuals intact.
 */
export function TimelineJumpButton({
  agentId,
  main,
  ariaLabel,
  className,
  style,
  children,
}: {
  agentId: string;
  main: AgentMainStatus;
  ariaLabel: string;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
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
