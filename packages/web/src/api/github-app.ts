import type { GithubAppInstallationOutput } from "@agent-team-foundation/first-tree-hub-shared";
import { api } from "./client.js";

/**
 * Fetch the GitHub App installation bound to the active org. 404 when no
 * install is bound — the Settings panel renders the "Install on GitHub"
 * prompt in that case rather than treating it as an error.
 *
 * Returns `null` instead of throwing on 404 so the consuming React Query
 * `queryFn` can render the empty state without surfacing an error.
 */
export async function getGithubAppInstallation(organizationId: string): Promise<GithubAppInstallationOutput | null> {
  try {
    return await api.get<GithubAppInstallationOutput>(`/orgs/${organizationId}/github-app-installation`);
  } catch (err) {
    if (err instanceof Error && /\b404\b/.test(err.message)) {
      return null;
    }
    throw err;
  }
}

/**
 * Build the URL that kicks off the App's install flow. We reuse the
 * standard `/auth/github/start` endpoint — when the App is configured
 * upstream it builds the combined OAuth + install authorize URL (D1).
 *
 * `next` lands the user back on the Settings page after the install
 * completes so the panel can re-render with the now-bound state.
 */
export function buildInstallStartUrl(): string {
  return "/api/v1/auth/github/start?next=/settings/github";
}
