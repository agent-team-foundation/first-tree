import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

type RouteMocks = Awaited<ReturnType<typeof setupRoute>>;

async function setupRoute() {
  vi.resetModules();

  const scope = {
    userId: "user-test",
    organizationId: "org-test",
    memberId: "member-test",
    role: "admin",
    humanAgentId: "human-test",
  };
  const installation = {
    installationId: 123456,
    accountLogin: "acme",
    accountType: "Organization",
    suspendedAt: null,
  };
  const repo = {
    ownerLogin: "acme",
    name: "acme-context-tree",
    fullName: "acme/acme-context-tree",
    cloneUrl: "https://github.com/acme/acme-context-tree.git",
    htmlUrl: "https://github.com/acme/acme-context-tree",
  };

  class ContextTreeRepoProvisionError extends Error {
    constructor(
      public readonly statusCode: number,
      public readonly code: string,
      message: string,
    ) {
      super(message);
      this.name = "ContextTreeRepoProvisionError";
    }
  }

  class GithubAppApiError extends Error {
    constructor(
      public readonly status: number,
      message = "GitHub API error",
    ) {
      super(message);
      this.name = "GithubAppApiError";
    }
  }

  class GithubUserTokenError extends Error {
    constructor(
      public readonly statusCode: 403 | 503,
      message: string,
      public readonly code?: string,
      public readonly cause?: unknown,
    ) {
      super(message);
      this.name = "GithubUserTokenError";
    }
  }

  const requireOrgAdmin = vi.fn().mockResolvedValue(scope);
  const requireOrgMembership = vi.fn().mockResolvedValue(scope);
  const findInstallationByOrg = vi.fn().mockResolvedValue(installation);
  const mintContextTreeInstallationToken = vi.fn().mockResolvedValue({
    ok: true,
    token: "ghs_test",
    permissions: { administration: "write", contents: "write", workflows: "write" },
  });
  const ensureInstallationOwnedContextTreeRepo = vi.fn().mockResolvedValue(repo);
  const getFreshGithubUserToken = vi.fn();
  const getRepoFileWithToken = vi.fn().mockResolvedValue({ path: "NODE.md" });
  const createRepoFileWithToken = vi.fn().mockResolvedValue({ content: { path: "NODE.md" } });
  const getOrgContextTreeBinding = vi.fn().mockResolvedValue(null);
  const getOrgSetting = vi.fn().mockResolvedValue({ branch: "main" });
  const putInitializedOrgContextTreeBinding = vi.fn().mockResolvedValue({ repo: repo.cloneUrl, branch: "main" });
  const getOrganization = vi.fn().mockResolvedValue({ id: scope.organizationId, name: "Acme", displayName: "Acme" });

  vi.doMock("../scope/require-org.js", () => ({ requireOrgAdmin, requireOrgMembership }));
  vi.doMock("../services/context-tree-repo-provisioner.js", () => ({
    ContextTreeRepoProvisionError,
    ensureInstallationOwnedContextTreeRepo,
  }));
  vi.doMock("../services/github-app.js", () => ({
    GithubAppApiError,
    createRepoFileWithToken,
    getRepoFileWithToken,
  }));
  vi.doMock("../services/github-app-installations.js", () => ({ findInstallationByOrg }));
  vi.doMock("../services/github-app-token.js", () => ({ mintContextTreeInstallationToken }));
  vi.doMock("../services/github-user-token.js", () => ({ GithubUserTokenError, getFreshGithubUserToken }));
  vi.doMock("../services/org-settings.js", () => ({
    getOrgContextTreeBinding,
    getOrgSetting,
    putInitializedOrgContextTreeBinding,
  }));
  vi.doMock("../services/organization.js", () => ({ getOrganization }));

  const { orgContextTreeRoutes } = await import("../api/orgs/context-tree.js");
  const app = Object.assign(Fastify(), {
    db: {},
    config: {
      oauth: { githubApp: {} },
      secrets: { encryptionKey: "test-key" },
    },
  });
  await app.register(orgContextTreeRoutes);
  await app.ready();

  return {
    app,
    scope,
    installation,
    repo,
    classes: { ContextTreeRepoProvisionError, GithubAppApiError, GithubUserTokenError },
    mocks: {
      requireOrgAdmin,
      requireOrgMembership,
      findInstallationByOrg,
      mintContextTreeInstallationToken,
      ensureInstallationOwnedContextTreeRepo,
      getFreshGithubUserToken,
      getRepoFileWithToken,
      createRepoFileWithToken,
      getOrgContextTreeBinding,
      getOrgSetting,
      putInitializedOrgContextTreeBinding,
      getOrganization,
    },
  };
}

