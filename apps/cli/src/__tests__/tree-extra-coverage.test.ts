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

describe("bindSourceRoot and workspace sync helpers", () => {
  it("binds by remote URL and infers workspace metadata", async () => {
    const parent = makeTempDir("ft-tree-bind-url-");
    const source = join(parent, "source");
    makeGitRepo(source, "https://github.com/acme/source.git");
    const calls: string[] = [];
    const { bindSourceRoot } = await import("../commands/tree/bind.js");
    const shared = await import("../commands/tree/shared.js");
    const runCommandSpy = vi.spyOn(shared, "runCommand").mockImplementation((command, args, cwd) => {
      calls.push(`${command} ${args.join(" ")} ${cwd}`);
      if (command === "git" && args[0] === "clone") {
        makeGitRepo(String(args[2]), "https://github.com/acme/team-tree.git");
      }
      return "";
    });

    const summary = bindSourceRoot(
      source,
      {
        mode: "workspace-member",
        treeMode: "shared",
        treeUrl: "https://github.com/acme/team-tree.git",
        workspaceRoot: parent,
      },
      source,
    );

    expect(summary).toMatchObject({ bindingMode: "workspace-member", treeMode: "shared", workspaceId: "source" });
    expect(calls.some((call) => call.includes("git clone https://github.com/acme/team-tree.git"))).toBe(true);
    runCommandSpy.mockRestore();
  });

  it("reports bind validation errors for missing checkout, invalid modes, and same-root binds", async () => {
    const root = makeTempDir("ft-tree-bind-errors-");
    makeGitRepo(root);
    const { bindSourceRoot } = await import("../commands/tree/bind.js");

    expect(() => bindSourceRoot(root, {}, root)).toThrow("Missing --tree-path or --tree-url");
    expect(() => bindSourceRoot(root, { treePath: join(root, "missing") }, root)).toThrow("not a git repository");
    expect(() => bindSourceRoot(root, { treePath: root }, root)).toThrow("same path");

    const tree = join(root, "tree");
    makeGitRepo(tree);
    expect(() => bindSourceRoot(root, { treePath: tree, treeMode: "invalid" as never }, root)).toThrow(
      "Unsupported value for --tree-mode",
    );
    expect(() => bindSourceRoot(root, { treePath: tree, mode: "invalid" as never }, root)).toThrow(
      "Unsupported value for --mode",
    );
  });

  it("syncWorkspaceMembersFromRoot throws when no shared tree can be resolved", async () => {
    const parent = makeTempDir("ft-tree-workspace-sync-extra-");
    const workspace = join(parent, "workspace");
    makeGitRepo(workspace, "https://github.com/acme/workspace.git");
    const { syncWorkspaceMembersFromRoot } = await import("../commands/tree/workspace-sync.js");

    expect(() => syncWorkspaceMembersFromRoot({ workspaceRoot: workspace })).toThrow(
      "Could not resolve the shared tree",
    );
  });
});

