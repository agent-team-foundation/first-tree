import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runGitHubScanMock = vi.hoisted(() => vi.fn());
const stderrMock = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

vi.mock("../../../../packages/github-scan/src/index.js", () => ({
  runGitHubScan: runGitHubScanMock,
}));

const originalCwd = process.cwd();
const originalTreeRepoEnv = process.env.FIRST_TREE_GITHUB_SCAN_TREE_REPO;

let tempDir: string;

async function runLegacyScan(args: string[], cwd = tempDir): Promise<void> {
  process.chdir(cwd);
  const program = new Command();
  program.exitOverride();
  const { githubScanCommand } = await import("../commands/github/scan.js");
  githubScanCommand.register(program);
  await program.parseAsync(["scan", ...args], { from: "user" });
}

beforeEach(() => {
  vi.resetModules();
  tempDir = join(tmpdir(), `ft-github-scan-legacy-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempDir, { recursive: true });
  runGitHubScanMock.mockReset();
  stderrMock.mockClear();
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

describe("legacy github scan command module", () => {
  it("forwards args and restores an explicit tree repo environment", async () => {
    process.env.FIRST_TREE_GITHUB_SCAN_TREE_REPO = "existing/repo";
    runGitHubScanMock.mockImplementationOnce(async () => {
      expect(process.env.FIRST_TREE_GITHUB_SCAN_TREE_REPO).toBe("agent-team/context");
      return 2;
    });

    await runLegacyScan(["run", "--tree-repo=agent-team/context", "--limit", "1"]);

    expect(runGitHubScanMock).toHaveBeenCalledWith(["run", "--limit", "1"]);
    expect(process.env.FIRST_TREE_GITHUB_SCAN_TREE_REPO).toBe("existing/repo");
    expect(process.exitCode).toBe(2);
  });

  it("derives tree repo from .first-tree/source.json", async () => {
    mkdirSync(join(tempDir, ".first-tree"), { recursive: true });
    mkdirSync(join(tempDir, "nested"), { recursive: true });
    writeFileSync(
      join(tempDir, ".first-tree", "source.json"),
      JSON.stringify({ tree: { remoteUrl: "https://github.com/agent-team/context.git" } }),
    );
    runGitHubScanMock.mockResolvedValueOnce(0);

    await runLegacyScan(["daemon", "--once"], join(tempDir, "nested"));

    expect(runGitHubScanMock).toHaveBeenCalledWith(["daemon", "--once"]);
    expect(process.env.FIRST_TREE_GITHUB_SCAN_TREE_REPO).toBeUndefined();
  });

  it("rejects missing and malformed --tree-repo input before delegation", async () => {
    await runLegacyScan(["run", "--tree-repo"]);
    expect(process.exitCode).toBe(1);
    expect(runGitHubScanMock).not.toHaveBeenCalled();
    expect(stderrMock.mock.calls.map((call) => String(call[0])).join("")).toContain("missing value");

    process.exitCode = undefined;
    stderrMock.mockClear();
    await runLegacyScan(["install"]);
    expect(process.exitCode).toBe(1);
    expect(stderrMock.mock.calls.map((call) => String(call[0])).join("")).toContain("requires a bound tree repo");
  });

  it("delegates help-like commands without a binding", async () => {
    runGitHubScanMock.mockResolvedValueOnce(0);

    await runLegacyScan(["status"]);

    expect(runGitHubScanMock).toHaveBeenCalledWith(["status"]);
    expect(process.exitCode).toBeUndefined();
  });
});
