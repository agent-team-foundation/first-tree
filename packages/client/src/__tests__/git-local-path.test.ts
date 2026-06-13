import { resolve, sep } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveGitRepoTargetPath } from "../runtime/git-local-path.js";

describe("resolveGitRepoTargetPath", () => {
  it("resolves safe paths under the session workspace", () => {
    const workspace = sep === "\\" ? "C:\\tmp\\workspace" : "/tmp/workspace";

    // Single-segment names only — source repos are immediate children of the
    // workspace (nested localPaths are rejected at the schema layer; the
    // runtime safety check enforces the same).
    expect(resolveGitRepoTargetPath(workspace, "first-tree")).toBe(resolve(workspace, "first-tree"));
    expect(resolveGitRepoTargetPath(workspace, "..safe")).toBe(resolve(workspace, "..safe"));
  });

  it.each([
    ".",
    "/tmp/repo",
    "../repo",
    // Clean multi-segment paths are rejected now too (single-segment only).
    "repos/first-tree",
    "repos/../repo",
    "repos//repo",
    "repos\\repo",
    "C:/repo",
  ])("rejects unsafe localPath %j", (localPath) => {
    const workspace = sep === "\\" ? "C:\\tmp\\workspace" : "/tmp/workspace";

    expect(() => resolveGitRepoTargetPath(workspace, localPath)).toThrow(/Unsafe git repo localPath/);
  });

  it("rejects a path if the final resolved target escapes the workspace", async () => {
    vi.resetModules();
    vi.doMock("node:path", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:path")>();
      return {
        ...actual,
        relative: () => "..",
      };
    });

    try {
      const fresh = await import("../runtime/git-local-path.js");
      expect(() => fresh.resolveGitRepoTargetPath("/tmp/workspace", "repo")).toThrow(/resolved path escapes/);
    } finally {
      vi.doUnmock("node:path");
      vi.resetModules();
    }
  });
});