describe("tree init and bind", () => {
  it("initializes a repo with nested repo cascade and supports command JSON output", async () => {
    const workspace = makeTempDir("ft-tree-init-source-");
    makeGitRepo(workspace, "https://github.com/acme/workspace.git");
    makeGitRepo(join(workspace, "packages", "api"), "https://github.com/acme/api.git");
    const tree = makeTempDir("ft-tree-init-tree-");
    process.chdir(workspace);
    const { initCommand, initializeSourceRoot } = await import("../commands/tree/init.js");

    const summary = initializeSourceRoot(workspace, "git-repo", {
      recursive: true,
      treeMode: "dedicated",
      treePath: tree,
    });

    expect(summary).toMatchObject({
      bindingMode: "standalone-source",
      recursive: true,
      treeMode: "dedicated",
      treeRoot: tree,
    });
    expect(summary.cascadedRepos?.map((repo) => repo.relativePath)).toEqual([join("packages", "api")]);
    expect(readFileSync(join(workspace, "AGENTS.md"), "utf8")).toContain("dedicated");
    expect(readFileSync(join(tree, "AGENTS.md"), "utf8")).toContain("acme/api");

    initCommand.action(context(commandWithOptions({ recursive: false, treePath: tree }), true));
    const payload = JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0])) as { recursive: boolean };
    expect(payload.recursive).toBe(false);
  });

  it("prints init human summaries, cascaded repos, workspace sync failures, and errors", async () => {
    const workspace = makeTempDir("ft-tree-init-human-");
    makeGitRepo(workspace, "https://github.com/acme/workspace.git");
    makeGitRepo(join(workspace, "packages", "api"), "https://github.com/acme/api.git");
    const tree = makeTempDir("ft-tree-init-human-tree-");
    process.chdir(workspace);
    const { initCommand, initializeSourceRoot } = await import("../commands/tree/init.js");

    const summary = initializeSourceRoot(workspace, "workspace-root", {
      recursive: true,
      scope: "workspace",
      treePath: tree,
      workspaceId: "workspace-1",
    });
    expect(summary).toMatchObject({
      bindingMode: "workspace-root",
      treeMode: "shared",
      workspaceId: "workspace-1",
    });
    expect(process.exitCode).toBeUndefined();
    expect(readFileSync(join(tree, "source-repos.md"), "utf8")).toContain("api");

    process.exitCode = undefined;
    initCommand.action(context(commandWithOptions({ recursive: true, treePath: tree }), false));
    const human = vi
      .mocked(console.log)
      .mock.calls.map((call) => String(call[0]))
      .join("\n");
    expect(human).toContain("Context Tree Init");
    expect(human).toContain("Context Tree Workspace Sync");
    expect(human).toContain(`packages${"/"}api`);

    const repoParent = makeTempDir("ft-tree-init-human-repo-parent-");
    const repoSource = join(repoParent, "source");
    const repoTree = join(repoParent, "source-tree");
    makeGitRepo(repoSource, "https://github.com/acme/source.git");
    makeGitRepo(join(repoSource, "packages", "worker"), "https://github.com/acme/worker.git");
    process.chdir(repoSource);
    initCommand.action(context(commandWithOptions({ recursive: true, treePath: repoTree }), false));
    const repoHuman = vi
      .mocked(console.log)
      .mock.calls.map((call) => String(call[0]))
      .join("\n");
    expect(repoHuman).toContain("Cascaded nested repos:");
    expect(repoHuman).toContain(`packages${"/"}worker`);

    process.chdir(repoSource);
    initCommand.action(context(commandWithOptions({ treePath: "." }), false));
    expect(process.exitCode).toBe(1);
    expect(
      vi
        .mocked(console.error)
        .mock.calls.map((call) => String(call[0]))
        .join("\n"),
    ).toContain("source/workspace root and tree repo resolved to the same path");

    const remoteParent = makeTempDir("ft-tree-init-url-parent-");
    const remoteSource = join(remoteParent, "source");
    const remoteTree = join(remoteParent, "context-tree");
    makeGitRepo(remoteSource, "https://github.com/acme/source.git");
    makeGitRepo(remoteTree, "https://github.com/acme/context-tree.git");
    process.chdir(remoteSource);
    const remoteSummary = initializeSourceRoot(remoteSource, "git-repo", {
      recursive: false,
      treeUrl: "https://github.com/acme/context-tree.git",
    });
    expect(remoteSummary.treeRoot).toBe(remoteTree);
  });

  it("binds remote tree URLs by cloning a sibling checkout", async () => {
    const parent = makeTempDir("ft-tree-bind-parent-");
    const source = join(parent, "source");
    makeGitRepo(source, "https://github.com/acme/source.git");
    const tree = join(parent, "context-tree");
    const { bindSourceRoot } = await import("../commands/tree/bind.js");
    writeTreeRoot(tree);

    const summary = bindSourceRoot(source, { treePath: tree, treeMode: "shared" }, source);
    expect(summary).toMatchObject({ bindingMode: "shared-source", treeMode: "shared", treeRoot: tree });
  });
});
