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
 * `https://api.github.com/user/repos`. Used by the onboarding Step 2
 * repo picker.
 */
export async function listGithubRepos(): Promise<GithubRepo[]> {
  const res = await api.get<{ repos: GithubRepo[] }>("/me/github/repos");
  return res.repos;
}
