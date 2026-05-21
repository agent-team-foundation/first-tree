import type { AgentStatusPulse, AgentStatusShape } from "../../lib/agent-status-view.js";
import { StatusGlyph } from "./status-glyph.js";

/** Agent-global runtime vocabulary (axis A). Distinct from the per-(agent,chat)
 * composite `AgentMainStatus` — they share visual atoms, not enum values. */
export type AgentState = "idle" | "working" | "blocked" | "error" | "offline";

/**
 * Map a runtime-A state to its shared visual atom (§9.1). Colors are the
 * same `--state-*` tokens the composite vocabulary uses, so "working" is the
 * same blue everywhere. `blocked` is a solid amber dot — the rotating dashed
 * ring (`dash-spin`) was retired in §9.2 in favour of one amber atom.
 */
function runtimeStateView(state: AgentState): { colorVar: string; shape: AgentStatusShape; pulse: AgentStatusPulse } {
  switch (state) {
    case "working":
      return { colorVar: "var(--state-working)", shape: "dot", pulse: "working" };
    case "blocked":
      return { colorVar: "var(--state-blocked)", shape: "dot", pulse: null };
    case "error":
      return { colorVar: "var(--state-error)", shape: "triangle", pulse: null };
    case "idle":
      return { colorVar: "var(--state-idle)", shape: "dot", pulse: null };
    case "offline":
      return { colorVar: "var(--state-offline)", shape: "hollow", pulse: null };
  }
}

export function StateDot({ state, size = 8, className }: { state: AgentState; size?: number; className?: string }) {
  const v = runtimeStateView(state);
  return (
    <StatusGlyph
      colorVar={v.colorVar}
      shape={v.shape}
      pulse={v.pulse}
      size={size}
      className={className}
      ariaLabel={state}
    />
  );
}
