import type { EffectiveResourceRow } from "@first-tree/shared";

/**
 * Source label shown on every resource / prompt row, written in the agent
 * owner's first person — this page is the user looking at their own agent, not
 * an admin managing a fleet. `agent_extra` / `inline_prompt` are things the
 * user added to this agent; everything else is inherited from the team.
 */
export function sourceLabel(source: EffectiveResourceRow["source"]): string {
  if (source === "agent_extra" || source === "inline_prompt") return "Added by you";
  return "From your team";
}
