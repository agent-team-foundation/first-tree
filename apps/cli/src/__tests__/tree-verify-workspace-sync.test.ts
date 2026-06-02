import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeTreeState } from "../commands/tree/binding-state.js";
import { buildSourceIntegrationBlock } from "../commands/tree/source-integration.js";
import { syncTreeIdentityFiles } from "../commands/tree/tree-identity.js";
import type { CommandContext } from "../commands/types.js";

const tempDirs: string[] = [];
const originalCwd = process.cwd();

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function context(command: Command, json = false): CommandContext {
  return {
    command,
    options: {
      debug: false,
      json,
      quiet: false,
    },
  };
}

function commandWithOptions(options: Record<string, unknown>): Command {
  const command = new Command("test");
  for (const [key, value] of Object.entries(options)) {
    command.setOptionValue(key, value);
  }
  return command;
}

function writeValidTree(root: string): void {
  mkdirSync(join(root, ".first-tree"), { recursive: true });
  writeFileSync(join(root, ".git"), "gitdir: /tmp/tree\n");
  writeFileSync(join(root, "NODE.md"), ["---", "title: Root", "owners: [team]", "---", "", "# Root", ""].join("\n"));
  writeFileSync(join(root, "AGENTS.md"), "BEGIN CONTEXT-TREE FRAMEWORK\n");
  writeFileSync(join(root, "CLAUDE.md"), "BEGIN CONTEXT-TREE FRAMEWORK\n");
  writeFileSync(join(root, ".first-tree", "VERSION"), "1\n");
  writeFileSync(join(root, ".first-tree", "progress.md"), "- [x] done\n");
  mkdirSync(join(root, "members", "gandy"), { recursive: true });
  writeFileSync(
    join(root, "members", "gandy", "NODE.md"),
    [
      "---",
      "title: Gandy",
      "owners: [gandy]",
      "type: human",
      "role: Engineer",
      "domains: [platform]",
      "---",
      "",
      "# Gandy",
      "",
    ].join("\n"),
  );
  writeTreeState(root, {
    treeId: "context-tree",
    treeMode: "shared",
    treeRepoName: "context-tree",
    published: { remoteUrl: "https://github.com/acme/context-tree.git" },
  });
  syncTreeIdentityFiles(root, {
    treeMode: "shared",
    treeRepoName: "context-tree",
    publishedTreeUrl: "https://github.com/acme/context-tree.git",
  });
}

function makeGitRepo(root: string): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, ".git"), "gitdir: /tmp/mock\n");
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  process.chdir(originalCwd);
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
  process.exitCode = undefined;
});

describe("tree verify command", () => {
  it("reports successful validation as JSON", async () => {
    const root = makeTempDir("ft-tree-verify-ok-");
    writeValidTree(root);
    const { verifyCommand } = await import("../commands/tree/verify.js");

    verifyCommand.action(context(commandWithOptions({ treePath: root }), true));

    const payload = JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0])) as {
      ok: boolean;
      targetRoot: string;
      checks: { progress: { uncheckedItems: string[] } };
    };
    expect(payload.ok).toBe(true);
    expect(payload.targetRoot).toBe(root);
    expect(payload.checks.progress.uncheckedItems).toEqual([]);
    expect(process.exitCode).toBeUndefined();
  });

  it("reports missing files, invalid frontmatter, validator errors, and unchecked progress", async () => {
    const root = makeTempDir("ft-tree-verify-fail-");
    mkdirSync(join(root, ".first-tree"), { recursive: true });
    writeFileSync(join(root, ".git"), "gitdir: /tmp/tree\n");
    writeFileSync(join(root, "NODE.md"), "---\ntitle: Missing owners\n---\n# Root\n");
    writeFileSync(join(root, "AGENTS.md"), "no framework marker\n");
    writeFileSync(join(root, ".first-tree", "progress.md"), "- [ ] Decide owner\n");

    const { verifyCommand } = await import("../commands/tree/verify.js");
    verifyCommand.action(context(commandWithOptions({ treePath: root }), false));

    const output = vi
      .mocked(console.log)
      .mock.calls.map((call) => String(call[0]))
      .join("\n");
    expect(output).toContain("[FAIL] framework version");
    expect(output).toContain("Root NODE.md is missing owners");
    expect(output).toContain("Unchecked progress item: Decide owner");
    expect(output).toContain("Some checks failed");
    expect(process.exitCode).toBe(1);
  });

  it("explains when verify is run from a source integration instead of the tree repo", async () => {
    const root = makeTempDir("ft-tree-verify-source-");
    makeGitRepo(root);
    writeFileSync(
      join(root, "AGENTS.md"),
      buildSourceIntegrationBlock("context-tree", {
        bindingMode: "shared-source",
        treeMode: "shared",
        treeRepoName: "context-tree",
        treeRepoUrl: "https://github.com/acme/context-tree.git",
      }),
    );
    const { verifyCommand } = await import("../commands/tree/verify.js");

    verifyCommand.action(context(commandWithOptions({ treePath: root }), false));

    expect(
      vi
        .mocked(console.error)
        .mock.calls.map((call) => String(call[0]))
        .join("\n"),
    ).toContain("Verify the tree repo instead");
    expect(process.exitCode).toBe(1);
  });
});

describe("syncWorkspaceMembersFromRoot", () => {
  it("binds child repositories and updates workspace gitignore", async () => {
    const workspace = makeTempDir("ft-workspace-sync-apply-");
    makeGitRepo(workspace);
    const repoA = join(workspace, "repo-a");
    const repoB = join(workspace, "repo-b");
    makeGitRepo(repoA);
    makeGitRepo(repoB);
    const tree = makeTempDir("ft-workspace-sync-apply-tree-");
    writeValidTree(tree);
    const { syncWorkspaceMembersFromRoot } = await import("../commands/tree/workspace-sync.js");

    const hadFailure = syncWorkspaceMembersFromRoot({
      workspaceRoot: workspace,
      workspaceId: "acme-workspace",
      treePath: tree,
      treeUrl: "https://github.com/acme/context-tree.git",
    });

    expect(hadFailure).toBe(false);
    expect(readFileSync(join(workspace, ".gitignore"), "utf8")).toContain(".first-tree/tmp/");
    expect(readFileSync(join(repoA, "AGENTS.md"), "utf8")).toContain("workspace member");
    expect(readFileSync(join(repoA, "AGENTS.md"), "utf8")).toContain("acme-workspace");
    expect(readFileSync(join(repoB, "CLAUDE.md"), "utf8")).toContain("context-tree");
  });

  it("throws when no shared tree can be resolved", async () => {
    const workspace = makeTempDir("ft-workspace-sync-missing-tree-");
    const { syncWorkspaceMembersFromRoot } = await import("../commands/tree/workspace-sync.js");

    expect(() => syncWorkspaceMembersFromRoot({ workspaceRoot: workspace })).toThrow(
      "Could not resolve the shared tree",
    );
  });
});
