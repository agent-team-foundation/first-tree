import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// PR-B (audit Findings 4/5/6): `--tree-mode`, `--scope`, `--tree-name`
// keep working under W1 but emit a single stderr deprecation warning
// per use. Parser-level acceptance is preserved so older bundled skill
// payloads do not crash with `unknown option` during the staging
// auto-publish window.
//
// PR-C (next, one release cycle later) hard-deletes the parser path.

const { initCommand } = await import("../commands/tree/init.js");

const tempDirs: string[] = [];
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
function makeGitRepo(path: string): void {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, ".git"), "gitdir: /tmp/mock\n");
}

let previousCwd: string;
let previousExitCode: typeof process.exitCode;
let errSpy: ReturnType<typeof vi.spyOn>;
let outSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  previousCwd = process.cwd();
  previousExitCode = process.exitCode;
  process.exitCode = undefined;
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  outSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  process.chdir(previousCwd);
  process.exitCode = previousExitCode;
  errSpy.mockRestore();
  outSpy.mockRestore();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function buildCommand(argv: string[]): Command {
  const command = new Command();
  command.option("--scope <scope>");
  command.option("--tree-mode <mode>");
  command.option("--tree-path <path>");
  command.option("--tree-url <url>");
  command.option("--tree-name <name>");
  command.option("--workspace-id <id>");
  command.parse(argv, { from: "user" });
  return command;
}

function buildContext(command: Command) {
  return { command, options: { json: false, debug: false, quiet: false } };
}

function findDeprecationWarning(flag: string): string | undefined {
  for (const call of errSpy.mock.calls) {
    const msg = String(call[0] ?? "");
    if (msg.startsWith(`tree init: ${flag} `)) {
      return msg;
    }
  }
  return undefined;
}

describe("tree init — deprecated init flags emit stderr warning but keep working", () => {
  it("--tree-mode dedicated warns + still produces a working workspace", () => {
    const workspaceRoot = makeTempDir("first-tree-init-deprecated-tree-mode-");
    makeGitRepo(join(workspaceRoot, "source-a"));
    process.chdir(workspaceRoot);

    initCommand.action(buildContext(buildCommand(["--tree-mode", "dedicated", "--tree-path", "./tree"])));

    expect(process.exitCode).toBeFalsy();
    expect(findDeprecationWarning("--tree-mode")).toMatch(/no behavioral effect under W1/u);
    // Parser still accepts the value; init still writes the manifest.
    // No throw means readTreeModeOption did not reject "dedicated".
  });

  it("--scope workspace warns + still produces a working workspace", () => {
    const workspaceRoot = makeTempDir("first-tree-init-deprecated-scope-");
    makeGitRepo(join(workspaceRoot, "source-a"));
    process.chdir(workspaceRoot);

    initCommand.action(buildContext(buildCommand(["--scope", "workspace", "--tree-path", "./tree"])));

    expect(process.exitCode).toBeFalsy();
    expect(findDeprecationWarning("--scope")).toMatch(/no behavioral effect under W1/u);
  });

  it("--tree-name foo warns + the message tells the user to use --tree-path", () => {
    const workspaceRoot = makeTempDir("first-tree-init-deprecated-tree-name-");
    makeGitRepo(join(workspaceRoot, "source-a"));
    process.chdir(workspaceRoot);

    initCommand.action(buildContext(buildCommand(["--tree-name", "my-tree", "--workspace-id", "demo"])));

    expect(process.exitCode).toBeFalsy();
    const warning = findDeprecationWarning("--tree-name");
    // Warning steers the user toward the explicit replacement and is
    // explicit that the flag still works for now (it is NOT a no-op,
    // unlike --tree-mode / --scope under W1).
    expect(warning).toMatch(/use --tree-path/u);
    expect(warning).toMatch(/still works for compatibility/u);
  });

  it("running with NO deprecated flags emits no warning", () => {
    const workspaceRoot = makeTempDir("first-tree-init-no-deprecation-");
    makeGitRepo(join(workspaceRoot, "source-a"));
    process.chdir(workspaceRoot);

    initCommand.action(buildContext(buildCommand(["--tree-path", "./tree", "--workspace-id", "demo"])));

    expect(process.exitCode).toBeFalsy();
    expect(findDeprecationWarning("--tree-mode")).toBeUndefined();
    expect(findDeprecationWarning("--scope")).toBeUndefined();
    expect(findDeprecationWarning("--tree-name")).toBeUndefined();
  });

  it("--scope repo still throws REPO_SCOPE_GUIDANCE (not just deprecated)", () => {
    const workspaceRoot = makeTempDir("first-tree-init-scope-repo-");
    makeGitRepo(join(workspaceRoot, "source-a"));
    process.chdir(workspaceRoot);

    initCommand.action(buildContext(buildCommand(["--scope", "repo", "--tree-path", "./tree"])));

    expect(process.exitCode).toBe(1);
    // Both signals fire — the deprecation warning AND the REPO_SCOPE_GUIDANCE
    // error. Order does not matter; both must be present.
    expect(findDeprecationWarning("--scope")).toBeDefined();
    const errorMessage = errSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
    expect(errorMessage).toContain("workspace-scope recipe");
  });
});
