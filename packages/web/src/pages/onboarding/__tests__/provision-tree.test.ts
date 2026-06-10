import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  initializeContextTree: vi.fn(),
  getContextTreeSetting: vi.fn(),
}));
vi.mock("../../../api/context-tree.js", () => ({ initializeContextTree: mocks.initializeContextTree }));
vi.mock("../../../api/org-settings.js", () => ({ getContextTreeSetting: mocks.getContextTreeSetting }));

import { ApiError } from "../../../api/client.js";
import { provisionNewTree } from "../provision-tree.js";

const CREATED = {
  repo: "https://github.com/acme/acme-context-tree",
  htmlUrl: "https://github.com/acme/acme-context-tree",
  branch: "main",
  nodePath: "NODE.md",
};

describe("provisionNewTree", () => {
  beforeEach(() => {
    mocks.initializeContextTree.mockReset();
    mocks.getContextTreeSetting.mockReset();
  });

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
