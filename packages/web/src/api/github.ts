import { api } from "./client.js";

export type GithubRepo = {
  fullName: string;
  cloneUrl: string;
  htmlUrl: string;
  private: boolean;
  defaultBranch: string | null;
  pushedAt: string | null;
};

/**
 * Fetch the caller's accessible GitHub repos. Server-side proxy that
 * decrypts the OAuth token captured at sign-in and calls
 * `https://api.github.com/user/repos`. Personal + every org the user
 * belongs to. Used by the invitee kickoff picker ("pick your own project").
 */
export async function listGithubRepos(): Promise<GithubRepo[]> {
  const res = await api.get<{ repos: GithubRepo[] }>("/me/github/repos");
  return res.repos;
}

/**
 * Fetch the repos a team's GitHub App installation can access (org-scoped).
 * Used by the admin connect-code picker: the product is team-by-default, so
 * the picker offers the team's org code, not the admin's personal repos —
 * and only repos the agent can actually reach (the installation's grant),
 * never a repo that would 403 on the first git op. Backed by
 * `GET /orgs/:orgId/github-app-installation/repositories`.
 */
export async function listOrgGithubRepos(organizationId: string): Promise<GithubRepo[]> {
  const res = await api.get<{ repos: GithubRepo[] }>(`/orgs/${organizationId}/github-app-installation/repositories`);
  return res.repos;
}
