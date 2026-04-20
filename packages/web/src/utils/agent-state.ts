import type { AgentState } from "../components/ui/state-dot.js";

export function resolveAgentState(runtimeState: string | null, clientId: string | null): AgentState {
  if (!clientId) return "offline";
  if (runtimeState === "idle" || runtimeState === "working" || runtimeState === "blocked" || runtimeState === "error") {
    return runtimeState;
  }
  return "offline";
}
