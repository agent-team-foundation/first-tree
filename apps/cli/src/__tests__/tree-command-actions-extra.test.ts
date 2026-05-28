import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandContext } from "../commands/types.js";

const buildTreeFirstContextBundleMock = vi.fn();
const bootstrapTreeRootMock = vi.fn();
const consoleErrorMock = vi.spyOn(console, "error").mockImplementation(() => {});
const consoleLogMock = vi.spyOn(console, "log").mockImplementation(() => {});
const copyCanonicalSkillsMock = vi.fn();
const deriveDefaultEntrypointMock = vi.fn();
const describeTemplateWriteResultMock = vi.fn();
const discoverWorkspaceReposMock = vi.fn();
const ensureAgentContextHooksMock = vi.fn();
const ensureTier0RuleLayerMock = vi.fn();
const ensureWhitepaperSymlinkMock = vi.fn();
const existsSyncMock = vi.fn();
const formatAgentContextHookMessagesMock = vi.fn();
const inspectCurrentWorkingTreeMock = vi.fn();
const isGitRepoRootMock = vi.fn();
const listKnownTreeCodeReposMock = vi.fn();
const parseGitHubRemoteUrlMock = vi.fn();
const readBundledSkillVersionMock = vi.fn();
const readGitRemoteUrlMock = vi.fn();
const readSourceBindingContractMock = vi.fn();
const readTreeIdentityContractMock = vi.fn();
const removeSourceStateMock = vi.fn();
const repoNameForRootMock = vi.fn();
const resolveRepoRootMock = vi.fn();
const runCommandMock = vi.fn();
const syncTreeIdentityFilesMock = vi.fn();
const syncTreeSourceRepoIndexMock = vi.fn();
const syncWorkspaceMembersFromRootMock = vi.fn();
const upsertLocalTreeGitIgnoreMock = vi.fn();
const upsertSourceIntegrationFilesMock = vi.fn();
const upsertTreeCodeRepoRegistryMock = vi.fn();
const validateWorkflowPathMock = vi.fn();
const writeFileSyncMock = vi.fn();

function setupTreeMocks(): void {
  vi.doMock("node:fs", () => ({ existsSync: existsSyncMock, writeFileSync: writeFileSyncMock }));
  vi.doMock("../commands/tree/agent-context-hooks.js", () => ({
    ensureAgentContextHooks: ensureAgentContextHooksMock,
    formatAgentContextHookMessages: formatAgentContextHookMessagesMock,
  }));
  vi.doMock("../commands/tree/binding-contract.js", () => ({
    readSourceBindingContract: readSourceBindingContractMock,
  }));
  vi.doMock("../commands/tree/binding-state.js", () => ({
    buildTreeId: (name: string) => `${name}-id`,
    deriveDefaultEntrypoint: deriveDefaultEntrypointMock,
    removeSourceState: removeSourceStateMock,
    TREE_SOURCE_REPOS_FILE: ".first-tree/source-repos.json",
    TREE_VERSION_FILE: ".first-tree/version",
  }));
  vi.doMock("../commands/tree/bootstrap.js", () => ({
    bootstrapTreeRoot: bootstrapTreeRootMock,
  }));
  vi.doMock("../commands/tree/inspect.js", () => ({
    inspectCurrentWorkingTree: inspectCurrentWorkingTreeMock,
  }));
  vi.doMock("../commands/tree/rule-layer.js", () => ({
    ensureTier0RuleLayer: ensureTier0RuleLayerMock,
    validateWorkflowPath: validateWorkflowPathMock,
  }));
  vi.doMock("../commands/tree/shared.js", () => ({
    discoverWorkspaceRepos: discoverWorkspaceReposMock,
    isGitRepoRoot: isGitRepoRootMock,
    parseGitHubRemoteUrl: parseGitHubRemoteUrlMock,
    readGitRemoteUrl: readGitRemoteUrlMock,
    repoNameForRoot: repoNameForRootMock,
    resolveRepoRoot: resolveRepoRootMock,
    runCommand: runCommandMock,
  }));
  vi.doMock("../commands/tree/skill-lib.js", () => ({
    copyCanonicalSkills: copyCanonicalSkillsMock,
    readBundledSkillVersion: readBundledSkillVersionMock,
  }));
  vi.doMock("../commands/tree/source-integration.js", () => ({
    ensureWhitepaperSymlink: ensureWhitepaperSymlinkMock,
    upsertLocalTreeGitIgnore: upsertLocalTreeGitIgnoreMock,
    upsertSourceIntegrationFiles: upsertSourceIntegrationFilesMock,
  }));
  vi.doMock("../commands/tree/source-repo-index.js", () => ({
    syncTreeSourceRepoIndex: syncTreeSourceRepoIndexMock,
  }));
  vi.doMock("../commands/tree/template-write.js", () => ({
    describeTemplateWriteResult: describeTemplateWriteResultMock,
  }));
  vi.doMock("../commands/tree/tree-first-context.js", () => ({
    buildTreeFirstContextBundle: buildTreeFirstContextBundleMock,
  }));
  vi.doMock("../commands/tree/tree-identity.js", () => ({
    readTreeIdentityContract: readTreeIdentityContractMock,
    syncTreeIdentityFiles: syncTreeIdentityFilesMock,
  }));
  vi.doMock("../commands/tree/tree-repo-registry.js", () => ({
    listKnownTreeCodeRepos: listKnownTreeCodeReposMock,
    upsertTreeCodeRepoRegistry: upsertTreeCodeRepoRegistryMock,
  }));
  vi.doMock("../commands/tree/workspace-sync.js", () => ({
    syncWorkspaceMembersFromRoot: syncWorkspaceMembersFromRootMock,
  }));
}

