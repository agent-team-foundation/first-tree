import type {
  GitlabAutomaticActionsAudit,
  GitlabAutomaticActionsUpdate,
  GitlabConnectionCreate,
  GitlabConnectionSecretResponse,
  GitlabConnectionSummary,
  GitlabIdentityLinkCreate,
  GitlabIdentityLinkSummary,
  GitlabIdentityTransitionAudit,
  GitlabSkippedTargetAudit,
} from "@first-tree/shared";
import { api, withOrg } from "./client.js";

export async function listGitlabConnections(): Promise<GitlabConnectionSummary[]> {
  const response = await api.get<{ connections: GitlabConnectionSummary[] }>(withOrg("/gitlab-connections"));
  return response.connections;
}

export function createGitlabConnection(input: GitlabConnectionCreate): Promise<GitlabConnectionSecretResponse> {
  return api.post<GitlabConnectionSecretResponse>(withOrg("/gitlab-connections"), input);
}

export function regenerateGitlabBearer(connectionId: string): Promise<GitlabConnectionSecretResponse> {
  return api.post<GitlabConnectionSecretResponse>(`/gitlab-connections/${encodeURIComponent(connectionId)}/regenerate`);
}

export function replaceGitlabConnection(
  connectionId: string,
  input: GitlabConnectionCreate,
): Promise<GitlabConnectionSecretResponse> {
  return api.post<GitlabConnectionSecretResponse>(
    `/gitlab-connections/${encodeURIComponent(connectionId)}/replace`,
    input,
  );
}

export function deleteGitlabConnection(connectionId: string): Promise<void> {
  return api.delete<void>(`/gitlab-connections/${encodeURIComponent(connectionId)}`);
}

export function setGitlabAutomaticActions(
  connectionId: string,
  input: GitlabAutomaticActionsUpdate,
): Promise<GitlabConnectionSummary> {
  return api.post<GitlabConnectionSummary>(
    `/gitlab-connections/${encodeURIComponent(connectionId)}/automatic-actions`,
    input,
  );
}

export function confirmGitlabAssigneeMode(connectionId: string): Promise<GitlabConnectionSummary> {
  return api.post<GitlabConnectionSummary>(
    `/gitlab-connections/${encodeURIComponent(connectionId)}/reviewer-mode/assignee`,
    { confirmLegacyAssigneeMode: true },
  );
}

export async function listGitlabIdentityLinks(): Promise<GitlabIdentityLinkSummary[]> {
  const response = await api.get<{ links: GitlabIdentityLinkSummary[] }>(withOrg("/gitlab-identity-links"));
  return response.links;
}

export async function listGitlabIdentityTransitionAudit(): Promise<GitlabIdentityTransitionAudit[]> {
  const response = await api.get<{ events: GitlabIdentityTransitionAudit[] }>(withOrg("/gitlab-identity-links/audit"));
  return response.events;
}

export function createGitlabIdentityLink(input: GitlabIdentityLinkCreate): Promise<GitlabIdentityLinkSummary> {
  return api.post<GitlabIdentityLinkSummary>(withOrg("/gitlab-identity-links"), input);
}

export function suspendGitlabIdentityLink(linkId: string): Promise<GitlabIdentityLinkSummary> {
  return api.post<GitlabIdentityLinkSummary>(`/gitlab-identity-links/${encodeURIComponent(linkId)}/suspend`, {});
}

export function revokeGitlabIdentityLink(linkId: string): Promise<GitlabIdentityLinkSummary> {
  return api.post<GitlabIdentityLinkSummary>(`/gitlab-identity-links/${encodeURIComponent(linkId)}/revoke`, {});
}

export function reconfirmGitlabIdentityLink(linkId: string): Promise<GitlabIdentityLinkSummary> {
  return api.post<GitlabIdentityLinkSummary>(`/gitlab-identity-links/${encodeURIComponent(linkId)}/reconfirm`, {});
}

export async function listGitlabAutomaticActionsAudit(): Promise<GitlabAutomaticActionsAudit[]> {
  const response = await api.get<{ events: GitlabAutomaticActionsAudit[] }>(
    withOrg("/gitlab-connections/automatic-actions-audit"),
  );
  return response.events;
}

export async function listGitlabSkippedTargets(): Promise<GitlabSkippedTargetAudit[]> {
  const response = await api.get<{ events: GitlabSkippedTargetAudit[] }>(
    withOrg("/gitlab-connections/skipped-targets"),
  );
  return response.events;
}
