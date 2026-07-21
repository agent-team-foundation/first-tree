import type {
  GitlabConnectionCreate,
  GitlabConnectionSecretResponse,
  GitlabConnectionSummary,
  GitlabIdentityLinkCreate,
  GitlabIdentityLinkSummary,
} from "@first-tree/shared";
import { api, withOrg } from "./client.js";

export const gitlabConnectionsQueryKey = (organizationId: string | null) =>
  ["gitlab-connections", organizationId] as const;

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

export async function listGitlabIdentityLinks(): Promise<GitlabIdentityLinkSummary[]> {
  const response = await api.get<{ links: GitlabIdentityLinkSummary[] }>(withOrg("/gitlab-identity-links"));
  return response.links;
}

export function createGitlabIdentityLink(input: GitlabIdentityLinkCreate): Promise<GitlabIdentityLinkSummary> {
  return api.post<GitlabIdentityLinkSummary>(withOrg("/gitlab-identity-links"), input);
}

export function removeGitlabIdentityLink(linkId: string): Promise<void> {
  return api.delete<void>(`/gitlab-identity-links/${encodeURIComponent(linkId)}`);
}

export function reconfirmGitlabIdentityLink(linkId: string): Promise<GitlabIdentityLinkSummary> {
  return api.post<GitlabIdentityLinkSummary>(`/gitlab-identity-links/${encodeURIComponent(linkId)}/reconfirm`, {});
}
