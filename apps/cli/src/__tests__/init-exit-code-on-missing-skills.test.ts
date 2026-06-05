import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

// Replace copyCanonicalSkills with a thrower so `initializeWorkspaceRoot`
// reaches the same failure mode that `bundledSkillsRootFrom` produces when
// the npm tarball ships without a `skills/` payload (see
// first-tree-context-management/post-w1-trailing-edge-audit.md Finding 9).
//
// The fix landed in init.ts:241-243 — a catch block around runInitCommand
// that sets process.exitCode = 1. This test pins both halves so the
// "smoke harness can trust tree init exit codes" contract holds across
// future refactors.
const throwOnCopyCanonicalSkills = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error(
      "Could not locate bundled `skills/` payloads. Run from a source checkout or a packaged dist that includes `skills/`.",
    );
  }),
);

vi.mock("../commands/tree/skill-lib.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../commands/tree/skill-lib.js")>();
  return {
    ...actual,
    copyCanonicalSkills: throwOnCopyCanonicalSkills,
  };
});

const { initializeWorkspaceRoot, initCommand } = await import("../commands/tree/init.js");

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

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("tree init — exit code when bundled skills payload is missing", () => {
  it("initializeWorkspaceRoot throws and does not write workspace.json", () => {
    const workspaceRoot = makeTempDir("first-tree-init-missing-skills-throw-");
    makeGitRepo(join(workspaceRoot, "source-a"));

    expect(() =>
      initializeWorkspaceRoot(workspaceRoot, {
        treePath: "./tree",
      }),
    ).toThrow("Could not locate bundled `skills/` payloads");

    expect(existsSync(join(workspaceRoot, ".first-tree", "workspace.json"))).toBe(false);
  });

  it("initCommand.action sets process.exitCode to 1 and does not write workspace.json", () => {
    const workspaceRoot = makeTempDir("first-tree-init-missing-skills-exitcode-");
    makeGitRepo(join(workspaceRoot, "source-a"));

    const previousCwd = process.cwd();
    const previousExitCode = process.exitCode;
    try {
      process.chdir(workspaceRoot);
      process.exitCode = undefined;

      const command = new Command();
      command.option("--tree-path <path>");
      command.option("--tree-url <url>");
      command.option("--workspace-id <id>");
      command.parse(["--tree-path", "./tree"], { from: "user" });

      const stubContext = {
        command,
        options: { json: false, debug: false, quiet: false },
      };

      initCommand.action(stubContext);

      expect(process.exitCode).toBe(1);
      expect(existsSync(join(workspaceRoot, ".first-tree", "workspace.json"))).toBe(false);
    } finally {
      process.chdir(previousCwd);
      process.exitCode = previousExitCode;
    }
  });
});
