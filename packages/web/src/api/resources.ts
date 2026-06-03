import type {
  CreateTeamResource,
  ResourceImpactPreview,
  ResourceImpactPreviewOutput,
  ResourceRow,
  ResourceUsageOutput,
  UpdateTeamResource,
} from "@first-tree/shared";
import { api, withOrg, withOrgAt } from "./client.js";

export function listTeamResources(): Promise<ResourceRow[]> {
  return api.get<ResourceRow[]>(withOrg("/resources"));
}

export function createTeamResource(body: CreateTeamResource): Promise<ResourceRow> {
  return api.post<ResourceRow>(withOrg("/resources"), body);
}

export function createTeamResourceForOrg(orgId: string, body: CreateTeamResource): Promise<ResourceRow> {
  return api.post<ResourceRow>(withOrgAt(orgId, "/resources"), body);
}

export function previewOrgResourceImpact(body: ResourceImpactPreview): Promise<ResourceImpactPreviewOutput> {
  return api.post<ResourceImpactPreviewOutput>(withOrg("/resources/impact-preview"), body);
}

export function getResource(resourceId: string): Promise<ResourceRow> {
  return api.get<ResourceRow>(`/resources/${encodeURIComponent(resourceId)}`);
}

export function updateResource(resourceId: string, body: UpdateTeamResource): Promise<ResourceRow> {
  return api.patch<ResourceRow>(`/resources/${encodeURIComponent(resourceId)}`, body);
}

export function retireResource(resourceId: string): Promise<ResourceImpactPreviewOutput> {
  return api.delete<ResourceImpactPreviewOutput>(`/resources/${encodeURIComponent(resourceId)}`);
}

export function promoteResource(resourceId: string): Promise<ResourceRow> {
  return api.post<ResourceRow>(`/resources/${encodeURIComponent(resourceId)}/promote`);
}

export function getResourceUsage(resourceId: string): Promise<ResourceUsageOutput> {
  return api.get<ResourceUsageOutput>(`/resources/${encodeURIComponent(resourceId)}/usage`);
}

export function previewResourceImpact(
  resourceId: string,
  body: ResourceImpactPreview = {},
): Promise<ResourceImpactPreviewOutput> {
  return api.post<ResourceImpactPreviewOutput>(`/resources/${encodeURIComponent(resourceId)}/impact-preview`, body);
}
