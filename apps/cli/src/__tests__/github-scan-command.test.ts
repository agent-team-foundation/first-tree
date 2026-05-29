import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runGitHubScanMock = vi.hoisted(() => vi.fn());
const stderrMock = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
const consoleErrorMock = vi.spyOn(console, "error").mockImplementation(() => undefined);

vi.mock("../../../../packages/github-scan/src/index.js", () => ({
  runGitHubScan: runGitHubScanMock,
}));

const originalCwd = process.cwd();
const originalTreeRepoEnv = process.env.FIRST_TREE_GITHUB_SCAN_TREE_REPO;

let tempDir: string;

async function runScan(args: string[], cwd = tempDir): Promise<void> {
  process.chdir(cwd);
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeErr: (value) => process.stderr.write(value) });
  const { registerGithubCommands } = await import("../commands/github/index.js");
  registerGithubCommands(program);
  await program.parseAsync(["github", "scan", ...args], { from: "user" });
}

beforeEach(() => {
  vi.resetModules();
  tempDir = join(tmpdir(), `ft-github-scan-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempDir, { recursive: true });
  runGitHubScanMock.mockReset();
  stderrMock.mockClear();
  consoleErrorMock.mockClear();
  delete process.env.FIRST_TREE_GITHUB_SCAN_TREE_REPO;
  process.exitCode = undefined;
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tempDir, { recursive: true, force: true });
  if (originalTreeRepoEnv === undefined) delete process.env.FIRST_TREE_GITHUB_SCAN_TREE_REPO;
  else process.env.FIRST_TREE_GITHUB_SCAN_TREE_REPO = originalTreeRepoEnv;
  process.exitCode = undefined;
});

describe("github scan command", () => {
  it("forwards args and temporarily injects explicit tree repo", async () => {
    runGitHubScanMock.mockImplementationOnce(async () => {
      expect(process.env.FIRST_TREE_GITHUB_SCAN_TREE_REPO).toBe("agent-team/context");
      return 3;
    });

    await runScan(["run", "--tree-repo", "agent-team/context", "--limit", "1"]);

    expect(runGitHubScanMock).toHaveBeenCalledWith(["run", "--limit", "1"]);
    expect(process.env.FIRST_TREE_GITHUB_SCAN_TREE_REPO).toBeUndefined();
    expect(process.exitCode).toBe(3);
  });

  it("derives the bound tree repo from source metadata in parent directories", async () => {
    mkdirSync(join(tempDir, ".first-tree"), { recursive: true });
    mkdirSync(join(tempDir, "nested", "repo"), { recursive: true });
    writeFileSync(
      join(tempDir, ".first-tree", "source.json"),
      JSON.stringify({ tree: { remoteUrl: "git@github.com:agent-team/first-tree-context.git" } }),
    );
    runGitHubScanMock.mockImplementationOnce(async () => {
      expect(process.env.FIRST_TREE_GITHUB_SCAN_TREE_REPO).toBe("agent-team/first-tree-context");
      return 0;
    });

    await runScan(["daemon", "--once"], join(tempDir, "nested", "repo"));

    expect(runGitHubScanMock).toHaveBeenCalledWith(["daemon", "--once"]);
    expect(process.exitCode).toBeUndefined();
  });

  it("requires a tree repo for commands that operate on bound source repos", async () => {
    await runScan(["install"]);

    expect(runGitHubScanMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(consoleErrorMock.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
      "requires a bound tree repo before it can start scanning",
    );
  });

  it("reports malformed tree repo values and keeps existing env values", async () => {
    process.env.FIRST_TREE_GITHUB_SCAN_TREE_REPO = "existing/repo";

    await runScan(["run", "--tree-repo=bad"]);

    expect(runGitHubScanMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(process.env.FIRST_TREE_GITHUB_SCAN_TREE_REPO).toBe("existing/repo");
    expect(consoleErrorMock.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
      "Invalid `--tree-repo` value",
    );
  });

  it("does not require binding for help-like delegated commands", async () => {
    runGitHubScanMock.mockResolvedValueOnce(0);

    await runScan(["status"]);

    expect(runGitHubScanMock).toHaveBeenCalledWith(["status"]);
    expect(process.env.FIRST_TREE_GITHUB_SCAN_TREE_REPO).toBeUndefined();
  });
});
