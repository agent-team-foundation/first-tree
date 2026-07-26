import type { UpdateMember, UpdateMyProfile } from "@first-tree/shared";
import { api, withOrg } from "./client.js";

export type MemberListItem = {
  id: string;
  userId: string;
  organizationId: string;
  agentId: string;
  role: string;
  createdAt: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  /** Derived from the member's most recent message (口径 B); null = never active. */
  lastActiveAt: string | null;
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

export function leaveMembership(memberId: string): Promise<void> {
  return api.post<void>(`/me/memberships/${encodeURIComponent(memberId)}/leave`);
}

/**
 * Self-service profile edit (`PATCH /me/profile`) — user-scoped, NOT org-scoped
 * (no `withOrg`). The caller can rename themselves; the server has no `role`
 * field on this route, so it can never change the caller's own role.
 */
export function updateMyProfile(data: UpdateMyProfile): Promise<{ id: string; displayName: string }> {
  return api.patch<{ id: string; displayName: string }>("/me/profile", data);
}
