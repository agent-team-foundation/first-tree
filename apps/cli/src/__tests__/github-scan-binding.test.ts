import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isGitHubScanHelpRequest,
  readTreeRepoArg,
  requiresGitHubScanBinding,
  resolveGitHubScanBinding,
  stripTreeRepoArg,
} from "../commands/github/scan-binding.js";

describe("github scan binding argument helpers", () => {
  let tmp: string;
  let originalCwd: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "first-tree-github-scan-binding-"));
    originalCwd = process.cwd();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tmp, { recursive: true, force: true });
  });

  it("detects help and binding-required subcommands", () => {
    expect(isGitHubScanHelpRequest([])).toBe(true);
    expect(isGitHubScanHelpRequest(["poll", "--help"])).toBe(true);
    expect(isGitHubScanHelpRequest(["status"])).toBe(false);
    expect(requiresGitHubScanBinding("poll")).toBe(true);
    expect(requiresGitHubScanBinding("status")).toBe(false);
  });

  it("reads, validates, and strips explicit tree repo flags", () => {
    expect(readTreeRepoArg(["poll", "--tree-repo", "owner/tree", "--allow-repo", "owner/source"])).toBe("owner/tree");
    expect(readTreeRepoArg(["poll", "--tree-repo=owner/tree"])).toBe("owner/tree");
    expect(stripTreeRepoArg(["poll", "--tree-repo", "owner/tree", "--allow-repo", "owner/source"])).toEqual([
      "poll",
      "--allow-repo",
      "owner/source",
    ]);
    expect(stripTreeRepoArg(["poll", "--tree-repo=owner/tree"])).toEqual(["poll"]);
    expect(resolveGitHubScanBinding(["poll", "--tree-repo", "bad"])).toEqual({
      ok: false,
      error:
        "Invalid `--tree-repo` value. Expected `owner/repo`, for example `agent-team-foundation/first-tree-context`.",
    });
    expect(resolveGitHubScanBinding(["poll", "--tree-repo", "owner/tree"])).toEqual({
      ok: true,
      source: "flag",
      treeRepo: "owner/tree",
    });
  });

  it("resolves legacy .first-tree/source.json metadata upward from cwd", () => {
    const nested = join(tmp, "repo", "packages", "web");
    const firstTreeDir = join(tmp, "repo", ".first-tree");
    rmSync(join(tmp, "repo"), { recursive: true, force: true });
    writeFileSync(join(tmp, "repo-placeholder"), "");
    rmSync(join(tmp, "repo-placeholder"), { force: true });
    mkdirSync(nested, { recursive: true });
    mkdirSync(firstTreeDir, { recursive: true });
    writeFileSync(
      join(firstTreeDir, "source.json"),
      JSON.stringify({ tree: { remoteUrl: "https://github.com/agent-team-foundation/first-tree-context.git" } }),
    );

    process.chdir(nested);

    expect(resolveGitHubScanBinding(["poll"])).toEqual({
      ok: true,
      source: "source-state",
      treeRepo: "agent-team-foundation/first-tree-context",
      sourceStatePath: join(firstTreeDir, "source.json"),
    });
  });

  it("returns the migration message when no binding metadata exists", () => {
    process.chdir(tmp);
    const result = resolveGitHubScanBinding(["poll"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("requires a bound tree repo");
      expect(result.error).toContain("first-tree tree bind");
    }
  });
});
