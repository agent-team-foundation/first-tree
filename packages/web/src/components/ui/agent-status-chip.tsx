import type { AgentMainStatus } from "@first-tree/shared";
import { viewOf } from "../../lib/agent-status-view.js";
import { cn } from "../../lib/utils.js";
import { StatusGlyph } from "./status-glyph.js";

/**
 * Composite-status chip: the per-(agent,chat) counterpart to `StateChip`.
 * Renders an `AgentMainStatus` via the shared `viewOf` mapping + `StatusGlyph`
 * (glyph + sentence-case label). Used wherever a surface speaks the composite
 * vocabulary (e.g. the session context panel); the management pages keep
 * using `StateChip` for the runtime-A vocabulary.
 */
export function AgentStatusChip({ main, className }: { main: AgentMainStatus; className?: string }) {
  const v = viewOf(main);
  return (
    <span className={cn("mono inline-flex items-center gap-1.5 text-caption", className)} style={{ color: v.colorVar }}>
      <StatusGlyph colorVar={v.colorVar} shape={v.shape} pulse={v.pulse} size={7} ariaLabel={v.label} />
      {v.label}
    </span>
  );
}
