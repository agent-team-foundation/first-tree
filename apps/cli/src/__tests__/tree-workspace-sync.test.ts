import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { syncWorkspaceMembersFromRoot, workspaceSyncCommand } from "../commands/tree/workspace-sync.js";
import type { CommandContext } from "../commands/types.js";

const { bindSourceRootMock } = vi.hoisted(() => ({
  bindSourceRootMock: vi.fn(),
}));

vi.mock("../commands/tree/bind.js", () => ({
  bindSourceRoot: bindSourceRootMock,
}));

describe("tree workspace sync command", () => {
  let tmp: string;
  let originalCwd: string;
  let originalExitCode: typeof process.exitCode;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "first-tree-workspace-sync-"));
    originalCwd = process.cwd();
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
    bindSourceRootMock.mockReset();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    process.exitCode = originalExitCode;
    rmSync(tmp, { recursive: true, force: true });
  });

  function makeGitDir(relPath: string): string {
    const root = join(tmp, relPath);
    mkdirSync(join(root, ".git"), { recursive: true });
    return root;
  }

  function commandContext(args: string[], json = false): CommandContext {
    const command = new Command();
    workspaceSyncCommand.configure?.(command);
    command.parse(["node", "sync", ...args], { from: "node" });
    return { command, options: { debug: false, json, quiet: false } };
  }

  it("prints a JSON dry-run plan for discovered child repos", () => {
    makeGitDir("");
    makeGitDir("packages/api");
    makeGitDir("packages/web");
    makeGitDir("node_modules/ignored");
    process.chdir(tmp);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    workspaceSyncCommand.action(commandContext(["--tree-url", "https://github.com/example/tree", "--dry-run"], true));

    const parsed = JSON.parse(String(log.mock.calls[0]?.[0] ?? ""));
    expect(parsed.dryRun).toBe(true);
    expect(parsed.workspaceId).toMatch(/^first-tree-workspace-sync-/u);
    expect(parsed.treeUrl).toBe("https://github.com/example/tree");
    expect(parsed.childRepos.map((repo: { relativePath: string }) => repo.relativePath)).toEqual([
      "packages/api",
      "packages/web",
    ]);
    expect(bindSourceRootMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
    log.mockRestore();
  });

  it("applies workspace member bindings and reports member failures", () => {
    makeGitDir("");
    const apiRoot = makeGitDir("repos/api");
    const webRoot = makeGitDir("repos/web");
    bindSourceRootMock.mockImplementation((sourceRoot: string) => {
      if (sourceRoot === webRoot) {
        throw new Error("cannot bind web");
      }
      return { sourceRoot };
    });
    const treeRoot = makeGitDir("tree");
    process.chdir(tmp);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    expect(
      syncWorkspaceMembersFromRoot({
        treePath: treeRoot,
        treeUrl: "https://github.com/example/tree",
        workspaceId: "workspace-1",
        workspaceRoot: tmp,
      }),
    ).toBe(true);

    expect(readFileSync(join(tmp, ".gitignore"), "utf-8")).toContain(".first-tree/tmp/");
    expect(bindSourceRootMock).toHaveBeenCalledWith(
      apiRoot,
      expect.objectContaining({
        mode: "workspace-member",
        treeMode: "shared",
        treePath: treeRoot,
        treeUrl: "https://github.com/example/tree",
        workspaceId: "workspace-1",
        workspaceRoot: tmp,
      }),
      tmp,
    );
    expect(log.mock.calls.map((call) => String(call[0] ?? "")).join("\n")).toContain(
      "Failed repos/web: cannot bind web",
    );
    log.mockRestore();
  });

  it("surfaces unresolved tree configuration errors from the command action", () => {
    makeGitDir("");
    process.chdir(tmp);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    workspaceSyncCommand.action(commandContext([]));

    expect(error).toHaveBeenCalledWith(expect.stringContaining("Could not resolve the shared tree"));
    expect(process.exitCode).toBe(1);
    error.mockRestore();
  });
});
