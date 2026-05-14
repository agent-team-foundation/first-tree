import type { Agent } from "@agent-team-foundation/first-tree-hub-shared";

export function canManageAgentDetail(
  agent: Pick<Agent, "managerId"> | null | undefined,
  memberId: string | null,
  role: string | null,
): boolean {
  if (!agent) return false;
  return role === "admin" || (!!memberId && agent.managerId === memberId);
}
