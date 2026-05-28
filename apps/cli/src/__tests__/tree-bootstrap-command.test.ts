import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandContext } from "../commands/types.js";

const fsMock = vi.hoisted(() => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  symlinkSync: vi.fn(),
  writeFileSync: vi.fn(),
}));
const agentHooksMock = vi.hoisted(() => ({
  ensureAgentContextHooks: vi.fn(),
  formatAgentContextHookMessages: vi.fn(),
}));
const ruleLayerMock = vi.hoisted(() => ({
  ensureTier0RuleLayer: vi.fn(),
  validateWorkflowPath: vi.fn(),
}));
const sharedMock = vi.hoisted(() => ({
  isGitRepoRoot: vi.fn(),
  repoNameForRoot: vi.fn(),
  runCommand: vi.fn(),
}));
const skillMock = vi.hoisted(() => ({
  copyCanonicalSkills: vi.fn(),
}));
const sourceIntegrationMock = vi.hoisted(() => ({
  ensureWhitepaperSymlink: vi.fn(),
  upsertLocalTreeGitIgnore: vi.fn(),
}));
const sourceRepoIndexMock = vi.hoisted(() => ({
  syncTreeSourceRepoIndex: vi.fn(),
}));
const templateWriteMock = vi.hoisted(() => ({
  describeTemplateWriteResult: vi.fn(),
}));
const treeIdentityMock = vi.hoisted(() => ({
  syncTreeIdentityFiles: vi.fn(),
}));

const consoleErrorMock = vi.spyOn(console, "error").mockImplementation(() => {});
const consoleLogMock = vi.spyOn(console, "log").mockImplementation(() => {});

const MOCKED_MODULES = [
  "node:fs",
  "../commands/tree/agent-context-hooks.js",
  "../commands/tree/binding-state.js",
  "../commands/tree/rule-layer.js",
  "../commands/tree/shared.js",
  "../commands/tree/skill-lib.js",
  "../commands/tree/source-integration.js",
  "../commands/tree/source-repo-index.js",
  "../commands/tree/template-write.js",
  "../commands/tree/tree-identity.js",
  "../commands/tree/tree-templates.js",
];

function setupMocks(): void {
  vi.doMock("node:fs", () => fsMock);
  vi.doMock("../commands/tree/agent-context-hooks.js", () => agentHooksMock);
  vi.doMock("../commands/tree/binding-state.js", () => ({
    TREE_PROGRESS_FILE: ".first-tree/progress.json",
    TREE_VERSION_FILE: ".first-tree/version",
  }));
  vi.doMock("../commands/tree/rule-layer.js", () => ruleLayerMock);
  vi.doMock("../commands/tree/shared.js", () => sharedMock);
  vi.doMock("../commands/tree/skill-lib.js", () => skillMock);
  vi.doMock("../commands/tree/source-integration.js", () => sourceIntegrationMock);
  vi.doMock("../commands/tree/source-repo-index.js", () => sourceRepoIndexMock);
  vi.doMock("../commands/tree/template-write.js", () => templateWriteMock);
  vi.doMock("../commands/tree/tree-identity.js", () => treeIdentityMock);
  vi.doMock("../commands/tree/tree-templates.js", () => ({
    renderCodeReviewerAgentTemplate: () => "code reviewer",
    renderDefaultMemberNode: () => "member",
    renderDeveloperAgentTemplate: () => "developer",
    renderMembersDomainNode: () => "members",
    renderOrgConfigPlaceholder: () => "org",
    renderRootNode: (title: string) => `# ${title}`,
    renderTreeAgentsInstructions: () => "agents",
    renderTreeProgress: () => "progress",
  }));
}

function contextFor(command: Command, json = false): CommandContext {
  return { command, options: { debug: false, json, quiet: false } };
}

describe("tree bootstrap command", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.exitCode = undefined;
    fsMock.existsSync.mockReturnValue(false);
    agentHooksMock.ensureAgentContextHooks.mockReturnValue({ changed: true });
    agentHooksMock.formatAgentContextHookMessages.mockReturnValue(["installed hooks"]);
    ruleLayerMock.ensureTier0RuleLayer.mockReturnValue({ validate: { status: "created" } });
    ruleLayerMock.validateWorkflowPath.mockReturnValue("/repo/.github/workflows/validate.yml");
    sharedMock.isGitRepoRoot.mockReturnValue(false);
    sharedMock.repoNameForRoot.mockReturnValue("tree-root");
    templateWriteMock.describeTemplateWriteResult.mockReturnValue("created workflow");
    setupMocks();
  });

  afterEach(() => {
    for (const moduleId of MOCKED_MODULES) vi.doUnmock(moduleId);
    vi.resetModules();
  });

  it("bootstraps an explicit shared tree path and prints the human summary", async () => {
    const { bootstrapCommand } = await import("../commands/tree/bootstrap.js");
    const command = new Command();
    bootstrapCommand.configure?.(command);
    command.setOptionValue("treePath", "../context-tree");
    command.setOptionValue("treeMode", "shared");

    bootstrapCommand.action(contextFor(command));

    expect(sharedMock.runCommand).toHaveBeenCalledWith("git", ["init"], expect.stringContaining("context-tree"));
    expect(skillMock.copyCanonicalSkills).toHaveBeenCalledWith(expect.stringContaining("context-tree"));
    expect(treeIdentityMock.syncTreeIdentityFiles).toHaveBeenCalledWith(
      expect.stringContaining("context-tree"),
      expect.objectContaining({ treeMode: "shared", treeRepoName: "tree-root" }),
    );
    expect(sourceRepoIndexMock.syncTreeSourceRepoIndex).toHaveBeenCalledWith(expect.stringContaining("context-tree"));
    expect(consoleLogMock).toHaveBeenCalledWith("Context Tree Bootstrap\n");
    expect(consoleLogMock).toHaveBeenCalledWith("  installed hooks");
  });

  it("supports --here json output and preserves existing files", async () => {
    fsMock.existsSync.mockReturnValue(true);
    sharedMock.isGitRepoRoot.mockReturnValue(true);
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("/repo");
    const { bootstrapCommand } = await import("../commands/tree/bootstrap.js");
    const command = new Command();
    bootstrapCommand.configure?.(command);
    command.setOptionValue("here", true);

    bootstrapCommand.action(contextFor(command, true));

    expect(sharedMock.runCommand).not.toHaveBeenCalled();
    expect(fsMock.writeFileSync).not.toHaveBeenCalled();
    expect(fsMock.symlinkSync).not.toHaveBeenCalled();
    expect(consoleLogMock).toHaveBeenCalledWith(expect.stringContaining('"treeMode": "dedicated"'));
    cwdSpy.mockRestore();
  });

  it("reports option errors through exitCode", async () => {
    const { bootstrapCommand } = await import("../commands/tree/bootstrap.js");
    const command = new Command();
    bootstrapCommand.configure?.(command);

    bootstrapCommand.action(contextFor(command));

    expect(process.exitCode).toBe(1);
    expect(consoleErrorMock).toHaveBeenCalledWith("Pass either `--here` or `--tree-path <path>`.");
  });
});
