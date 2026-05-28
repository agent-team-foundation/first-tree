import type { GithubAppInstallationOutput } from "@first-tree/shared";
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
 * Member-readable "is the GitHub App installed for this team?" probe.
 *
 * The full installation endpoint above is admin-only because it exposes
 * install-id / permissions / events. This redacted boolean view exists so
 * non-admin onboarding paths (specifically invitee kickoff) can detect
 * the "admin set up the tree but never connected code" failure mode
 * without either (a) silently 403-ing every invitee out of the flow or
 * (b) never tripping at all. Presence is the whole answer — no 404 path.
 */
export async function getGithubAppInstallationExists(organizationId: string): Promise<boolean> {
  const r = await api.get<{ exists: boolean }>(`/orgs/${organizationId}/github-app-installation/exists`);
  return r.exists;
}

/**
 * Fetch the GitHub App install URL for the active org. The server mints a
 * signed `state` JWT, sets the `oauth_state_nonce` cookie alongside it,
 * and returns `https://github.com/apps/<slug>/installations/new?state=…`
 * — GitHub's install dialog (repo picker + permission review). The SPA
 * navigates the browser to it via `window.location`.
 *
 * codex P1-1: the previous implementation pointed the "Install on GitHub"
 * CTA at `/auth/github/start`, which builds the OAuth `authorize` URL.
 * For a user who hasn't installed the App yet that URL only triggers
 * OAuth consent — GitHub never shows the install picker and never returns
 * an `installation_id`, so the bind silently never happens. The
 * `installations/new` URL is the one that actually surfaces the install
 * dialog.
 *
 * Throws `ApiError` with `status === 503` when the operator hasn't set
 * `FIRST_TREE_GITHUB_APP_SLUG`; the panel surfaces that as a hint.
 *
 * `next` controls where GitHub bounces the user after the install dialog
 * (baked into the signed state server-side). Defaults to Settings → GitHub;
 * the onboarding flow passes `/onboarding` so the user lands back in setup.
 * The server allowlists the value, so an arbitrary string is ignored.
 */
export async function getGithubAppInstallUrl(organizationId: string, next?: string): Promise<string> {
  const qs = next ? `?next=${encodeURIComponent(next)}` : "";
  const { installUrl } = await api.get<{ installUrl: string }>(
    `/orgs/${organizationId}/github-app-installation/install-url${qs}`,
  );
  return installUrl;
}
