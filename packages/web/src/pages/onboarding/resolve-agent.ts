import { listManagedAgents, type ManagedAgent } from "../../api/agents.js";
import { readOnboardingAgentUuid } from "../../utils/onboarding-flags.js";

/**
 * Find the agent the kickoff step should act on.
 *
 * Priority:
 *   1. The exact agent created earlier this session (uuid stashed by the
 *      create-agent step / the build-tree recovery picker) — survives revisits
 *      where list order is unspecified.
 *   2. The most recently created managed non-human agent (uuid v7 is
 *      time-ordered, so a descending string sort puts the newest first).
 *
 * Only `active` agents are eligible — a suspended agent can't bind/run, so it
 * must never be picked to seed a tree (the chat would be created against an
 * agent that never wakes).
 *
 * `organizationId` scopes BOTH the stash hit and the fallback to one org. The
 * agent that seeds a tree must belong to that tree's org; without scoping, a
 * multi-org user could seed one org's tree with another org's agent — and a
 * stash leaked from a different org/surface could override the choice. Callers
 * that operate on the selected org (kickoff, build-tree recovery) pass it;
 * omitting it preserves the original cross-org behavior.
 *
 * (Originally extracted from the now-removed inline onboarding's Step 3 so the
 * standalone flow owns its own agent-resolution logic.)
 */
export async function resolveOnboardingAgent(organizationId?: string | null): Promise<ManagedAgent> {
  const agents = await listManagedAgents();
  const usable = agents.filter((a) => a.type !== "human" && a.status === "active");
  const pool = organizationId ? usable.filter((a) => a.organizationId === organizationId) : usable;

  const stashed = readOnboardingAgentUuid();
  if (stashed) {
    const hit = pool.find((a) => a.uuid === stashed);
    if (hit) return hit;
  }

  const newestFirst = [...pool].sort((a, b) => b.uuid.localeCompare(a.uuid));
  const agent = newestFirst[0];
  if (!agent) {
    throw new Error("No agent found — create one first.");
  }
  return agent;
}
