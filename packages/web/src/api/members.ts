import type { UpdateMember } from "@agent-team-foundation/first-tree-hub-shared";
import { api, withOrg } from "./client.js";

type MemberListItem = {
  id: string;
  userId: string;
  organizationId: string;
  agentId: string;
  role: string;
  createdAt: string;
  username: string;
  displayName: string;
};

export function listMembers(): Promise<MemberListItem[]> {
  return api.get<MemberListItem[]>(withOrg("/members"));
}

export function updateMember(id: string, data: UpdateMember): Promise<MemberListItem> {
  return api.patch<MemberListItem>(withOrg(`/members/${encodeURIComponent(id)}`), data);
}

export function deleteMember(id: string): Promise<void> {
  return api.delete<void>(withOrg(`/members/${encodeURIComponent(id)}`));
}
