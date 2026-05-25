import { cn } from "../../lib/utils.js";
import { type AgentState, StateDot } from "./state-dot.js";

type StateChipProps = {
  state: string | null;
  className?: string;
};

function isAgentState(state: string): state is AgentState {
  return state === "idle" || state === "working" || state === "blocked" || state === "error" || state === "offline";
}

// Wire-level state values are lowercase enum tokens; the chip displays a
// sentence-case label so the surface reads naturally. `error` becomes
// `Failed` to match the AgentRow session-state vocabulary in the chat
// right sidebar — two surfaces calling the same condition by different
// names would force the user to translate.
const STATE_LABELS: Record<AgentState, string> = {
  idle: "Idle",
  working: "Working",
  blocked: "Blocked",
  error: "Failed",
  offline: "Offline",
};

export function StateChip({ state, className }: StateChipProps) {
  const normalized: AgentState = state !== null && isAgentState(state) ? state : "offline";
  const color = normalized === "offline" ? "var(--fg-3)" : `var(--state-${normalized})`;
  // Typography (size / weight / letter-spacing) comes from the `text-caption`
  // token — shared with DenseBadge so state and neutral chips stay aligned.
  return (
    <span className={cn("mono inline-flex items-center gap-1.5 text-caption", className)} style={{ color }}>
      <StateDot state={normalized} size={7} />
      {STATE_LABELS[normalized]}
    </span>
  );
}