function contextFor(command: Command, json = false): CommandContext {
  return { command, options: { debug: false, json, quiet: false } };
}

describe("tree command action modules", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.exitCode = undefined;
    buildTreeFirstContextBundleMock.mockReturnValue({ additionalContext: "Tree context" });
    bootstrapTreeRootMock.mockReturnValue({
      root: "/work/source-context",
      treeMode: "shared",
      treeRepoName: "source-context",
    });
    deriveDefaultEntrypointMock.mockReturnValue("/repo");
    describeTemplateWriteResultMock.mockReturnValue("updated workflow");
    discoverWorkspaceReposMock.mockReturnValue([
      { kind: "nested-git-repo", name: "child", relativePath: "packages/child", root: "/work/source/packages/child" },
    ]);
    ensureAgentContextHooksMock.mockReturnValue({ changed: true });
    ensureTier0RuleLayerMock.mockReturnValue({ validate: { status: "created" } });
    existsSyncMock.mockReturnValue(true);
    formatAgentContextHookMessagesMock.mockReturnValue(["installed hook"]);
    inspectCurrentWorkingTreeMock.mockReturnValue({ rootPath: "/work/source", role: "unbound-source-repo" });
    isGitRepoRootMock.mockReturnValue(true);
    listKnownTreeCodeReposMock.mockReturnValue([{ name: "source", url: "https://github.com/acme/source.git" }]);
    parseGitHubRemoteUrlMock.mockImplementation((value: string) => {
      const https = value.match(/^https:\/\/github\.com\/([^/]+)\/([^/.]+)(?:\.git)?$/u);
      if (https) return { host: "github.com", owner: https[1], repo: https[2] };
      const ssh = value.match(/^git@github\.com:([^/]+)\/([^/.]+)(?:\.git)?$/u);
      if (ssh) return { host: "github.com", owner: ssh[1], repo: ssh[2] };
      return null;
    });
    readBundledSkillVersionMock.mockReturnValue("0.4.0-test");
    readGitRemoteUrlMock.mockImplementation((root: string, remote = "origin") => {
      if (root.includes("source-context") && remote === "origin") return "https://github.com/acme/source-context";
      if (root.includes("source") && remote === "origin") return "https://github.com/acme/source.git";
      return undefined;
    });
    readSourceBindingContractMock.mockReturnValue({
      bindingMode: "shared-source",
      entrypoint: "/repos/source",
      treeMode: "shared",
      treeRepoName: "source-context",
      treeRepoUrl: "https://github.com/acme/source-context.git",
      workspaceId: "workspace-1",
    });
    readTreeIdentityContractMock.mockReturnValue({
      treeMode: "shared",
      treeRepoName: "source-context",
    });
    removeSourceStateMock.mockReturnValue(undefined);
    repoNameForRootMock.mockImplementation((root: string) => (root.includes("context") ? "source-context" : "source"));
    resolveRepoRootMock.mockReturnValue("/work/source");
    runCommandMock.mockReturnValue("");
    syncWorkspaceMembersFromRootMock.mockReturnValue(false);
    validateWorkflowPathMock.mockReturnValue("/work/source-context/.github/workflows/validate.yml");
    setupTreeMocks();
  });

  it("runs tree integrate with inferred modes, workspace metadata, and json output", async () => {
    const { integrateCommand } = await import("../commands/tree/integrate.js");
    const command = new Command();
    integrateCommand.configure?.(command);
    command.setOptionValue("treePath", "../source-context");
    command.setOptionValue("mode", "workspace-member");
    command.setOptionValue("workspaceId", "workspace-1");

    integrateCommand.action(contextFor(command, true));

    expect(copyCanonicalSkillsMock).toHaveBeenCalledWith("/work/source");
    expect(ensureWhitepaperSymlinkMock).toHaveBeenCalledWith("/work/source");
    expect(upsertLocalTreeGitIgnoreMock).toHaveBeenCalledWith("/work/source");
    expect(upsertSourceIntegrationFilesMock).toHaveBeenCalledWith(
      "/work/source",
      "source-context",
      expect.objectContaining({
        bindingMode: "workspace-member",
        entrypoint: "/repo",
        treeMode: "dedicated",
        treeRepoUrl: "https://github.com/acme/source-context",
        workspaceId: "workspace-1",
      }),
    );
    expect(removeSourceStateMock).toHaveBeenCalledWith("/work/source");
    expect(consoleLogMock).toHaveBeenCalledWith(expect.stringContaining('"bindingMode": "workspace-member"'));
  });

  it("prints integrate summaries and reports invalid inputs without throwing", async () => {
    const { integrateCommand } = await import("../commands/tree/integrate.js");
    const command = new Command();
    integrateCommand.configure?.(command);
    command.setOptionValue("treePath", "../shared-tree");
    command.setOptionValue("treeMode", "shared");
    command.setOptionValue("mode", "source");

    integrateCommand.action(contextFor(command));
    expect(upsertSourceIntegrationFilesMock).toHaveBeenLastCalledWith(
      "/work/source",
      "source",
      expect.objectContaining({ bindingMode: "shared-source", treeMode: "shared" }),
    );
    expect(consoleLogMock).toHaveBeenCalledWith("Context Tree Integrate\n");

    command.setOptionValue("treeMode", "bad-mode");
    integrateCommand.action(contextFor(command));
    expect(process.exitCode).toBe(1);
    expect(consoleErrorMock).toHaveBeenCalledWith("Unsupported value for --tree-mode: bad-mode");
  });

  it("runs claude hook and inject actions for json, text, payload, and empty states", async () => {
    const { claudeHookCommand } = await import("../commands/tree/claude-hook.js");
    const { injectCommand } = await import("../commands/tree/inject.js");

    const hookCommand = new Command();
    claudeHookCommand.configure?.(hookCommand);
    hookCommand.setOptionValue("root", "/work/source");
    claudeHookCommand.action(contextFor(hookCommand));
    expect(consoleLogMock).toHaveBeenCalledWith("installed hook");

    formatAgentContextHookMessagesMock.mockReturnValue([]);
    claudeHookCommand.action(contextFor(hookCommand));
    expect(consoleLogMock).toHaveBeenCalledWith(
      "Managed Claude Code and Codex SessionStart hooks are already current.",
    );

    claudeHookCommand.action(contextFor(hookCommand, true));
    expect(consoleLogMock).toHaveBeenCalledWith(expect.stringContaining('"targetRoot": "/work/source"'));

    injectCommand.action(contextFor(new Command()));
    expect(consoleLogMock).toHaveBeenCalledWith(
      JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "Tree context" } }),
    );

    buildTreeFirstContextBundleMock.mockReturnValue(null);
    injectCommand.action(contextFor(new Command()));
    expect(buildTreeFirstContextBundleMock).toHaveBeenCalled();
  });

  it("runs tree bind for cloned remotes, workspace metadata, registry updates, and invalid mode errors", async () => {
    existsSyncMock.mockReturnValueOnce(false);
    readTreeIdentityContractMock.mockReturnValue(undefined);

    const { bindCommand } = await import("../commands/tree/bind.js");
    const command = new Command();
    bindCommand.configure?.(command);
    command.setOptionValue("treeUrl", "https://github.com/acme/source-context.git");
    command.setOptionValue("treeMode", "shared");
    command.setOptionValue("mode", "workspace-member");
    command.setOptionValue("workspaceId", "workspace-1");

    bindCommand.action(contextFor(command, true));

    expect(runCommandMock).toHaveBeenCalledWith(
      "git",
      ["clone", "https://github.com/acme/source-context.git", "/work/source-context"],
      "/work",
    );
    expect(bootstrapTreeRootMock).toHaveBeenCalledWith("/work/source-context", { treeMode: "shared" });
    expect(upsertSourceIntegrationFilesMock).toHaveBeenCalledWith(
      "/work/source",
      "source-context",
      expect.objectContaining({
        bindingMode: "workspace-member",
        entrypoint: "/repo",
        treeMode: "shared",
        treeRepoUrl: "https://github.com/acme/source-context.git",
        workspaceId: "workspace-1",
      }),
    );
    expect(syncTreeIdentityFilesMock).toHaveBeenCalledWith(
      "/work/source-context",
      expect.objectContaining({
        publishedTreeUrl: "https://github.com/acme/source-context.git",
        treeMode: "shared",
        treeRepoName: "source-context",
      }),
    );
    expect(upsertTreeCodeRepoRegistryMock).toHaveBeenCalledWith(
      "/work/source-context",
      "https://github.com/acme/source.git",
    );
    expect(syncTreeSourceRepoIndexMock).toHaveBeenCalledWith("/work/source-context");
    expect(consoleLogMock).toHaveBeenCalledWith(expect.stringContaining('"bindingMode": "workspace-member"'));

    vi.clearAllMocks();
    readTreeIdentityContractMock.mockReturnValue({ treeMode: "shared", treeRepoName: "source-context" });
    command.setOptionValue("mode", "bad-mode");
    bindCommand.action(contextFor(command));

    expect(process.exitCode).toBe(1);
    expect(consoleErrorMock).toHaveBeenCalledWith("Unsupported value for --mode: bad-mode");
  });

  it("runs tree publish through remote creation, identity sync, source refresh, and text output", async () => {
    const { publishCommand } = await import("../commands/tree/publish.js");
    runCommandMock.mockImplementation((command: string, args: string[]) => {
      if (command === "git" && args[0] === "remote" && args[1] === "get-url") throw new Error("missing remote");
      if (command === "gh" && args[0] === "repo" && args[1] === "view") throw new Error("missing repo");
      return "";
    });
    readGitRemoteUrlMock.mockImplementation((root: string, remote = "origin") => {
      if (root === "/work/source" && remote === "upstream") return "git@github.com:acme/source.git";
      return undefined;
    });
    repoNameForRootMock.mockImplementation((root: string) =>
      root.includes("source-context") ? "source-context" : "source",
    );

    const command = new Command();
    publishCommand.configure?.(command);
    command.setOptionValue("treePath", "../source-context");
    command.setOptionValue("sourceRepo", "/work/source");
    command.setOptionValue("sourceRemote", "upstream");

    publishCommand.action(contextFor(command));

    expect(runCommandMock).toHaveBeenCalledWith(
      "git",
      ["remote", "add", "origin", "https://github.com/acme/source-context.git"],
      expect.stringContaining("source-context"),
    );
    expect(runCommandMock).toHaveBeenCalledWith(
      "gh",
      [
        "repo",
        "create",
        "acme/source-context",
        "--private",
        "--source",
        expect.stringContaining("source-context"),
        "--remote",
        "origin",
      ],
      expect.stringContaining("source-context"),
    );
    expect(syncTreeIdentityFilesMock).toHaveBeenCalledWith(
      expect.stringContaining("source-context"),
      expect.objectContaining({ publishedTreeUrl: "https://github.com/acme/source-context.git" }),
    );
    expect(removeSourceStateMock).toHaveBeenCalledWith("/work/source");
    expect(consoleLogMock).toHaveBeenCalledWith("Context Tree Publish\n");

    vi.clearAllMocks();
    readTreeIdentityContractMock.mockReturnValue({
      publishedTreeUrl: "https://github.com/acme/source-context.git",
      treeMode: "shared",
      treeRepoName: "source-context",
    });
    listKnownTreeCodeReposMock.mockReturnValue([]);
    const jsonCommand = new Command();
    publishCommand.configure?.(jsonCommand);
    jsonCommand.setOptionValue("treePath", "../source-context");
    publishCommand.action(contextFor(jsonCommand, true));

    expect(consoleLogMock).toHaveBeenCalledWith(
      expect.stringContaining('"publishedTreeUrl": "https://github.com/acme/source-context.git"'),
    );
  });

  it("runs tree init for workspace sync, repo cascade failures, json output, and command errors", async () => {
    readTreeIdentityContractMock
      .mockReturnValueOnce(undefined)
      .mockReturnValue({ treeMode: "shared", treeRepoName: "source-context" });

    const { initCommand } = await import("../commands/tree/init.js");
    const workspaceCommand = new Command();
    initCommand.configure?.(workspaceCommand);
    workspaceCommand.setOptionValue("scope", "workspace");
    workspaceCommand.setOptionValue("treePath", "../source-context");
    workspaceCommand.setOptionValue("workspaceId", "workspace-1");

    initCommand.action(contextFor(workspaceCommand, true));

    expect(bootstrapTreeRootMock).toHaveBeenCalledWith(expect.stringContaining("source-context"), {
      treeMode: "shared",
    });
    expect(syncWorkspaceMembersFromRootMock).toHaveBeenCalledWith({
      treePath: expect.stringContaining("source-context"),
      workspaceId: "workspace-1",
      workspaceRoot: "/work/source",
    });
    expect(consoleLogMock).toHaveBeenCalledWith(expect.stringContaining('"bindingMode": "workspace-root"'));

    vi.clearAllMocks();
    readTreeIdentityContractMock.mockReturnValue({ treeMode: "shared", treeRepoName: "source-context" });
    isGitRepoRootMock.mockImplementation((root: string) => !root.includes("packages/child"));
    upsertSourceIntegrationFilesMock.mockImplementation((root: string) => {
      if (root.includes("packages/child")) throw new Error("blocked child");
    });
    const repoCommand = new Command();
    initCommand.configure?.(repoCommand);
    repoCommand.setOptionValue("treePath", "../source-context");
    initCommand.action(contextFor(repoCommand));

    expect(process.exitCode).toBe(1);
    expect(consoleErrorMock).toHaveBeenCalledWith(
      expect.stringContaining("Failed to onboard nested repo packages/child"),
    );
    expect(consoleLogMock).toHaveBeenCalledWith("Context Tree Init\n");

    vi.clearAllMocks();
    inspectCurrentWorkingTreeMock.mockImplementation(() => {
      throw new Error("inspection failed");
    });
    initCommand.action(contextFor(new Command()));

    expect(process.exitCode).toBe(1);
    expect(consoleErrorMock).toHaveBeenCalledWith("inspection failed");
  });

  it("runs tree upgrade for source, tree, json, text, and unbound target errors", async () => {
    const { upgradeCommand } = await import("../commands/tree/upgrade.js");
    readTreeIdentityContractMock.mockReturnValue({
      publishedTreeUrl: "https://github.com/acme/source-context.git",
      treeMode: "shared",
      treeRepoName: "source-context",
    });

    const treeCommand = new Command();
    upgradeCommand.configure?.(treeCommand);
    treeCommand.setOptionValue("treePath", "../source-context");
    upgradeCommand.action(contextFor(treeCommand));

    expect(writeFileSyncMock).toHaveBeenCalledWith(
      expect.stringContaining("source-context/.first-tree/version"),
      "0.4.0-test\n",
    );
    expect(syncTreeIdentityFilesMock).toHaveBeenCalledWith(
      expect.stringContaining("source-context"),
      expect.objectContaining({ treeRepoName: "source-context" }),
    );
    expect(consoleLogMock).toHaveBeenCalledWith("Context Tree Upgrade\n");
    expect(consoleLogMock).toHaveBeenCalledWith("  updated workflow");
    expect(consoleLogMock).toHaveBeenCalledWith("  installed hook");

    vi.clearAllMocks();
    readTreeIdentityContractMock.mockReturnValue(undefined);
    const sourceCommand = new Command();
    upgradeCommand.configure?.(sourceCommand);
    upgradeCommand.action(contextFor(sourceCommand, true));

    expect(upsertSourceIntegrationFilesMock).toHaveBeenCalledWith(
      process.cwd(),
      "source-context",
      expect.objectContaining({ bindingMode: "shared-source" }),
    );
    expect(consoleLogMock).toHaveBeenCalledWith(expect.stringContaining('"targetKind": "source"'));

    vi.clearAllMocks();
    readSourceBindingContractMock.mockReturnValue(undefined);
    upgradeCommand.action(contextFor(new Command()));

    expect(process.exitCode).toBe(1);
    expect(consoleErrorMock).toHaveBeenCalledWith(
      "This folder is neither a bound source/workspace root nor a tree repo. Run `first-tree tree init` first, or pass `--tree-path <path>`.",
    );
  });
});
