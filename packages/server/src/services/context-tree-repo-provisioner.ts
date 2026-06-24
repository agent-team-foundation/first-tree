import {
  createOrganizationRepo,
  GithubAppApiError,
  getRepository,
  verifyUserCanAdministerInstallation,
} from "./github-app.js";
import type { InstallationRow } from "./github-app-installations.js";
import { createUserRepo, GithubApiError, type GithubCreatedRepo } from "./github-oauth.js";
import type { GithubUserToken } from "./github-user-token.js";

/**
 * Owner-agnostic Context Tree repo provisioner.
 *
 * The First Tree-side binding is always `First Tree org -> context_tree repo`;
 * the GitHub repo is only the storage backend, and its owner may be a GitHub
 * `Organization` OR a personal `User`. This module is the single seam where the
 * owner-type branching lives, so the route and the rest of onboarding stay
 * owner-agnostic and reason purely about `owner/name` + live installation
 * capability rather than account type.
 *
 * GitHub API constraint that forces the split: an organization repo can be
 * created with the App *installation* token (`POST /orgs/{org}/repos`), but a
 * personal repo can only be created with the App *user* token
 * (`POST /user/repos`) — the installation token has no authority to create a
 * repo under a user account. After a personal repo is created we re-check with
 * the installation token, because the App can only read/write the new repo once
 * it has been granted access (always true for an "all repositories" install, but
 * a "selected repositories" install must add the freshly-created repo first).
 */

export class ContextTreeRepoProvisionError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ContextTreeRepoProvisionError";
  }
}

export type EnsureContextTreeRepoInput = {
  installation: InstallationRow;
  installationToken: string;
  repoName: string;
  teamName: string;
  /**
   * Lazily resolve the acting admin's GitHub App user token. Only invoked on the
   * personal (User) create path: adopting an already-accessible repo, and the
   * entire Organization path, never need it — so an admin without a usable GitHub
   * token can still adopt an existing tree.
   */
  getUserToken: () => Promise<GithubUserToken>;
};

export async function ensureInstallationOwnedContextTreeRepo(
  input: EnsureContextTreeRepoInput,
): Promise<GithubCreatedRepo> {
  if (input.installation.accountType === "Organization") {
    return ensureOrganizationRepo(input);
  }
  return ensureUserRepo(input);
}

/**
 * Organization storage backend — unchanged from the original org-only path:
 * optimistically create with the installation token, fall back to adopting the
 * deterministic repo on `422 already exists`, and persist only if the
 * installation can actually read it.
 */
async function ensureOrganizationRepo(input: EnsureContextTreeRepoInput): Promise<GithubCreatedRepo> {
  const { installationToken, installation, repoName, teamName } = input;
  try {
    const created = await createOrganizationRepo(installationToken, {
      org: installation.accountLogin,
      name: repoName,
      private: true,
      description: contextTreeRepoDescription(teamName),
    });
    return await verifyInstallationCanAccess(installationToken, created.ownerLogin, created.name);
  } catch (err) {
    if (err instanceof GithubAppApiError && err.status === 422) {
      return await verifyInstallationCanAccess(installationToken, installation.accountLogin, repoName);
    }
    if (err instanceof GithubAppApiError && isInstallationAccessError(err)) {
      throw repoUnavailableError(installation.accountLogin, repoName);
    }
    throw mapUpstreamError(err, "Couldn't create the GitHub repo. Try again in a moment.");
  }
}

/**
 * Personal (User) storage backend. Adopt first with the installation token;
 * when the repo is missing, create it with the user token, then re-verify that
 * the installation can reach the freshly-created repo before persisting.
 */
