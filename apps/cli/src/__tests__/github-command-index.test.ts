import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import type { MockInstance } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runGitHubScanMock = vi.fn<(args: string[]) => Promise<number | undefined>>();

async function runGithub(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const { registerGithubCommands } = await import("../commands/github/index.js");
  let stdout = "";
  let stderr = "";
  const program = new Command("first-tree");
  program.exitOverride();
  program.configureOutput({
    writeOut: (chunk) => {
      stdout += chunk;
    },
    writeErr: (chunk) => {
      stderr += chunk;
    },
  });
  registerGithubCommands(program);
  await program.parseAsync(["node", "test", ...args], { from: "node" }).catch(() => undefined);
  return { stdout, stderr };
}

describe("github command registration", () => {
  let tmp: string;
  let originalCwd: string;
  let originalTreeRepo: string | undefined;
  let consoleErrorSpy: MockInstance<typeof console.error>;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    tmp = mkdtempSync(join(tmpdir(), "first-tree-github-command-index-"));
    originalCwd = process.cwd();
    originalTreeRepo = process.env.FIRST_TREE_GITHUB_SCAN_TREE_REPO;
    delete process.env.FIRST_TREE_GITHUB_SCAN_TREE_REPO;
    process.exitCode = undefined;
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    runGitHubScanMock.mockResolvedValue(0);
    vi.doMock("@first-tree/github-scan", () => ({ runGitHubScan: runGitHubScanMock }));
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    process.chdir(originalCwd);
    if (originalTreeRepo === undefined) delete process.env.FIRST_TREE_GITHUB_SCAN_TREE_REPO;
    else process.env.FIRST_TREE_GITHUB_SCAN_TREE_REPO = originalTreeRepo;
    process.exitCode = undefined;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("prints parent help when no github subcommand is provided", async () => {
    const { stdout } = await runGithub(["github"]);
    expect(stdout).toContain("Work with GitHub automation commands.");
    expect(runGitHubScanMock).not.toHaveBeenCalled();
  });

  it("routes unknown github subcommands through Commander's unknown command path", async () => {
    const { stderr } = await runGithub(["github", "unknown"]);
    expect(stderr).toContain("unknown command");
    expect(runGitHubScanMock).not.toHaveBeenCalled();
  });

  it("sets and restores tree repo env while propagating scan exit codes", async () => {
    process.env.FIRST_TREE_GITHUB_SCAN_TREE_REPO = "owner/previous";
    runGitHubScanMock.mockResolvedValueOnce(5);

    await runGithub(["github", "scan", "poll", "--tree-repo", "owner/tree", "--allow-repo", "owner/source"]);

    expect(runGitHubScanMock).toHaveBeenCalledWith(["poll", "--allow-repo", "owner/source"]);
    expect(process.exitCode).toBe(5);
    expect(process.env.FIRST_TREE_GITHUB_SCAN_TREE_REPO).toBe("owner/previous");
  });

  it("does not resolve bindings for help requests", async () => {
    await runGithub(["github", "scan", "--help"]);
    expect(runGitHubScanMock).toHaveBeenCalledWith(["--help"]);
    expect(process.exitCode).toBeUndefined();
  });

  it("fails before importing the scan runner when a required binding is missing", async () => {
    process.chdir(tmp);
    await runGithub(["github", "scan", "poll"]);

    expect(process.exitCode).toBe(1);
    expect(consoleErrorSpy.mock.calls.flat().join("")).toContain("requires a bound tree repo");
    expect(runGitHubScanMock).not.toHaveBeenCalled();
  });
});
