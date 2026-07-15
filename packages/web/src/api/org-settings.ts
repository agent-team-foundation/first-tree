import type {
  OrgContextTreeFeaturesInput,
  OrgContextTreeFeaturesOutput,
  OrgContextTreeInput,
  OrgContextTreeOutput,
  OrgSourceReposInput,
  OrgSourceReposOutput,
} from "@first-tree/shared";
import { api } from "./client.js";

function path(orgId: string, namespace: string): string {
  return `/orgs/${encodeURIComponent(orgId)}/settings/${encodeURIComponent(namespace)}`;
}

export function getContextTreeSetting(orgId: string): Promise<OrgContextTreeOutput> {
  return api.get<OrgContextTreeOutput>(path(orgId, "context_tree"));
}

export function getRawContextTreeSetting(orgId: string): Promise<OrgContextTreeOutput> {
  return api.get<OrgContextTreeOutput>(`${path(orgId, "context_tree")}/raw`);
}

export function putContextTreeSetting(orgId: string, body: OrgContextTreeInput): Promise<OrgContextTreeOutput> {
  return api.put<OrgContextTreeOutput>(path(orgId, "context_tree"), body);
}

export function deleteContextTreeSetting(orgId: string): Promise<void> {
  return api.delete<void>(path(orgId, "context_tree"));
}

export function getContextTreeFeaturesSetting(orgId: string): Promise<OrgContextTreeFeaturesOutput> {
  return api.get<OrgContextTreeFeaturesOutput>(path(orgId, "context_tree_features"));
}

export function putContextTreeFeaturesSetting(
  orgId: string,
  body: OrgContextTreeFeaturesInput,
): Promise<OrgContextTreeFeaturesOutput> {
  return api.put<OrgContextTreeFeaturesOutput>(path(orgId, "context_tree_features"), body);
}

// `getGithubIntegrationSetting` / `putGithubIntegrationSetting` /
// `deleteGithubIntegrationSetting` were removed in the D3 cutover. The
// per-org webhook secret model is replaced by the GitHub App
// installation surface — see `api/github-app.ts`.

export function getSourceReposSetting(orgId: string): Promise<OrgSourceReposOutput> {
  return api.get<OrgSourceReposOutput>(path(orgId, "source_repos"));
}

export function putSourceReposSetting(orgId: string, body: OrgSourceReposInput): Promise<OrgSourceReposOutput> {
  return api.put<OrgSourceReposOutput>(path(orgId, "source_repos"), body);
}

export function deleteSourceReposSetting(orgId: string): Promise<void> {
  return api.delete<void>(path(orgId, "source_repos"));
}
