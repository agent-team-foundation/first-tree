import type { ContextTreeRecoveryAction, ContextTreeSnapshot } from "@first-tree/shared";
import { type ContextTreeBinding, isGithubRemoteBinding } from "./context-tree-snapshot.js";
import {
  createAppJwt,
  GithubAppApiError,
  type GithubAppCredentials,
  getRepository,
  type InstallationToken,
  mintInstallationToken,
} from "./github-app.js";
import type { InstallationRow } from "./github-app-installations.js";

/**
 * Outcome of minting a Context Tree installation token for an org.
 *
 * - `ok: true`  — caller passes `token` as the git basic-auth password
 *                 (username `x-access-token`).
 * - `ok: false` — caller falls back to unauthenticated git fetch. Public
 *                 repos still resolve; private repos surface as an
 *                 unavailable snapshot. The route layer uses `reason` to
 *                 pick a user-facing remediation message.
 */
export type ContextTreeInstallationTokenResult =
  | {
      ok: true;
      token: string;
      permissions: InstallationToken["permissions"];
      repositorySelection: InstallationToken["repositorySelection"];
    }
  | { ok: false; reason: "no-app-config" | "no-installation" | "suspended" | "mint-failed"; detail?: string };

export type MintContextTreeInstallationTokenOptions = {
  /** Test seam — injected `fetch` for `mintInstallationToken`. */
  fetcher?: typeof fetch;
};

/**
 * Mint a short-lived GitHub App installation token for the given installation.
 * Returns `ok: false` (with a precise reason) when the org has no App
 * configured, no installation row, the installation is suspended, or GitHub
 * rejects the mint — callers fall back to unauthenticated git fetch (public
 * repos still resolve; private repos surface as an unavailable snapshot
 * with a remediation message).
 *
 * Takes the `installation` row directly so the helper has no DB dependency
 * — route handlers do the `findInstallationByOrg` lookup themselves. Keeps
 * this module a pure transform that's trivial to unit-test.
 *
 * Credentials use the narrow `GithubAppCredentials` shape so the helper
 * isn't coupled to the broader OAuth config surface; callers pass
 * `config.oauth?.githubApp`, which structurally satisfies it.
 */
export async function mintContextTreeInstallationToken(
  installation: InstallationRow | null,
  appCredentials: GithubAppCredentials | undefined,
  options: MintContextTreeInstallationTokenOptions = {},
): Promise<ContextTreeInstallationTokenResult> {
  if (!appCredentials) {
    return { ok: false, reason: "no-app-config" };
  }
  if (!installation) {
    return { ok: false, reason: "no-installation" };
  }
  if (installation.suspendedAt) {
    return { ok: false, reason: "suspended" };
  }

  try {
    const appJwt = await createAppJwt({
      appId: appCredentials.appId,
      privateKeyPem: appCredentials.privateKeyPem,
    });
    const minted = await mintInstallationToken(appJwt, installation.installationId, { fetcher: options.fetcher });
    return {
      ok: true,
      token: minted.token,
      permissions: minted.permissions,
      repositorySelection: minted.repositorySelection,
    };
  } catch (error) {
    const detail =
      error instanceof GithubAppApiError
        ? `GitHub returned ${error.status} when minting an installation token.`
        : "First Tree could not mint a GitHub App installation token.";
    return { ok: false, reason: "mint-failed", detail };
  }
}

/**
 * Append a remediation hint to an unavailable snapshot's `contextStatus.detail`
 * when the underlying cause is a missing / suspended / failed GitHub App token
 * mint. Public-repo snapshots (mint reason `no-app-config`) are left untouched
 * — the deployment may legitimately have no App configured.
 *
 * Gated on `isGithubRemoteBinding(binding)` so unrelated unavailable
 * reasons (no repo configured, localPath missing, illegal branch name,
 * public-repo fetch error) don't get a misleading "install the GitHub
 * App" hint appended.
 *
 * Lives next to `mintContextTreeInstallationToken` so the two routes that
 * call mint share one shaping function; the snapshot service itself stays
 * token-agnostic.
 */
