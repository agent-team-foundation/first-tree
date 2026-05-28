import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import type { MockInstance } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runGitHubScanMock = vi.fn<(args: string[]) => Promise<number | undefined>>();

async function runScan(args: string[]): Promise<void> {
  const { githubScanCommand } = await import("../commands/github/scan.js");
  const github = new Command("github");
  github.exitOverride();
  githubScanCommand.register(github);
  await github.parseAsync(["node", "test", "scan", ...args]);
}

describe("github scan command wrapper", () => {
  let tmp: string;
  let originalCwd: string;
  let originalTreeRepo: string | undefined;
  let stderrSpy: MockInstance<typeof process.stderr.write>;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    tmp = mkdtempSync(join(tmpdir(), "first-tree-github-scan-command-"));
    originalCwd = process.cwd();
    originalTreeRepo = process.env.FIRST_TREE_GITHUB_SCAN_TREE_REPO;
    delete process.env.FIRST_TREE_GITHUB_SCAN_TREE_REPO;
    process.exitCode = undefined;
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    runGitHubScanMock.mockResolvedValue(0);
    vi.doMock("../../../../packages/github-scan/src/index.js", () => ({ runGitHubScan: runGitHubScanMock }));
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    process.chdir(originalCwd);
    if (originalTreeRepo === undefined) delete process.env.FIRST_TREE_GITHUB_SCAN_TREE_REPO;
    else process.env.FIRST_TREE_GITHUB_SCAN_TREE_REPO = originalTreeRepo;
    process.exitCode = undefined;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("forwards explicit tree repo flags through the environment and restores prior state", async () => {
    process.env.FIRST_TREE_GITHUB_SCAN_TREE_REPO = "owner/previous";
    runGitHubScanMock.mockResolvedValueOnce(7);

    await runScan(["poll", "--tree-repo", "owner/tree", "--allow-repo", "owner/source"]);

    expect(runGitHubScanMock).toHaveBeenCalledWith(["poll", "--allow-repo", "owner/source"]);
    expect(process.exitCode).toBe(7);
    expect(process.env.FIRST_TREE_GITHUB_SCAN_TREE_REPO).toBe("owner/previous");
  });

  it("uses bound source metadata for commands that require a tree repo", async () => {
    const repo = join(tmp, "repo", "nested");
    mkdirSync(join(repo, ".first-tree"), { recursive: true });
    writeFileSync(
      join(repo, ".first-tree", "source.json"),
      JSON.stringify({ tree: { remoteUrl: "git@github.com:agent-team-foundation/first-tree-context.git" } }),
    );
    process.chdir(join(repo, ".first-tree"));

    await runScan(["start", "--verbose"]);

    expect(runGitHubScanMock).toHaveBeenCalledWith(["start", "--verbose"]);
    expect(process.env.FIRST_TREE_GITHUB_SCAN_TREE_REPO).toBeUndefined();
  });

  it("reports parse errors and missing bindings before running the scan", async () => {
    await runScan(["poll", "--tree-repo"]);
    expect(process.exitCode).toBe(1);
    expect(stderrSpy.mock.calls.flat().join("")).toContain("missing value");
    expect(runGitHubScanMock).not.toHaveBeenCalled();

    process.exitCode = undefined;
    stderrSpy.mockClear();
    process.chdir(tmp);
    await runScan(["poll"]);

    expect(process.exitCode).toBe(1);
    expect(stderrSpy.mock.calls.flat().join("")).toContain("requires a bound tree repo");
    expect(runGitHubScanMock).not.toHaveBeenCalled();
  });
});
