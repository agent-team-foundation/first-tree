import { listManagedAgents, type ManagedAgent } from "../../api/agents.js";
import { readOnboardingAgentUuid } from "../../utils/onboarding-flags.js";

/**
 * Find the agent the kickoff step should act on.
 *
 * Priority:
 *   1. The exact agent created earlier this session (uuid stashed by the
 *      create-agent step) — survives revisits where list order is unspecified.
 *   2. The most recently created managed non-human agent (uuid v7 is
 *      time-ordered, so a descending string sort puts the newest first).
 *
 * (Originally extracted from the now-removed inline onboarding's Step 3 so the
 * standalone flow owns its own agent-resolution logic.)
 */
export async function resolveOnboardingAgent(): Promise<ManagedAgent> {
  const agents = await listManagedAgents();
  const managed = agents.filter((a) => a.type !== "human");

  const stashed = readOnboardingAgentUuid();
  if (stashed) {
    const hit = managed.find((a) => a.uuid === stashed);
    if (hit) return hit;
  }

  const newestFirst = [...managed].sort((a, b) => b.uuid.localeCompare(a.uuid));
  const agent = newestFirst[0];
  if (!agent) {
    throw new Error("No agent found — create one first.");
  }
  return agent;
}
