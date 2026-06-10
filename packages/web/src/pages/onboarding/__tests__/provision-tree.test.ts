import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  initializeContextTree: vi.fn(),
  getContextTreeSetting: vi.fn(),
  createTeamResourceForOrg: vi.fn(),
  listTeamResourcesForOrg: vi.fn(),
}));
vi.mock("../../../api/context-tree.js", () => ({ initializeContextTree: mocks.initializeContextTree }));
vi.mock("../../../api/org-settings.js", () => ({ getContextTreeSetting: mocks.getContextTreeSetting }));
vi.mock("../../../api/resources.js", () => ({
  createTeamResourceForOrg: mocks.createTeamResourceForOrg,
  listTeamResourcesForOrg: mocks.listTeamResourcesForOrg,
}));

import { ApiError } from "../../../api/client.js";
import { ensureSourceReposRegistered, provisionNewTree, repoLabel } from "../provision-tree.js";

const CREATED = {
  repo: "https://github.com/acme/acme-context-tree",
  htmlUrl: "https://github.com/acme/acme-context-tree",
  branch: "main",
  nodePath: "NODE.md",
};

const recommendedRepo = (url: string) => ({ type: "repo", defaultEnabled: "recommended", payload: { url } });

beforeEach(() => {
  mocks.initializeContextTree.mockReset();
  mocks.getContextTreeSetting.mockReset();
  mocks.createTeamResourceForOrg.mockReset();
  mocks.listTeamResourcesForOrg.mockReset();
});

describe("provisionNewTree", () => {
  it("initializes and does not probe binding state on success", async () => {
    mocks.initializeContextTree.mockResolvedValue(CREATED);
    await provisionNewTree("org-1");
    expect(mocks.initializeContextTree).toHaveBeenCalledWith("org-1");
    expect(mocks.getContextTreeSetting).not.toHaveBeenCalled();
  });

  it("treats a 409 as success when a tree binding now exists (detect→create race / retry)", async () => {
    mocks.initializeContextTree.mockRejectedValue(
      new ApiError(409, "Context Tree repo is already configured for this team"),
    );
    mocks.getContextTreeSetting.mockResolvedValue({
      repo: "https://github.com/acme/acme-context-tree",
      branch: "main",
    });
    await expect(provisionNewTree("org-1")).resolves.toBeUndefined();
  });

  it("re-throws a 409 when no tree was created (e.g. org installation required)", async () => {
    mocks.initializeContextTree.mockRejectedValue(new ApiError(409, "requires a GitHub organization installation"));
    mocks.getContextTreeSetting.mockResolvedValue({ repo: null, branch: null });
    await expect(provisionNewTree("org-1")).rejects.toBeInstanceOf(ApiError);
  });

  it("re-throws a non-409 error without probing binding state", async () => {
    mocks.initializeContextTree.mockRejectedValue(new ApiError(403, "installation permissions insufficient"));
    await expect(provisionNewTree("org-1")).rejects.toBeInstanceOf(ApiError);
    expect(mocks.getContextTreeSetting).not.toHaveBeenCalled();
  });
});

describe("ensureSourceReposRegistered", () => {
  it("is a no-op for an empty repo list", async () => {
    await ensureSourceReposRegistered("org-1", []);
    expect(mocks.createTeamResourceForOrg).not.toHaveBeenCalled();
    expect(mocks.listTeamResourcesForOrg).not.toHaveBeenCalled();
  });

  it("creates each repo resource and resolves when all are registered", async () => {
    mocks.createTeamResourceForOrg.mockResolvedValue({});
    mocks.listTeamResourcesForOrg.mockResolvedValue([
      recommendedRepo("https://github.com/acme/app"),
      recommendedRepo("https://github.com/acme/api"),
    ]);
    await ensureSourceReposRegistered("org-1", ["https://github.com/acme/app", "https://github.com/acme/api"]);
    expect(mocks.createTeamResourceForOrg).toHaveBeenCalledTimes(2);
  });

  it("resolves when creation fails as a duplicate but the resource exists (re-run)", async () => {
    mocks.createTeamResourceForOrg.mockRejectedValue(new ApiError(409, "A matching resource already exists"));
    mocks.listTeamResourcesForOrg.mockResolvedValue([recommendedRepo("https://github.com/acme/app")]);
    await expect(ensureSourceReposRegistered("org-1", ["https://github.com/acme/app"])).resolves.toBeUndefined();
  });

  it("throws when a selected repo is NOT registered after creation (genuine write failure)", async () => {
    mocks.createTeamResourceForOrg.mockRejectedValue(new ApiError(500, "server error"));
    mocks.listTeamResourcesForOrg.mockResolvedValue([]); // nothing registered
    await expect(ensureSourceReposRegistered("org-1", ["https://github.com/acme/app"])).rejects.toThrow(
      /couldn't register/i,
    );
  });

  it("matches registered repos canonically (protocol / case / .git insensitive)", async () => {
    mocks.createTeamResourceForOrg.mockResolvedValue({});
    mocks.listTeamResourcesForOrg.mockResolvedValue([recommendedRepo("https://github.com/Acme/App.git")]);
    await expect(ensureSourceReposRegistered("org-1", ["https://github.com/acme/app"])).resolves.toBeUndefined();
  });

  it("matches an existing ssh:// resource against a selected HTTPS clone URL", async () => {
    // The duplicate create 409s (server canonicalizes ssh/https to the same
    // key); the verify must use that same canonicalization, not a weaker label.
    mocks.createTeamResourceForOrg.mockRejectedValue(new ApiError(409, "A matching resource already exists"));
    mocks.listTeamResourcesForOrg.mockResolvedValue([recommendedRepo("ssh://git@github.com/acme/app.git")]);
    await expect(ensureSourceReposRegistered("org-1", ["https://github.com/acme/app"])).resolves.toBeUndefined();
  });

  it("matches an existing scp-form resource against a selected HTTPS clone URL", async () => {
    mocks.createTeamResourceForOrg.mockRejectedValue(new ApiError(409, "A matching resource already exists"));
    mocks.listTeamResourcesForOrg.mockResolvedValue([recommendedRepo("git@github.com:acme/app.git")]);
    await expect(ensureSourceReposRegistered("org-1", ["https://github.com/acme/app"])).resolves.toBeUndefined();
  });

  it("throws listing all repos still missing", async () => {
    mocks.createTeamResourceForOrg.mockResolvedValue({});
    mocks.listTeamResourcesForOrg.mockResolvedValue([recommendedRepo("https://github.com/acme/app")]);
    await expect(
      ensureSourceReposRegistered("org-1", ["https://github.com/acme/app", "https://github.com/acme/api"]),
    ).rejects.toThrow(/acme\/api/);
  });
});

describe("repoLabel", () => {
  it("reduces a repo URL to its owner/name path", () => {
    expect(repoLabel("https://github.com/acme/app.git")).toBe("acme/app");
    expect(repoLabel("git@github.com:acme/api.git")).toBe("acme/api");
  });
});
