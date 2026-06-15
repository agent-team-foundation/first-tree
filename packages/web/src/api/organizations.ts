import type { Organization, OrganizationDeletionImpact, UpdateOrganization } from "@first-tree/shared";
import { api } from "./client.js";

/**
 * Read & rename the org-of-current-selection. Both calls hit
 * `/api/v1/orgs/:orgId` directly — the api client's `decoratePath`
 * passthrough leaves the explicit `/orgs/...` URL alone.
 */
export function getOrganization(id: string): Promise<Organization> {
  return api.get<Organization>(`/orgs/${encodeURIComponent(id)}`);
}

export function updateOrganization(id: string, patch: UpdateOrganization): Promise<Organization> {
  return api.patch<Organization>(`/orgs/${encodeURIComponent(id)}`, patch);
}

export function previewOrganizationDeletion(id: string): Promise<OrganizationDeletionImpact> {
  return api.get<OrganizationDeletionImpact>(`/orgs/${encodeURIComponent(id)}/delete-preview`);
}

export function deleteOrganization(id: string): Promise<OrganizationDeletionImpact> {
  return api.delete<OrganizationDeletionImpact>(`/orgs/${encodeURIComponent(id)}`);
}