async function ensureUserRepo(input: EnsureContextTreeRepoInput): Promise<GithubCreatedRepo> {
  const { installationToken, installation, repoName, teamName } = input;

  // 1. Adopt: if the installation can already read the deterministic repo, use it.
  const existing = await probeInstallationAccess(installationToken, installation.accountLogin, repoName);
  if (existing) {
    return existing;
  }

  // 2. Create under the user account. `POST /user/repos` creates the repo under
  //    the *token owner*, so the acting admin must own the installation account
  //    — otherwise the repo lands in the wrong account and this installation
  //    could never reach it. Enforce that with the same authority rule the
  //    install-time bind uses (a User installation short-circuits to a pure
  //    GitHub-ID equality check, no extra API call).
  const userToken = await input.getUserToken();
  const ownsInstallationAccount = await verifyUserCanAdministerInstallation(
    userToken.accessToken,
    Number(userToken.githubId),
    installation,
  );
  if (!ownsInstallationAccount) {
    throw new ContextTreeRepoProvisionError(
      409,
      "context_tree_repo_account_mismatch",
      `Your Context Tree repo must be created by the GitHub account that installed First Tree (@${installation.accountLogin}). Sign in as that account, or install First Tree on a GitHub organization.`,
    );
  }

  try {
    await createUserRepo(userToken.accessToken, {
      name: repoName,
      private: true,
      description: contextTreeRepoDescription(teamName),
    });
  } catch (err) {
    if (err instanceof GithubApiError && err.status === 422) {
      // The repo already exists but the installation couldn't see it at step 1,
      // so the App still needs to be granted access to it.
      throw repoAccessRequiredError(installation.accountLogin, repoName);
    }
    if (err instanceof GithubApiError && (err.status === 401 || err.status === 403)) {
      throw new ContextTreeRepoProvisionError(
        403,
        "github_user_token_required",
        "GitHub wouldn't let First Tree create your Context Tree repo with the current authorization. Reconnect GitHub, then try again.",
      );
    }
    throw mapUpstreamError(err, "Couldn't create your Context Tree repo on GitHub. Try again in a moment.");
  }

  // 3. The App can only read/write the new repo once it has been granted access
  //    (a "selected repositories" install does not auto-include a new repo).
  const created = await probeInstallationAccess(installationToken, installation.accountLogin, repoName);
  if (!created) {
    throw repoAccessRequiredError(installation.accountLogin, repoName);
  }
  return created;
}

/** Read the repo with the installation token; throw `repo_unavailable` if the App can't reach it. */
async function verifyInstallationCanAccess(
  installationToken: string,
  owner: string,
  repoName: string,
): Promise<GithubCreatedRepo> {
  try {
    return await getRepository(installationToken, owner, repoName);
  } catch (err) {
    if (err instanceof GithubAppApiError && isInstallationAccessError(err)) {
      throw repoUnavailableError(owner, repoName);
    }
    throw mapUpstreamError(err, "Couldn't verify the GitHub repo. Try again in a moment.");
  }
}

/**
 * Read the repo with the installation token; return `null` when the App simply
 * can't see it (403/404) so the caller can decide whether that means "create it"
 * (adopt probe) or "grant access and retry" (post-create verify). Other failures
 * (5xx / auth) surface as upstream errors.
 */
async function probeInstallationAccess(
  installationToken: string,
  owner: string,
  repoName: string,
): Promise<GithubCreatedRepo | null> {
  try {
    return await getRepository(installationToken, owner, repoName);
  } catch (err) {
    if (err instanceof GithubAppApiError && isInstallationAccessError(err)) {
      return null;
    }
    throw mapUpstreamError(err, "Couldn't reach GitHub to check your Context Tree repo. Try again in a moment.");
  }
}

function isInstallationAccessError(err: GithubAppApiError): boolean {
  return err.status === 403 || err.status === 404;
}

function repoUnavailableError(owner: string, repoName: string): ContextTreeRepoProvisionError {
  return new ContextTreeRepoProvisionError(
    409,
    "repo_unavailable",
    `GitHub repo ${owner}/${repoName} is not accessible to this team's GitHub App installation.`,
  );
}

function repoAccessRequiredError(owner: string, repoName: string): ContextTreeRepoProvisionError {
  return new ContextTreeRepoProvisionError(
    409,
    "context_tree_repo_access_required",
    `GitHub repo ${owner}/${repoName} exists, but First Tree's GitHub App can't access it yet. Grant the App access to the repo on GitHub, then try again.`,
  );
}

function mapUpstreamError(err: unknown, message: string): ContextTreeRepoProvisionError {
  if (err instanceof ContextTreeRepoProvisionError) {
    return err;
  }
  return new ContextTreeRepoProvisionError(502, "upstream", message);
}

function contextTreeRepoDescription(teamName: string): string {
  return `${teamName} Context Tree`;
}
