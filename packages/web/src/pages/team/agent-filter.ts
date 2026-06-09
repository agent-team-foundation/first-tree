import type { Agent } from "@first-tree/shared";

/**
 * The agent-only "All | Mine" scope, shared between the Team page (where it's
 * toggled) and the agent-detail switcher (which follows it read-only). Single
 * source of truth for the persisted preference + the membership predicate so the
 * two surfaces can never drift.
 */
export type AgentFilter = "all" | "mine";

const AGENT_FILTER_STORAGE_KEY = "first-tree:team-agent-filter:v1";

export function readAgentFilterPreference(): AgentFilter {
  if (typeof window === "undefined") return "all";
  try {
    const stored = window.localStorage?.getItem?.(AGENT_FILTER_STORAGE_KEY);
    return stored === "mine" ? "mine" : "all";
  } catch {
    return "all";
  }
}

export function writeAgentFilterPreference(next: AgentFilter): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage?.setItem?.(AGENT_FILTER_STORAGE_KEY, next);
  } catch {
    // Preference storage is best-effort; the current in-memory filter still works.
  }
}

/**
 * Whether an agent falls inside the current scope. "all" matches everything;
 * "mine" matches only agents the viewer manages. (Visibility filtering is a
 * separate, page-specific concern and is NOT folded in here.)
 */
export function matchesAgentScope(agent: Agent, filter: AgentFilter, selfMemberId: string | null): boolean {
  if (filter === "all") return true;
  return agent.managerId === selfMemberId;
}
