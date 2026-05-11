import { cn } from "../../lib/utils.js";
import { type AgentState, StateDot } from "./state-dot.js";

type StateChipProps = {
  state: string | null;
  className?: string;
};

function isAgentState(state: string): state is AgentState {
  return state === "idle" || state === "working" || state === "blocked" || state === "error" || state === "offline";
}

export function StateChip({ state, className }: StateChipProps) {
  const normalized: AgentState = state !== null && isAgentState(state) ? state : "offline";
  const color = normalized === "offline" ? "var(--fg-3)" : `var(--state-${normalized})`;
  // Typography (size / weight / letter-spacing) comes from the `text-caption`
  // token — shared with DenseBadge so state and neutral chips stay aligned.
  return (
    <span className={cn("mono inline-flex items-center gap-1.5 uppercase text-caption", className)} style={{ color }}>
      <StateDot state={normalized} size={7} />
      {normalized}
    </span>
  );
}
