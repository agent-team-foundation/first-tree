import { cn } from "../../lib/utils.js";
import { type AgentState, StateDot } from "./state-dot.js";

type StateChipProps = {
  state: string | null;
  className?: string;
};

const VALID: Record<string, AgentState> = {
  idle: "idle",
  working: "working",
  blocked: "blocked",
  error: "error",
  offline: "offline",
};

export function StateChip({ state, className }: StateChipProps) {
  const normalized: AgentState = state && VALID[state] ? VALID[state] : "offline";
  const color = normalized === "offline" ? "var(--fg-3)" : `var(--state-${normalized})`;
  return (
    <span
      className={cn("mono inline-flex items-center gap-1.5 uppercase tracking-wider", className)}
      style={{ fontSize: 10, letterSpacing: 0.06, color }}
    >
      <StateDot state={normalized} size={7} />
      {normalized}
    </span>
  );
}
