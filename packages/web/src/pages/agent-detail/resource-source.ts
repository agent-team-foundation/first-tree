import type { EffectiveResourceRow } from "@first-tree/shared";

/**
 * Source label shown on every resource / prompt row, written in the agent
 * owner's first person — this page is the user looking at their own agent, not
 * an admin managing a fleet. `agent_extra` / `inline_prompt` are things the
 * user added to this agent; everything else is inherited from the team.
 *
 * Team resources split by how they got here: `team_recommended` is on by default
 * (a Switch toggles it), while `team_available` is one the user opted into (no
 * Switch — it's removed via ⋯). The `· optional` qualifier disambiguates the two,
 * which otherwise read identically as "From your team" despite different controls.
 */
export function sourceLabel(source: EffectiveResourceRow["source"]): string {
  if (source === "agent_extra" || source === "inline_prompt") return "Added by you";
  if (source === "team_available") return "From your team · optional";
  return "From your team";
}
