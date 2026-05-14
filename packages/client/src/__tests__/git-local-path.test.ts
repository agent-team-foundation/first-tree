import { resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveGitRepoTargetPath } from "../runtime/git-local-path.js";

describe("resolveGitRepoTargetPath", () => {
  it("resolves safe paths under the session workspace", () => {
    const workspace = sep === "\\" ? "C:\\tmp\\workspace" : "/tmp/workspace";

    expect(resolveGitRepoTargetPath(workspace, "repos/first-tree")).toBe(resolve(workspace, "repos/first-tree"));
    expect(resolveGitRepoTargetPath(workspace, "..safe")).toBe(resolve(workspace, "..safe"));
  });

  it.each([
    "/tmp/repo",
    "../repo",
    "repos/../repo",
    "repos//repo",
    "repos\\repo",
    "C:/repo",
  ])("rejects unsafe localPath %j", (localPath) => {
    const workspace = sep === "\\" ? "C:\\tmp\\workspace" : "/tmp/workspace";

    expect(() => resolveGitRepoTargetPath(workspace, localPath)).toThrow(/Unsafe git repo localPath/);
  });
});
