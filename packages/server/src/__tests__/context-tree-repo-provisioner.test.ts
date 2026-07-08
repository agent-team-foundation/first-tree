import { afterEach, describe, expect, it, vi } from "vitest";

type ProvisionerContext = Awaited<ReturnType<typeof setupProvisioner>>;

const repo = {
  name: "context-tree",
  fullName: "acme/context-tree",
  ownerLogin: "acme",
  cloneUrl: "https://github.com/acme/context-tree.git",
  htmlUrl: "https://github.com/acme/context-tree",
  private: true,
  defaultBranch: "main",
};

const organizationInstallation = {
  id: "installation-row-1",
  installationId: 123,
  accountLogin: "acme",
  accountType: "Organization" as const,
  accountGithubId: 456,
  installerGithubId: 42,
  requesterGithubId: null,
  hubOrganizationId: "org-1",
  permissions: { contents: "write" as const },
  events: [],
  suspendedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const userInstallation = {
  ...organizationInstallation,
  id: "installation-row-2",
  accountType: "User" as const,
  accountLogin: "octocat",
  accountGithubId: 42,
};

async function setupProvisioner() {
  vi.resetModules();

  class GithubAppApiError extends Error {
    constructor(
      public readonly status: number,
      message = "GitHub App API error",
    ) {
      super(message);
      this.name = "GithubAppApiError";
    }
  }

  class GithubApiError extends Error {
    constructor(
      public readonly status: number,
      message = "GitHub API error",
    ) {
      super(message);
      this.name = "GithubApiError";
    }
  }

  const createOrganizationRepo = vi.fn();
  const getRepository = vi.fn();
  const verifyUserCanAdministerInstallation = vi.fn();
  const createUserRepo = vi.fn();

  vi.doMock("../services/github-app.js", () => ({
    GithubAppApiError,
    createOrganizationRepo,
    getRepository,
    verifyUserCanAdministerInstallation,
  }));
  vi.doMock("../services/github-oauth.js", () => ({
    GithubApiError,
    createUserRepo,
  }));

  const provisioner = await import("../services/context-tree-repo-provisioner.js");
  return {
    ...provisioner,
    classes: { GithubAppApiError, GithubApiError },
    mocks: { createOrganizationRepo, getRepository, verifyUserCanAdministerInstallation, createUserRepo },
  };
}

function input(ctx: ProvisionerContext, overrides: Record<string, unknown> = {}) {
  return {
    installation: organizationInstallation,
    installationToken: "ghs_installation",
    repoName: "context-tree",
    teamName: "Acme",
    getUserToken: vi.fn(async () => ({ accessToken: "ghu_user", githubId: "42" })),
    ...overrides,
  } as unknown as Parameters<typeof ctx.ensureInstallationOwnedContextTreeRepo>[0];
}

describe("context tree repo provisioner edges", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("maps organization create and verification upstream failures to provision errors", async () => {
    const ctx = await setupProvisioner();
    ctx.mocks.createOrganizationRepo.mockRejectedValueOnce(new Error("network down"));

    await expect(ctx.ensureInstallationOwnedContextTreeRepo(input(ctx))).rejects.toMatchObject({
      statusCode: 502,
      code: "upstream",
      message: "Couldn't create the GitHub repo. Try again in a moment.",
    });

    ctx.mocks.createOrganizationRepo.mockRejectedValueOnce(new ctx.classes.GithubAppApiError(422));
    ctx.mocks.getRepository.mockRejectedValueOnce(new ctx.classes.GithubAppApiError(500));

    await expect(ctx.ensureInstallationOwnedContextTreeRepo(input(ctx))).rejects.toMatchObject({
      statusCode: 502,
      code: "upstream",
      message: "Couldn't verify the GitHub repo. Try again in a moment.",
    });
  });

  it("rejects personal repo creation when the acting user does not own the installation account", async () => {
    const ctx = await setupProvisioner();
    ctx.mocks.getRepository.mockRejectedValueOnce(new ctx.classes.GithubAppApiError(404));
    ctx.mocks.verifyUserCanAdministerInstallation.mockResolvedValueOnce(false);

    await expect(
      ctx.ensureInstallationOwnedContextTreeRepo(input(ctx, { installation: userInstallation })),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "context_tree_repo_account_mismatch",
    });
    expect(ctx.mocks.createUserRepo).not.toHaveBeenCalled();
  });

  it("maps personal repo creation conflicts, token failures, and upstream failures", async () => {
    const conflict = await setupProvisioner();
    conflict.mocks.getRepository.mockRejectedValueOnce(new conflict.classes.GithubAppApiError(404));
    conflict.mocks.verifyUserCanAdministerInstallation.mockResolvedValueOnce(true);
    conflict.mocks.createUserRepo.mockRejectedValueOnce(new conflict.classes.GithubApiError(422));

    await expect(
      conflict.ensureInstallationOwnedContextTreeRepo(input(conflict, { installation: userInstallation })),
    ).rejects.toMatchObject({ statusCode: 409, code: "context_tree_repo_access_required" });

    const denied = await setupProvisioner();
    denied.mocks.getRepository.mockRejectedValueOnce(new denied.classes.GithubAppApiError(404));
    denied.mocks.verifyUserCanAdministerInstallation.mockResolvedValueOnce(true);
    denied.mocks.createUserRepo.mockRejectedValueOnce(new denied.classes.GithubApiError(401));

    await expect(
      denied.ensureInstallationOwnedContextTreeRepo(input(denied, { installation: userInstallation })),
    ).rejects.toMatchObject({ statusCode: 403, code: "github_user_token_required" });

    const upstream = await setupProvisioner();
    upstream.mocks.getRepository.mockRejectedValueOnce(new upstream.classes.GithubAppApiError(404));
    upstream.mocks.verifyUserCanAdministerInstallation.mockResolvedValueOnce(true);
    upstream.mocks.createUserRepo.mockRejectedValueOnce(new Error("repo service down"));

    await expect(
      upstream.ensureInstallationOwnedContextTreeRepo(input(upstream, { installation: userInstallation })),
    ).rejects.toMatchObject({
      statusCode: 502,
      code: "upstream",
      message: "Couldn't create your Context Tree repo on GitHub. Try again in a moment.",
    });
  });

  it("requires installation access after personal repo creation and preserves typed provision errors", async () => {
    const missingAccess = await setupProvisioner();
    missingAccess.mocks.getRepository.mockRejectedValue(new missingAccess.classes.GithubAppApiError(404));
    missingAccess.mocks.verifyUserCanAdministerInstallation.mockResolvedValueOnce(true);
    missingAccess.mocks.createUserRepo.mockResolvedValueOnce(repo);

    await expect(
      missingAccess.ensureInstallationOwnedContextTreeRepo(input(missingAccess, { installation: userInstallation })),
    ).rejects.toMatchObject({ statusCode: 409, code: "context_tree_repo_access_required" });

    const typed = await setupProvisioner();
    typed.mocks.getRepository.mockRejectedValueOnce(new typed.classes.GithubAppApiError(404));
    typed.mocks.verifyUserCanAdministerInstallation.mockResolvedValueOnce(true);
    const expected = new typed.ContextTreeRepoProvisionError(418, "teapot", "Short and stout");
    typed.mocks.createUserRepo.mockRejectedValueOnce(expected);

    await expect(
      typed.ensureInstallationOwnedContextTreeRepo(input(typed, { installation: userInstallation })),
    ).rejects.toBe(expected);
  });

  it("returns an existing personal repo when the installation can already read it", async () => {
    const ctx = await setupProvisioner();
    ctx.mocks.getRepository.mockResolvedValueOnce(repo);

    await expect(
      ctx.ensureInstallationOwnedContextTreeRepo(input(ctx, { installation: userInstallation })),
    ).resolves.toBe(repo);
    expect(ctx.mocks.createUserRepo).not.toHaveBeenCalled();
  });
});
