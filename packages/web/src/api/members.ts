import type { CreateMember, MemberCreated, UpdateMember } from "@agent-team-foundation/first-tree-hub-shared";
import { api } from "./client.js";

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
  return api.get<MemberListItem[]>("/members");
}

export function createMember(data: CreateMember): Promise<MemberCreated> {
  return api.post<MemberCreated>("/members", data);
}

export function updateMember(id: string, data: UpdateMember): Promise<MemberListItem> {
  return api.patch<MemberListItem>(`/members/${encodeURIComponent(id)}`, data);
}

export function deleteMember(id: string): Promise<void> {
  return api.delete<void>(`/members/${encodeURIComponent(id)}`);
}
