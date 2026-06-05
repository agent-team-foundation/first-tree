import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeTreeState } from "../commands/tree/binding-state.js";
import { buildSourceIntegrationBlock } from "../commands/tree/source-integration.js";
import { syncTreeIdentityFiles } from "../commands/tree/tree-identity.js";
import type { CommandContext } from "../commands/types.js";
import { writeWorkspaceManifest } from "../core/workspace.js";

const tempDirs: string[] = [];
const originalCwd = process.cwd();

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeGitRepo(root: string, remote: string | null = "https://github.com/acme/source.git"): void {
  mkdirSync(root, { recursive: true });
  mkdirSync(join(root, ".git", "objects"), { recursive: true });
  mkdirSync(join(root, ".git", "refs", "heads"), { recursive: true });
  writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  const remoteBlock = remote === null ? "" : `[remote "origin"]\n  url = ${remote}\n`;
  writeFileSync(
    join(root, ".git", "config"),
    `[core]\n  repositoryformatversion = 0\n  filemode = true\n  bare = false\n  logallrefupdates = true\n${remoteBlock}`,
  );
}

function writePromptFiles(root: string, text = "BEGIN CONTEXT-TREE FRAMEWORK\n"): void {
  writeFileSync(join(root, "AGENTS.md"), text);
  writeFileSync(join(root, "CLAUDE.md"), text);
}

function writeTreeRoot(
  root: string,
  options: { gitRemote?: string | null; publishedUrl?: string; repoName?: string } = {},
): void {
  makeGitRepo(
    root,
    options.gitRemote === undefined
      ? (options.publishedUrl ?? "https://github.com/acme/context-tree.git")
      : options.gitRemote,
  );
  writePromptFiles(root);
  writeFileSync(join(root, "NODE.md"), "# Root Context\n");
  writeTreeState(root, {
    treeId: "context-tree",
    treeMode: "shared",
    treeRepoName: options.repoName ?? "context-tree",
    ...(options.publishedUrl ? { published: { remoteUrl: options.publishedUrl } } : {}),
  });
  syncTreeIdentityFiles(root, {
    treeMode: "shared",
    treeRepoName: options.repoName ?? "context-tree",
    ...(options.publishedUrl ? { publishedTreeUrl: options.publishedUrl } : {}),
  });
}

function commandWithOptions(options: Record<string, unknown>): Command {
  const command = new Command("test");
  for (const [key, value] of Object.entries(options)) {
    command.setOptionValue(key, value);
  }
  return command;
}

