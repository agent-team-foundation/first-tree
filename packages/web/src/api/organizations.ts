import type { Organization } from "@agent-team-foundation/first-tree-hub-shared";
import { api } from "./client.js";

/**
 * Org-level admin + self-service surface used by `OrgSettingsPage`.
 *
 *  - `getOrganization` reads the team identity (slug + display name) for
 *    the currently-active org. Admin-only on the server.
 *  - `updateOrganization` patches `name` (slug) and/or `displayName`.
 *  - `leaveOrganization` flips the caller's `members.status` to "left".
 *    Soft-delete; tokens for this membership become 401 immediately.
 */
export function getOrganization(id: string): Promise<Organization> {
  return api.get<Organization>(`/admin/organizations/${encodeURIComponent(id)}`);
}

export function updateOrganization(id: string, patch: { name?: string; displayName?: string }): Promise<Organization> {
  return api.patch<Organization>(`/admin/organizations/${encodeURIComponent(id)}`, patch);
}

export function leaveOrganization(): Promise<void> {
  return api.post<void>("/me/organizations/leave");
}