describe("org context tree routes with mocked service edges", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  async function initialize(ctx: RouteMocks) {
    return ctx.app.inject({ method: "POST", url: "/initialize", payload: {} });
  }

  it("returns no_installation when minting unexpectedly succeeds without an installation row", async () => {
    const ctx = await setupRoute();
    ctx.mocks.findInstallationByOrg.mockResolvedValueOnce(null);

    const res = await initialize(ctx);

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({
      error: "No GitHub App installation is connected for this team yet.",
      code: "no_installation",
    });
    expect(ctx.mocks.ensureInstallationOwnedContextTreeRepo).not.toHaveBeenCalled();
  });

  it("maps typed repo provision failures to their status and code", async () => {
    const ctx = await setupRoute();
    ctx.mocks.ensureInstallationOwnedContextTreeRepo.mockRejectedValueOnce(
      new ctx.classes.ContextTreeRepoProvisionError(409, "repo_unavailable", "Repo unavailable"),
    );

    const res = await initialize(ctx);

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "Repo unavailable", code: "repo_unavailable" });
    expect(ctx.mocks.createRepoFileWithToken).not.toHaveBeenCalled();
  });

  it("maps missing GitHub user token errors before writing repo files", async () => {
    const ctx = await setupRoute();
    ctx.mocks.ensureInstallationOwnedContextTreeRepo.mockRejectedValueOnce(
      new ctx.classes.GithubUserTokenError(503, "Reconnect GitHub"),
    );

    const res = await initialize(ctx);

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "Reconnect GitHub", code: "github_user_token_required" });
    expect(ctx.mocks.createRepoFileWithToken).not.toHaveBeenCalled();
  });

  it("rethrows unexpected provision failures as a server error", async () => {
    const ctx = await setupRoute();
    ctx.mocks.ensureInstallationOwnedContextTreeRepo.mockRejectedValueOnce(new Error("provision exploded"));

    const res = await initialize(ctx);

    expect(res.statusCode).toBe(500);
    expect(res.json<{ error: string }>().error).toBe("Internal Server Error");
  });

  it("reports repo_unavailable when conflict verification loses repository access", async () => {
    const ctx = await setupRoute();
    ctx.mocks.getRepoFileWithToken
      .mockRejectedValueOnce(new ctx.classes.GithubAppApiError(404))
      .mockRejectedValueOnce(new ctx.classes.GithubAppApiError(403));
    ctx.mocks.createRepoFileWithToken.mockRejectedValueOnce(new ctx.classes.GithubAppApiError(409));

    const res = await initialize(ctx);

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: "GitHub repo acme/acme-context-tree is not accessible to this team's GitHub App installation.",
      code: "repo_unavailable",
    });
    expect(ctx.mocks.getRepoFileWithToken).toHaveBeenCalledTimes(2);
  });

  it("maps root node verification failures to an upstream initialize error", async () => {
    const ctx = await setupRoute();
    ctx.mocks.getRepoFileWithToken.mockRejectedValueOnce(new Error("github timeout"));

    const res = await initialize(ctx);

    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({
      error: "Couldn't verify the Context Tree root node. Try again in a moment.",
      code: "upstream",
    });
    expect(ctx.mocks.createRepoFileWithToken).not.toHaveBeenCalled();
    expect(ctx.mocks.putInitializedOrgContextTreeBinding).not.toHaveBeenCalled();
  });

  it("maps unexpected root node create failures to an upstream initialize error", async () => {
    const ctx = await setupRoute();
    ctx.mocks.getRepoFileWithToken.mockRejectedValueOnce(new ctx.classes.GithubAppApiError(404));
    ctx.mocks.createRepoFileWithToken.mockRejectedValueOnce(new Error("create root exploded"));

    const res = await initialize(ctx);

    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({
      error: "Couldn't initialize the Context Tree root node. Try again in a moment.",
      code: "upstream",
    });
    expect(ctx.mocks.putInitializedOrgContextTreeBinding).not.toHaveBeenCalled();
  });

  it("maps workflow verification failures after root success", async () => {
    const ctx = await setupRoute();
    ctx.mocks.getRepoFileWithToken
      .mockResolvedValueOnce({ path: "NODE.md" })
      .mockRejectedValueOnce(new Error("github timeout"));

    const res = await initialize(ctx);

    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({
      error: "Couldn't verify the Context Tree validation workflow. Try again in a moment.",
      code: "upstream",
    });
    expect(ctx.mocks.putInitializedOrgContextTreeBinding).not.toHaveBeenCalled();
  });

  it("maps unexpected workflow create failures to an upstream initialize error", async () => {
    const ctx = await setupRoute();
    ctx.mocks.getRepoFileWithToken
      .mockResolvedValueOnce({ path: "NODE.md" })
      .mockRejectedValueOnce(new ctx.classes.GithubAppApiError(404));
    ctx.mocks.createRepoFileWithToken.mockRejectedValueOnce(new Error("create workflow exploded"));

    const res = await initialize(ctx);

    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({
      error: "Couldn't initialize the Context Tree validation workflow. Try again in a moment.",
      code: "upstream",
    });
    expect(ctx.mocks.putInitializedOrgContextTreeBinding).not.toHaveBeenCalled();
  });

  it("maps workflow conflict verification failures to the existing-file upstream error", async () => {
    const ctx = await setupRoute();
    ctx.mocks.getRepoFileWithToken
      .mockResolvedValueOnce({ path: "NODE.md" })
      .mockRejectedValueOnce(new ctx.classes.GithubAppApiError(404))
      .mockRejectedValueOnce(new Error("github timeout"));
    ctx.mocks.createRepoFileWithToken.mockRejectedValueOnce(new ctx.classes.GithubAppApiError(422));

    const res = await initialize(ctx);

    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({
      error: "Couldn't verify the existing Context Tree validation workflow. Try again in a moment.",
      code: "upstream",
    });
    expect(ctx.mocks.getRepoFileWithToken).toHaveBeenCalledTimes(3);
    expect(ctx.mocks.putInitializedOrgContextTreeBinding).not.toHaveBeenCalled();
  });

  it("initializes missing root and workflow files before saving the org setting", async () => {
    const ctx = await setupRoute();
    ctx.mocks.getOrganization.mockResolvedValueOnce({
      id: ctx.scope.organizationId,
      name: "fallback-name",
      displayName: "  Àcme   Research Team  ",
    });
    ctx.mocks.getRepoFileWithToken
      .mockRejectedValueOnce(new ctx.classes.GithubAppApiError(404))
      .mockRejectedValueOnce(new ctx.classes.GithubAppApiError(404));

    const res = await initialize(ctx);

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      repo: ctx.repo.cloneUrl,
      htmlUrl: ctx.repo.htmlUrl,
      branch: "main",
      nodePath: "NODE.md",
    });
    expect(ctx.mocks.ensureInstallationOwnedContextTreeRepo).toHaveBeenCalledWith(
      expect.objectContaining({ repoName: "acme-research-team-context-tree", teamName: "Àcme Research Team" }),
    );
    expect(ctx.mocks.createRepoFileWithToken).toHaveBeenCalledTimes(2);
    expect(ctx.mocks.createRepoFileWithToken).toHaveBeenNthCalledWith(
      1,
      "ghs_test",
      expect.objectContaining({
        path: "NODE.md",
        message: "Initialize Context Tree root node",
      }),
    );
    expect(ctx.mocks.createRepoFileWithToken).toHaveBeenNthCalledWith(
      2,
      "ghs_test",
      expect.objectContaining({
        path: ".github/workflows/validate-tree.yml",
        message: "Initialize Context Tree validation workflow",
      }),
    );
    expect(ctx.mocks.putInitializedOrgContextTreeBinding).toHaveBeenCalledWith(
      ctx.app.db,
      ctx.scope.organizationId,
      { repo: ctx.repo.cloneUrl, branch: "main" },
      { updatedBy: ctx.scope.userId },
    );
  });
});
