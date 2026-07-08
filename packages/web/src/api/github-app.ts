import type { GithubAppConnectPanelOutput, GithubAppInstallationOutput } from "@first-tree/shared";
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
 * The full installation endpoint above is also member-readable for
 * Settings → GitHub. This redacted boolean view exists so onboarding paths
 * that only need presence (specifically invitee start-chat) can detect the
 * "admin set up the tree but never connected code" failure mode without
 * pulling the full installation details. Presence is the whole answer — no
 * 404 path.
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

/**
 * Fetch the caller's connect-panel view: every installation whose
 * webhook-verified requester or installer is the caller's GitHub id,
 * labeled `connectable` / `connected-here` / `connected-elsewhere`
 * relative to the active team. The panel polls this while open —
 * installations arrive asynchronously (owner approval, installs made
 * directly on GitHub). Empty list when the caller has no GitHub identity
 * or no associated installations.
 */
export async function getGithubAppConnectPanel(organizationId: string): Promise<GithubAppConnectPanelOutput> {
  return api.get<GithubAppConnectPanelOutput>(`/orgs/${organizationId}/github-app-installation/connect-panel`);
}

/**
 * Connect an installation from the panel to the active team. The server
 * authorizes on data it already holds (team admin + the caller's GitHub id
 * equals the installation's requester or installer) — no GitHub API call.
 * 409 when the 1:1 rule blocks it (installation held by another team, or
 * this team already holds a different installation).
 */
export async function connectGithubAppInstallation(organizationId: string, installationId: number): Promise<void> {
  await api.post(`/orgs/${organizationId}/github-app-installation/connect`, { installationId });
}

/**
 * Disconnect the active team's installation. First Tree-side only — the
 * GitHub-side installation stays installed, and the row remains in the
 * panel as connectable for a later reconnect.
 */
export async function disconnectGithubAppInstallation(organizationId: string): Promise<void> {
  await api.post(`/orgs/${organizationId}/github-app-installation/disconnect`, {});
}
