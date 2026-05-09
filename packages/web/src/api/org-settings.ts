import type {
  OrgContextTreeInput,
  OrgContextTreeOutput,
  OrgGithubIntegrationInput,
  OrgGithubIntegrationOutput,
  OrgSourceReposInput,
  OrgSourceReposOutput,
} from "@agent-team-foundation/first-tree-hub-shared";
import { api } from "./client.js";

function path(orgId: string, namespace: string): string {
  return `/orgs/${encodeURIComponent(orgId)}/settings/${encodeURIComponent(namespace)}`;
}

export function getContextTreeSetting(orgId: string): Promise<OrgContextTreeOutput> {
  return api.get<OrgContextTreeOutput>(path(orgId, "context_tree"));
}

export function putContextTreeSetting(orgId: string, body: OrgContextTreeInput): Promise<OrgContextTreeOutput> {
  return api.put<OrgContextTreeOutput>(path(orgId, "context_tree"), body);
}

export function deleteContextTreeSetting(orgId: string): Promise<void> {
  return api.delete<void>(path(orgId, "context_tree"));
}

export function getGithubIntegrationSetting(orgId: string): Promise<OrgGithubIntegrationOutput> {
  return api.get<OrgGithubIntegrationOutput>(path(orgId, "github_integration"));
}

export function putGithubIntegrationSetting(
  orgId: string,
  body: OrgGithubIntegrationInput,
): Promise<OrgGithubIntegrationOutput> {
  return api.put<OrgGithubIntegrationOutput>(path(orgId, "github_integration"), body);
}

export function deleteGithubIntegrationSetting(orgId: string): Promise<void> {
  return api.delete<void>(path(orgId, "github_integration"));
}

export function getSourceReposSetting(orgId: string): Promise<OrgSourceReposOutput> {
  return api.get<OrgSourceReposOutput>(path(orgId, "source_repos"));
}

export function putSourceReposSetting(orgId: string, body: OrgSourceReposInput): Promise<OrgSourceReposOutput> {
  return api.put<OrgSourceReposOutput>(path(orgId, "source_repos"), body);
}

export function deleteSourceReposSetting(orgId: string): Promise<void> {
  return api.delete<void>(path(orgId, "source_repos"));
}