function context(command: Command, json = false): CommandContext {
  return {
    command,
    options: { debug: false, json, quiet: false },
  };
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  process.chdir(originalCwd);
  process.exitCode = undefined;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("tree first context bundle", () => {
  it("builds tree-root, source-bound, temp-checkout, and fallback NODE.md context", async () => {
    const { buildTreeFirstContextBundle } = await import("../commands/tree/tree-first-context.js");

    const tree = makeTempDir("ft-tree-context-root-");
    writeTreeRoot(tree);
    writeFileSync(
      join(tree, "AGENTS.md"),
      [
        "BEGIN CONTEXT-TREE FRAMEWORK",
        "<!-- BEGIN FIRST-TREE-CODE-REPO-REGISTRY -->",
        "- [acme/api](https://github.com/acme/api)",
        "<!--",
        "FIRST-TREE-CODE-REPO-REGISTRY: managed-block-v1",
        "FIRST-TREE-CODE-REPO: `https://github.com/acme/api`",
        "-->",
        "<!-- END FIRST-TREE-CODE-REPO-REGISTRY -->",
        "",
      ].join("\n"),
    );

    const treeBundle = buildTreeFirstContextBundle(tree);
    expect(treeBundle?.treeRoot).toBe(tree);
    expect(treeBundle?.additionalContext).toContain("# Root Context");
    expect(treeBundle?.additionalContext).toContain("tree repo root");
    expect(treeBundle?.additionalContext).toContain("| `api` | [acme/api](https://github.com/acme/api) |");

    const workspace = makeTempDir("ft-tree-context-workspace-");
    const source = join(workspace, "source");
    mkdirSync(source, { recursive: true });
    writePromptFiles(source, buildSourceIntegrationBlock("context-tree", { bindingMode: "workspace-member" }));
    const siblingTree = join(workspace, "context-tree");
    mkdirSync(siblingTree, { recursive: true });
    writeTreeRoot(siblingTree);

    const sourceBundle = buildTreeFirstContextBundle(source);
    expect(sourceBundle?.treeRoot).toBe(siblingTree);
    expect(sourceBundle?.additionalContext).toContain("Current entrypoint: `/`");

    rmSync(siblingTree, { recursive: true, force: true });
    const tempTree = join(source, ".first-tree", "tmp", "context-tree");
    mkdirSync(tempTree, { recursive: true });
    writeTreeRoot(tempTree);
    expect(buildTreeFirstContextBundle(source)?.treeRoot).toBe(tempTree);

    const fallback = makeTempDir("ft-tree-context-fallback-");
    writeFileSync(join(fallback, "NODE.md"), "# Local Node\n");
    expect(buildTreeFirstContextBundle(fallback)).toEqual({
      additionalContext: "# Local Node\n",
      treeRoot: fallback,
    });
    expect(buildTreeFirstContextBundle(makeTempDir("ft-tree-context-empty-"))).toBeNull();
  });

  // Regression — until now, `resolveTreeContextRoot` only looked for the tree
  // as a sibling of the cwd (`dirname(cwd)/<treeName>`). Under W1 the tree
  // lives **inside** the workspace at `<workspaceRoot>/<manifest.tree>`, so
  // `tree inject` returned 0 bytes from any W1 workspace cwd. The fix
  // resolves via the workspace manifest first.
  it("resolves the tree via .first-tree/workspace.json under the W1 layout", async () => {
    const { buildTreeFirstContextBundle } = await import("../commands/tree/tree-first-context.js");

    const workspaceRoot = makeTempDir("ft-w1-resolver-ws-");
    const treeRoot = join(workspaceRoot, "my-workspace-tree");
    mkdirSync(treeRoot, { recursive: true });
    writeTreeRoot(treeRoot, { repoName: "my-workspace-tree" });
    writeWorkspaceManifest(workspaceRoot, { tree: "my-workspace-tree", sources: [] });

    // Case A: cwd === workspace root. workspace-root binding contract is
    // present; entrypoint comes from the binding ("/").
    writePromptFiles(
      workspaceRoot,
      buildSourceIntegrationBlock("my-workspace-tree", {
        bindingMode: "workspace-root",
        entrypoint: "/",
        workspaceId: "acme",
      }),
    );
    const wsBundle = buildTreeFirstContextBundle(workspaceRoot);
    expect(wsBundle?.treeRoot).toBe(treeRoot);
    expect(wsBundle?.additionalContext).toContain("# Root Context");
    expect(wsBundle?.additionalContext).toContain("Current entrypoint: `/`");

    // Case B: cwd is a workspace-member subdir with its own binding contract.
    // Walk-up still finds the manifest; entrypoint comes from the member's
    // binding ("/repos/product-repo").
    const memberRoot = join(workspaceRoot, "repos", "product-repo");
    mkdirSync(memberRoot, { recursive: true });
    writePromptFiles(
      memberRoot,
      buildSourceIntegrationBlock("my-workspace-tree", {
        bindingMode: "workspace-member",
        entrypoint: "/repos/product-repo",
        workspaceId: "acme",
      }),
    );
    const memberBundle = buildTreeFirstContextBundle(memberRoot);
    expect(memberBundle?.treeRoot).toBe(treeRoot);
    expect(memberBundle?.additionalContext).toContain("Current entrypoint: `/repos/product-repo`");

    // Case C: cwd is some other directory inside the workspace with no
    // binding contract of its own (e.g. a scratch dir). Walk-up still
    // resolves; entrypoint is derived from the filesystem relative path.
    const scratch = join(workspaceRoot, "scratch", "play");
    mkdirSync(scratch, { recursive: true });
    const scratchBundle = buildTreeFirstContextBundle(scratch);
    expect(scratchBundle?.treeRoot).toBe(treeRoot);
    expect(scratchBundle?.additionalContext).toContain("Current entrypoint: `/scratch/play`");
  });

  it("falls back to the legacy sibling layout when no workspace manifest is present", async () => {
    // Pre-W1 layout still in the wild — cwd has a binding contract but no
    // workspace.json above it; tree sits next to the source as a sibling.
    const { buildTreeFirstContextBundle } = await import("../commands/tree/tree-first-context.js");

    const enclosing = makeTempDir("ft-legacy-sibling-");
    const source = join(enclosing, "source");
    const tree = join(enclosing, "context-tree");
    mkdirSync(source, { recursive: true });
    mkdirSync(tree, { recursive: true });
    writeTreeRoot(tree);
    writePromptFiles(
      source,
      buildSourceIntegrationBlock("context-tree", {
        bindingMode: "workspace-member",
        entrypoint: "/source",
      }),
    );

    const bundle = buildTreeFirstContextBundle(source);
    expect(bundle?.treeRoot).toBe(tree);
    expect(bundle?.additionalContext).toContain("Current entrypoint: `/source`");
  });

  it("prefers the workspace manifest tree over a legacy sibling when both would match", async () => {
    const { buildTreeFirstContextBundle } = await import("../commands/tree/tree-first-context.js");

    const enclosing = makeTempDir("ft-w1-vs-legacy-");
    const workspaceRoot = join(enclosing, "workspace");
    const w1Tree = join(workspaceRoot, "my-workspace-tree");
    const legacySibling = join(enclosing, "my-workspace-tree");
    mkdirSync(w1Tree, { recursive: true });
    mkdirSync(legacySibling, { recursive: true });
    writeTreeRoot(w1Tree, { repoName: "my-workspace-tree" });
    writeTreeRoot(legacySibling, { repoName: "my-workspace-tree" });
    writeWorkspaceManifest(workspaceRoot, { tree: "my-workspace-tree", sources: [] });
    writePromptFiles(
      workspaceRoot,
      buildSourceIntegrationBlock("my-workspace-tree", {
        bindingMode: "workspace-root",
        entrypoint: "/",
        workspaceId: "acme",
      }),
    );

    expect(buildTreeFirstContextBundle(workspaceRoot)?.treeRoot).toBe(w1Tree);
  });

  it("falls through to legacy / fallback paths when the workspace manifest points at a non-tree", async () => {
    // workspace.json exists but its `tree` path is not actually a tree.
    // The legacy fallback should still kick in if the source binding can
    // find a sibling tree.
    const { buildTreeFirstContextBundle } = await import("../commands/tree/tree-first-context.js");

    const enclosing = makeTempDir("ft-w1-malformed-");
    const workspaceRoot = join(enclosing, "workspace");
    const stub = join(workspaceRoot, "not-a-tree");
    const realSibling = join(enclosing, "context-tree");
    mkdirSync(stub, { recursive: true });
    mkdirSync(realSibling, { recursive: true });
    writeTreeRoot(realSibling);
    writeWorkspaceManifest(workspaceRoot, { tree: "not-a-tree", sources: [] });
    writePromptFiles(
      workspaceRoot,
      buildSourceIntegrationBlock("context-tree", {
        bindingMode: "workspace-root",
        entrypoint: "/",
        workspaceId: "acme",
      }),
    );

    // W1 path can't resolve `not-a-tree` → falls through to legacy sibling
    // resolution which finds `context-tree` next to the workspace.
    expect(buildTreeFirstContextBundle(workspaceRoot)?.treeRoot).toBe(realSibling);
  });
});

describe("tree automation", () => {
  it("prepares workflows when repository metadata is missing or remote workflows need merging", async () => {
    const tree = makeTempDir("ft-tree-automation-stage-a-");
    writeTreeRoot(tree);
    const { installTreeAutomation } = await import("../commands/tree/automation.js");

    const localOnly = installTreeAutomation(tree, { dryRun: true, tier: 2 }, () => {
      throw new Error("no remote");
    });
    expect(localOnly.stage).toBe("write_rule_layer");
    expect(localOnly.appInstalled).toBeNull();
    expect(localOnly.workflowFiles.map((file) => file.status)).toEqual(["would-write", "would-write"]);

    const runner = vi.fn((command: string, args: string[]) => {
      if (command === "gh" && args[0] === "api" && args[1] === "repos/acme/context-tree") {
        return JSON.stringify({ default_branch: "main" });
      }
      if (command === "gh" && args[0] === "api" && args[1] === "repos/acme/context-tree/installation") return "{}";
      if (command === "gh" && args[0] === "api" && String(args[1]).includes("/contents/")) {
        throw new Error("missing workflow");
      }
      return "[]";
    });
    const summary = installTreeAutomation(tree, { dryRun: true, tier: 2 }, runner);
    expect(summary).toMatchObject({
      appInstalled: true,
      defaultBranch: "main",
      repoSlug: "acme/context-tree",
      stage: "write_rule_layer",
    });
    expect(summary.warnings.join("\n")).toContain("Merge `.github/workflows/auto-merge.yml`");
  });

  it("prints ruleset create and activate commands, then reports configured rulesets", async () => {
    const tree = makeTempDir("ft-tree-automation-ruleset-");
    writeTreeRoot(tree);
    const workflowContent = Buffer.from("# first-tree-template-version: 1\nname: managed\n").toString("base64");
    const calls: string[] = [];
    const baseRunner = (rulesets: unknown[]) =>
      vi.fn((command: string, args: string[]) => {
        calls.push(`${command} ${args.join(" ")}`);
        if (command === "gh" && args[0] === "api" && args[1] === "repos/acme/context-tree") {
          return JSON.stringify({ default_branch: "main" });
        }
        if (command === "gh" && args[0] === "api" && args[1] === "repos/acme/context-tree/installation") return "{}";
        if (command === "gh" && args[0] === "api" && String(args[1]).includes("/contents/")) return workflowContent;
        if (command === "gh" && args[0] === "api" && String(args[1]).includes("/rulesets?"))
          return JSON.stringify(rulesets);
        return "";
      });
    const { installTreeAutomation } = await import("../commands/tree/automation.js");

    installTreeAutomation(tree, { dryRun: false, tier: 2 }, baseRunner([]));
    const createSummary = installTreeAutomation(tree, { dryRun: false, tier: 2 }, baseRunner([]));
    expect(createSummary.stage).toBe("create_ruleset");
    expect(createSummary.nextCommands[0]).toContain("gh api repos/acme/context-tree/rulesets --method POST");

    const activateSummary = installTreeAutomation(
      tree,
      { dryRun: false, tier: 2 },
      baseRunner([{ id: 7, name: "first-tree owners gate", enforcement: "disabled", target: "branch" }]),
    );
    expect(activateSummary.stage).toBe("activate_ruleset");
    expect(activateSummary.ruleset).toMatchObject({ id: 7, enforcement: "disabled" });
    expect(activateSummary.nextCommands[0]).toContain("repos/acme/context-tree/rulesets/7 --method PUT");

    const configuredSummary = installTreeAutomation(
      tree,
      { dryRun: false, tier: 2 },
      baseRunner([{ id: 8, name: "first-tree owners gate", enforcement: "active" }]),
    );
    expect(configuredSummary.stage).toBe("configured");
    expect(configuredSummary.ruleset).toMatchObject({ id: 8, enforcement: "active" });
    expect(calls.some((call) => call.includes("repos/acme/context-tree/rulesets?includes_parents=false"))).toBe(true);
  });

  it("handles custom and outdated remote workflows and prints human command output", async () => {
    const tree = makeTempDir("ft-tree-automation-remote-");
    writeTreeRoot(tree);
    mkdirSync(join(tree, ".github", "workflows"), { recursive: true });
    writeFileSync(
      join(tree, ".github", "workflows", "auto-merge.yml"),
      "# first-tree-template-version: 1\nname: auto\n",
    );
    writeFileSync(
      join(tree, ".github", "workflows", "review-enforcer.yml"),
      "# first-tree-template-version: 1\nname: review\n",
    );
    const currentContent = Buffer.from("# first-tree-template-version: 99\nname: current\n").toString("base64");
    const customContent = Buffer.from("name: custom\n").toString("base64");
    const outdatedContent = Buffer.from("# first-tree-template-version: 0\nname: old\n").toString("base64");
    const runner = vi.fn((command: string, args: string[]) => {
      if (command === "gh" && args[0] === "api" && args[1] === "repos/acme/context-tree") {
        return JSON.stringify({ default_branch: "main" });
      }
      if (command === "gh" && args[0] === "api" && args[1] === "repos/acme/context-tree/installation") {
        throw new Error("not installed");
      }
      if (command === "gh" && args[0] === "api" && String(args[1]).includes("auto-merge")) return currentContent;
      if (command === "gh" && args[0] === "api" && String(args[1]).includes("review-enforcer")) return customContent;
      return JSON.stringify([]);
    });
    const { installTreeAutomation } = await import("../commands/tree/automation.js");

    const customSummary = installTreeAutomation(tree, { dryRun: true, tier: 2 }, runner);
    expect(customSummary.stage).toBe("write_rule_layer");
    expect(customSummary.appInstalled).toBeNull();
    expect(customSummary.warnings.join("\n")).toContain("first-tree-gate");

    const outdatedRunner = vi.fn((command: string, args: string[]) => {
      if (command === "gh" && args[0] === "api" && args[1] === "repos/acme/context-tree") {
        return JSON.stringify({ default_branch: "main" });
      }
      if (command === "gh" && args[0] === "api" && args[1] === "repos/acme/context-tree/installation") return "{}";
      if (command === "gh" && args[0] === "api" && String(args[1]).includes("/contents/")) return outdatedContent;
      return "not an array";
    });
    const outdatedSummary = installTreeAutomation(tree, { dryRun: false, tier: 2 }, outdatedRunner);
    expect(outdatedSummary.stage).toBe("write_rule_layer");
    expect(outdatedSummary.warnings.join("\n")).toContain("Merge `.github/workflows/auto-merge.yml`");

    expect(customSummary.warnings.length).toBeGreaterThan(0);
  });

  it("rejects source-only roots and invalid command options", async () => {
    const source = makeTempDir("ft-tree-automation-source-");
    writePromptFiles(source, buildSourceIntegrationBlock("context-tree", { bindingMode: "shared-source" }));
    const { automationSubcommands, installTreeAutomation } = await import("../commands/tree/automation.js");

    expect(() => installTreeAutomation(source, { dryRun: true, tier: 2 }, () => "")).toThrow(
      "source/workspace integration",
    );

    automationSubcommands[0]?.action(context(commandWithOptions({ tier: "3", treePath: source }), false));
    expect(process.exitCode).toBe(1);
  });
});

describe("tree init", () => {
  it("scaffolds a sibling tree, writes workspace.json, and supports JSON output", async () => {
    const workspace = makeTempDir("ft-tree-init-source-");
    makeGitRepo(workspace, "https://github.com/acme/workspace.git");
    makeGitRepo(join(workspace, "packages-api"), "https://github.com/acme/api.git");
    const treeName = "context-tree";
    process.chdir(workspace);
    const { initCommand, initializeWorkspaceRoot } = await import("../commands/tree/init.js");

    const summary = initializeWorkspaceRoot(workspace, {
      scope: "workspace",
      treeMode: "dedicated",
      treePath: `./${treeName}`,
    });

    expect(summary).toMatchObject({
      bindingMode: "workspace-root",
      treeMode: "dedicated",
    });
    expect(summary.workspaceManifest.tree).toBe(treeName);
    expect(summary.workspaceManifest.sources).toContain("packages-api");
    expect(readFileSync(join(workspace, "AGENTS.md"), "utf8")).toContain("workspace");

    initCommand.action(context(commandWithOptions({ scope: "workspace", treePath: `./${treeName}` }), true));
    const payload = JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0])) as { bindingMode: string };
    expect(payload.bindingMode).toBe("workspace-root");
  });

  it("rejects init when the resolved tree path is the same as the workspace root", async () => {
    const workspace = makeTempDir("ft-tree-init-same-root-");
    process.chdir(workspace);
    const { initCommand } = await import("../commands/tree/init.js");

    initCommand.action(context(commandWithOptions({ scope: "workspace", treePath: "." }), false));
    expect(process.exitCode).toBe(1);
    expect(
      vi
        .mocked(console.error)
        .mock.calls.map((call) => String(call[0]))
        .join("\n"),
    ).toContain("workspace root and tree repo resolved to the same path");
  });

  it("rejects --scope repo with a pointer at the workspace recipe", async () => {
    const workspace = makeTempDir("ft-tree-init-repo-scope-");
    const { initializeWorkspaceRoot } = await import("../commands/tree/init.js");

    expect(() =>
      initializeWorkspaceRoot(workspace, {
        scope: "repo",
        treeMode: "dedicated",
        treePath: "./tree",
      }),
    ).toThrow("workspace-scope recipe");
  });
});
