import type { ContextTreeSnapshot } from "@first-tree/shared";
import { type ContextTreeBinding, isGithubRemoteBinding } from "./context-tree-snapshot.js";
import { createAppJwt, GithubAppApiError, type GithubAppCredentials, mintInstallationToken } from "./github-app.js";
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
  | { ok: true; token: string }
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
    return { ok: true, token: minted.token };
  } catch (error) {
    const detail =
      error instanceof GithubAppApiError
        ? `GitHub returned ${error.status} when minting an installation token.`
        : "Hub could not mint a GitHub App installation token.";
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
        : `Hub could not mint a GitHub App installation token.${mintResult.detail ? ` ${mintResult.detail}` : ""}`;

  return {
    ...snapshot,
    contextStatus: {
      ...snapshot.contextStatus,
      detail: `${snapshot.contextStatus.detail} ${guidance}`,
    },
  };
}
