import type { Agent } from "@first-tree/shared";

export function canManageAgentDetail(
  agent: Pick<Agent, "managerId"> | null | undefined,
  memberId: string | null,
  role: string | null,
): boolean {
  if (!agent) return false;
  return role === "admin" || (!!memberId && agent.managerId === memberId);
}