export function decorateSnapshotWithMintGuidance(
  snapshot: ContextTreeSnapshot,
  binding: ContextTreeBinding,
  mintResult: ContextTreeInstallationTokenResult,
): ContextTreeSnapshot {
  if (mintResult.ok) return snapshot;
  if (snapshot.snapshotStatus !== "unavailable") return snapshot;
  if (mintResult.reason === "no-app-config") return snapshot;
  if (!isGithubRemoteBinding(binding)) return snapshot;

  const guidance =
    mintResult.reason === "no-installation"
      ? "Install the First Tree GitHub App from Team Settings and grant it access to this repo."
      : mintResult.reason === "suspended"
        ? "The GitHub App installation is suspended — unsuspend it from your GitHub account settings."
        : `First Tree could not mint a GitHub App installation token.${mintResult.detail ? ` ${mintResult.detail}` : ""}`;

  return {
    ...snapshot,
    contextStatus: {
      ...snapshot.contextStatus,
      detail: `${snapshot.contextStatus.detail} ${guidance}`,
    },
  };
}

/**
 * Parse a binding's `repo` (a GitHub HTTPS URL or `owner/name` shorthand) into
 * `{ owner, repo }`. Returns null for non-GitHub / unparseable values, matching
 * the `isGithubRemoteBinding` boundary.
 */
function parseGithubOwnerRepo(repo: string | undefined): { owner: string; repo: string } | null {
  if (!repo) return null;
  const normalized = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(repo) ? `https://github.com/${repo}` : repo;
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") return null;
  const parts = url.pathname
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .split("/");
  if (parts.length < 2 || !parts[0] || !parts[1]) return null;
  return { owner: parts[0], repo: parts[1] };
}

/**
 * Resolve the one structured recovery action the Context tab can offer for an
 * unavailable snapshot: "the GitHub App installation can't read this repo — add
 * it to the installation."
 *
 * This is DEFINITIVE, not a heuristic: it probes the repo with the minted
 * installation token and only returns the action on a 404 from a
 * SELECTED-repositories installation — GitHub's signal that a selected-repos
 * token can't see the repo, which is exactly what adding the repo to the
 * installation fixes. It returns null — leaving the generic sync-unavailable
 * copy in place — for every other case, so the UI never sends users to GitHub
 * for a failure that adding a repo can't fix:
 *  - snapshot not unavailable (nothing to recover)
 *  - non-GitHub / local binding (`isGithubRemoteBinding` false)
 *  - no minted token (no installation / suspended / mint failed — different fixes)
 *  - an all-repositories installation: it already covers every repo in the
 *    account, so a 404 means the repo is gone / renamed / wrong-owner, not a
 *    coverage gap — adding a repo can't fix it (we skip the probe entirely)
 *  - the App CAN read the repo (so the failure is a bad branch, transient clone
 *    error, or other cause) → readable, no action
 *  - a 403 (ambiguous: rate limit, SAML enforcement, a missing permission — none
 *    fixed by adding a repo) or any transient/unknown probe error → fail toward
 *    the generic copy, never toward a misdirecting CTA
 */
export async function resolveContextTreeRecoveryAction(
  snapshot: ContextTreeSnapshot,
  binding: ContextTreeBinding,
  mintResult: ContextTreeInstallationTokenResult,
  options: MintContextTreeInstallationTokenOptions = {},
): Promise<ContextTreeRecoveryAction | null> {
  if (snapshot.snapshotStatus !== "unavailable") return null;
  if (!isGithubRemoteBinding(binding)) return null;
  if (!mintResult.ok) return null;
  // Only a selected-repositories installation can have the coverage gap this
  // action fixes. An all-repositories install already covers every repo in the
  // account, so a 404 there is gone/renamed/wrong-owner — not addable. Skip the
  // probe entirely.
  if (mintResult.repositorySelection !== "selected") return null;
  const parsed = parseGithubOwnerRepo(binding.repo);
  if (!parsed) return null;
  try {
    await getRepository(mintResult.token, parsed.owner, parsed.repo, { fetcher: options.fetcher });
    return null;
  } catch (error) {
    if (error instanceof GithubAppApiError && error.status === 404) {
      return "manage_github_app_installation";
    }
    return null;
  }
}
