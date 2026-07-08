import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPlaceholderAction, createPlaceholderSubcommand } from "../commands/placeholder.js";
import {
  findUpwardsManagedSourceBinding,
  parseGitHubRepoReference,
  parseManagedSourceBindingText,
  readManagedSourceBinding,
  readSourceBindingContract,
  SOURCE_INTEGRATION_BEGIN,
  SOURCE_INTEGRATION_END,
} from "../commands/tree/binding-contract.js";
import type { CommandContext } from "../commands/types.js";

const tempDirs: string[] = [];
const commandContext: CommandContext = {
  command: {} as CommandContext["command"],
  options: { debug: false, json: false, quiet: false },
};

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ft-binding-contract-"));
  tempDirs.push(dir);
  return dir;
}

function managedBlock(lines: string[]): string {
  return ["before", SOURCE_INTEGRATION_BEGIN, ...lines, SOURCE_INTEGRATION_END, "after"].join("\n");
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("tree binding contract helpers", () => {
  it("parses managed block markers, repo references, and absent marker blocks", () => {
    expect(parseGitHubRepoReference(undefined)).toBeUndefined();
    expect(parseGitHubRepoReference("  ")).toBeUndefined();
    expect(parseGitHubRepoReference("acme/context")).toBe("acme/context");
    expect(parseGitHubRepoReference("https://github.com/Acme/Context.git")).toBe("Acme/Context");
    expect(parseGitHubRepoReference("https://gitlab.com/acme/context.git")).toBeUndefined();

    expect(parseManagedSourceBindingText("no managed block")).toBeUndefined();
    expect(parseManagedSourceBindingText(managedBlock(["FIRST-TREE-TREE-REPO-URL: pending publish"]))).toBeUndefined();

    expect(
      parseManagedSourceBindingText(
        managedBlock([
          "FIRST-TREE-BINDING-CONTRACT: `managed-block-v2`",
          "FIRST-TREE-BINDING-MODE: `workspace-member`",
          "FIRST-TREE-TREE-MODE: shared",
          "FIRST-TREE-TREE-REPO: context",
          "FIRST-TREE-TREE-REPO-URL: https://github.com/acme/context.git",
          "FIRST-TREE-ENTRYPOINT: packages/app",
          "FIRST-TREE-SOURCE-STATE: .first-tree/source.json",
          "FIRST-TREE-WORKSPACE-ID: workspace-1",
        ]),
      ),
    ).toEqual({
      bindingContract: "managed-block-v2",
      bindingMode: "workspace-member",
      entrypoint: "packages/app",
      scope: "workspace",
      sourceStatePath: ".first-tree/source.json",
      treeMode: "shared",
      treeRepoName: "context",
      treeRepoSlug: "acme/context",
      treeRepoUrl: "https://github.com/acme/context.git",
      workspaceId: "workspace-1",
    });
  });

  it("reads managed bindings from AGENTS, CLAUDE, ancestors, and legacy source state", () => {
    const root = makeTempDir();
    mkdirSync(join(root, "child", "nested"), { recursive: true });
    writeFileSync(
      join(root, "CLAUDE.md"),
      managedBlock(["FIRST-TREE-BINDING-MODE: standalone-source", "FIRST-TREE-TREE-REPO-SLUG: acme/context"]),
    );

    expect(readManagedSourceBinding(join(root, "missing"))).toBeUndefined();
    expect(readManagedSourceBinding(root)).toMatchObject({
      file: "CLAUDE.md",
      bindingMode: "standalone-source",
      scope: "repo",
      treeRepoSlug: "acme/context",
    });
    expect(findUpwardsManagedSourceBinding(join(root, "child", "nested"))).toMatchObject({
      file: "CLAUDE.md",
      treeRepoSlug: "acme/context",
    });

    const legacyRoot = makeTempDir();
    mkdirSync(join(legacyRoot, ".first-tree"), { recursive: true });
    writeFileSync(
      join(legacyRoot, ".first-tree", "source.json"),
      JSON.stringify({
        bindingMode: "shared-source",
        rootKind: "git-repo",
        schemaVersion: 1,
        scope: "repo",
        sourceName: "app",
        sourceId: "source-1",
        workspaceId: "workspace-legacy",
        tree: {
          treeId: "tree-1",
          treeMode: "shared",
          treeRepoName: "context",
          remoteUrl: "git@github.com:acme/context.git",
          entrypoint: "docs",
        },
      }),
    );

    expect(readSourceBindingContract(legacyRoot)).toEqual({
      bindingContract: "legacy-source-state",
      bindingMode: "shared-source",
      entrypoint: "docs",
      scope: "repo",
      sourceStatePath: ".first-tree/source.json",
      treeMode: "shared",
      treeRepoName: "context",
      treeRepoSlug: "acme/context",
      treeRepoUrl: "git@github.com:acme/context.git",
      workspaceId: "workspace-legacy",
    });
  });
});

describe("placeholder command helpers", () => {
  it("creates placeholder actions and subcommand metadata", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const action = createPlaceholderAction("coming soon");
    action(commandContext);
    expect(log).toHaveBeenCalledWith("coming soon");

    const subcommand = createPlaceholderSubcommand({
      name: "alpha",
      description: "Alpha command",
      message: "not ready",
    });
    expect(subcommand).toMatchObject({
      name: "alpha",
      alias: "",
      summary: "",
      description: "Alpha command",
    });
    subcommand.action(commandContext);
    expect(log).toHaveBeenCalledWith("not ready");
    log.mockRestore();
  });
});
