import type { GithubAppInstallationOutput } from "@agent-team-foundation/first-tree-hub-shared";
import { ApiError, api } from "./client.js";

/**
 * Fetch the GitHub App installation bound to the active org. 404 when no
 * install is bound — the Settings panel renders the "Install on GitHub"
 * prompt in that case rather than treating it as an error.
 *
 * Returns `null` instead of throwing on 404 so the consuming React Query
 * `queryFn` can render the empty state without surfacing an error.
 *
 * codex P1-2: the previous implementation matched `/\b404\b/.test(err.message)`
 * against the error string. The server's 404 body is "No GitHub App
 * installation is bound to this team" — no literal "404" in it — so the
 * regex never fired and the Settings empty state surfaced as an error
 * banner instead of the Install CTA. Check `ApiError.status` instead.
 */
export async function getGithubAppInstallation(organizationId: string): Promise<GithubAppInstallationOutput | null> {
  try {
    return await api.get<GithubAppInstallationOutput>(`/orgs/${organizationId}/github-app-installation`);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
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
