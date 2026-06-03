import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { syncTreeIdentityFiles } from "../commands/tree/tree-identity.js";
import type { CommandContext } from "../commands/types.js";

const clientMocks = vi.hoisted(() => ({
  applyClientLoggerConfig: vi.fn(),
  FirstTreeHubSDK: vi.fn(),
  SdkError: class SdkError extends Error {},
  setCliBinding: vi.fn(),
}));

const registrationMocks = vi.hoisted(() => ({
  registerAgentCommands: vi.fn(),
  registerChatCommands: vi.fn(),
  registerConfigCommands: vi.fn(),
  registerDaemonCommands: vi.fn(),
  registerDoctorCommand: vi.fn(),
  registerLoginCommand: vi.fn(),
  registerLogoutCommand: vi.fn(),
  registerOrgCommands: vi.fn(),
  registerStatusCommand: vi.fn(),
  registerTreeCommands: vi.fn(),
  registerUpgradeCommand: vi.fn(),
}));

const outputMocks = vi.hoisted(() => ({
  setJsonMode: vi.fn(),
}));

vi.mock("@first-tree/client", () => clientMocks);
vi.mock("../commands/agent/index.js", () => ({ registerAgentCommands: registrationMocks.registerAgentCommands }));
vi.mock("../commands/chat/index.js", () => ({ registerChatCommands: registrationMocks.registerChatCommands }));
vi.mock("../commands/config/index.js", () => ({ registerConfigCommands: registrationMocks.registerConfigCommands }));
vi.mock("../commands/daemon/index.js", () => ({ registerDaemonCommands: registrationMocks.registerDaemonCommands }));
vi.mock("../commands/doctor.js", () => ({ registerDoctorCommand: registrationMocks.registerDoctorCommand }));
vi.mock("../commands/login.js", () => ({ registerLoginCommand: registrationMocks.registerLoginCommand }));
vi.mock("../commands/logout.js", () => ({ registerLogoutCommand: registrationMocks.registerLogoutCommand }));
vi.mock("../commands/org/index.js", () => ({ registerOrgCommands: registrationMocks.registerOrgCommands }));
vi.mock("../commands/status.js", () => ({ registerStatusCommand: registrationMocks.registerStatusCommand }));
vi.mock("../commands/tree/index.js", () => ({ registerTreeCommands: registrationMocks.registerTreeCommands }));
vi.mock("../commands/upgrade.js", () => ({ registerUpgradeCommand: registrationMocks.registerUpgradeCommand }));
vi.mock("../core/output.js", () => outputMocks);

const originalCwd = process.cwd();
const originalHome = process.env.FIRST_TREE_HOME;
const originalJson = process.env.FIRST_TREE_JSON;
const originalLogLevel = process.env.FIRST_TREE_LOG_LEVEL;
let tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function commandWithOptions(options: Record<string, unknown>): Command {
  const command = new Command("test");
  for (const [key, value] of Object.entries(options)) {
    command.setOptionValue(key, value);
  }
  return command;
}

function context(command: Command, json = false): CommandContext {
  return { command, options: { debug: false, json, quiet: false } };
}

function writeTreeIdentityRoot(root: string): void {
  mkdirSync(join(root, ".first-tree"), { recursive: true });
  writeFileSync(join(root, "NODE.md"), "# Context Tree\n");
  writeFileSync(join(root, "AGENTS.md"), "BEGIN CONTEXT-TREE FRAMEWORK\n");
  syncTreeIdentityFiles(root, { treeMode: "shared", treeRepoName: "context-tree" });
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  process.env.FIRST_TREE_HOME = originalHome;
  process.env.FIRST_TREE_JSON = originalJson;
  process.env.FIRST_TREE_LOG_LEVEL = originalLogLevel;
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  process.chdir(originalCwd);
  process.exitCode = undefined;
  if (originalHome === undefined) delete process.env.FIRST_TREE_HOME;
  else process.env.FIRST_TREE_HOME = originalHome;
  if (originalJson === undefined) delete process.env.FIRST_TREE_JSON;
  else process.env.FIRST_TREE_JSON = originalJson;
  if (originalLogLevel === undefined) delete process.env.FIRST_TREE_LOG_LEVEL;
  else process.env.FIRST_TREE_LOG_LEVEL = originalLogLevel;
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe("CLI entry and public exports", () => {
  it("initializes channel env, registers commands, and applies preAction log modes", async () => {
    delete process.env.FIRST_TREE_HOME;
    delete process.env.FIRST_TREE_JSON;
    delete process.env.FIRST_TREE_LOG_LEVEL;
    const parseSpy = vi.spyOn(Command.prototype, "parse").mockImplementation(function parse(this: Command) {
      return this;
    });

    await import("../cli/index.js");

    expect(process.env.FIRST_TREE_HOME).toBeDefined();
    expect(clientMocks.setCliBinding).toHaveBeenCalledWith(expect.objectContaining({ binName: "first-tree-dev" }));
    expect(parseSpy).toHaveBeenCalledTimes(1);
    expect(
      [
        registrationMocks.registerLoginCommand,
        registrationMocks.registerLogoutCommand,
        registrationMocks.registerStatusCommand,
        registrationMocks.registerDoctorCommand,
        registrationMocks.registerUpgradeCommand,
        registrationMocks.registerAgentCommands,
        registrationMocks.registerChatCommands,
        registrationMocks.registerOrgCommands,
        registrationMocks.registerDaemonCommands,
        registrationMocks.registerConfigCommands,
        registrationMocks.registerTreeCommands,
      ].every((mock) => mock.mock.calls.length === 1),
    ).toBe(true);

    const program = parseSpy.mock.contexts[0] as Command;
    const runPreAction = (options: { json?: boolean; verbose?: boolean }) => {
      program.setOptionValue("json", options.json);
      program.setOptionValue("verbose", options.verbose);
      const hooks = (program as unknown as { _lifeCycleHooks: { preAction: Array<(cmd: Command) => void> } })
        ._lifeCycleHooks.preAction;
      hooks.at(-1)?.(program);
    };

    runPreAction({ verbose: true });
    expect(clientMocks.applyClientLoggerConfig).toHaveBeenLastCalledWith({ level: "debug", explicit: true });

    process.env.FIRST_TREE_LOG_LEVEL = "trace";
    runPreAction({});
    expect(clientMocks.applyClientLoggerConfig).toHaveBeenLastCalledWith({ explicit: true });
    delete process.env.FIRST_TREE_LOG_LEVEL;

    process.env.FIRST_TREE_JSON = "1";
    runPreAction({});
    expect(outputMocks.setJsonMode).toHaveBeenLastCalledWith(true);
    expect(clientMocks.applyClientLoggerConfig).toHaveBeenLastCalledWith({ level: "error", explicit: true });
    delete process.env.FIRST_TREE_JSON;

    runPreAction({});
    expect(outputMocks.setJsonMode).toHaveBeenLastCalledWith(false);
    expect(clientMocks.applyClientLoggerConfig).toHaveBeenLastCalledWith({ level: "warn" });
  });

  it("loads the programmatic entrypoint exports", async () => {
    const api = await import("../index.js");

    expect(api.FirstTreeHubSDK).toBe(clientMocks.FirstTreeHubSDK);
    expect(api.SdkError).toBe(clientMocks.SdkError);
    expect(api.HubUrlDerivationError).toBeDefined();
    expect(api.ClientRuntime).toBeDefined();
    expect(api.rotateClientIdWithBackup).toBeTypeOf("function");
  });
});

describe("tree bootstrap, upgrade, and codeowners actions", () => {
  it("bootstraps a tree root and writes the expected scaffolding", async () => {
    const { bootstrapTreeRoot } = await import("../commands/tree/bootstrap.js");
    const root = makeTempDir("ft-bootstrap-action-");

    const summary = bootstrapTreeRoot(root, { treeMode: "shared" });
    expect(summary).toMatchObject({ root, treeMode: "shared" });
    expect(readFileSync(join(root, "NODE.md"), "utf8")).toContain("Context Tree");
  });

  it("runs tree upgrade command for tree roots, source roots, and invalid roots", async () => {
    const { buildSourceIntegrationBlock } = await import("../commands/tree/source-integration.js");
    const { upgradeCommand } = await import("../commands/tree/upgrade.js");
    const tree = makeTempDir("ft-upgrade-tree-");
    writeTreeIdentityRoot(tree);

    upgradeCommand.action(context(commandWithOptions({ treePath: tree }), true));
    if (vi.mocked(console.log).mock.calls.length === 0) {
      throw new Error(
        `upgrade failed: ${vi
          .mocked(console.error)
          .mock.calls.map((call) => String(call[0]))
          .join("\n")}`,
      );
    }
    const treePayload = JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0])) as {
      targetKind: string;
      targetRoot: string;
    };
    expect(treePayload).toMatchObject({ targetKind: "tree", targetRoot: tree });

    const source = makeTempDir("ft-upgrade-source-");
    writeFileSync(
      join(source, "AGENTS.md"),
      buildSourceIntegrationBlock("context-tree", { bindingMode: "shared-source" }),
    );
    writeFileSync(
      join(source, "CLAUDE.md"),
      buildSourceIntegrationBlock("context-tree", { bindingMode: "shared-source" }),
    );
    process.chdir(source);
    upgradeCommand.action(context(commandWithOptions({}), false));
    expect(
      vi
        .mocked(console.log)
        .mock.calls.map((call) => String(call[0]))
        .join("\n"),
    ).toContain("Context Tree Upgrade");

    process.exitCode = undefined;
    const invalid = makeTempDir("ft-upgrade-invalid-");
    upgradeCommand.action(context(commandWithOptions({ treePath: invalid }), false));
    expect(process.exitCode).toBe(1);
  });

  it("collects codeowners edge cases and maps command exit codes", async () => {
    const { collectEntries, formatOwners, generateCodeowners, parseOwners, resolveNodeOwners } = await import(
      "../commands/tree/codeowners-lib.js"
    );
    const { runCodeownersCommand } = await import("../commands/tree/codeowners.js");
    const root = makeTempDir("ft-codeowners-extra-");
    writeFileSync(join(root, "NODE.md"), "---\nowners: [alice, @bob]\n---\n# Root\n");
    mkdirSync(join(root, "domains", "api"), { recursive: true });
    writeFileSync(join(root, "domains", "NODE.md"), "---\nowners: []\n---\n# Domains\n");
    writeFileSync(join(root, "domains", "api", "NODE.md"), "---\nowners: [*]\n---\n# API\n");
    writeFileSync(join(root, "domains", "api", "feature.md"), "---\nowners: [carol, alice]\n---\n# Feature\n");
    mkdirSync(join(root, "node_modules", "ignored"), { recursive: true });
    writeFileSync(join(root, "node_modules", "ignored", "NODE.md"), "---\nowners: [ignored]\n---\n# Ignored\n");

    expect(parseOwners(join(root, "missing.md"))).toBeNull();
    expect(parseOwners(join(root, "domains", "api", "NODE.md"))).toEqual(["*"]);
    expect(formatOwners(["@@alice", "alice", "", "@bob"])).toBe("@alice @bob");
    expect(resolveNodeOwners(join(root, "domains"), root, new Map())).toEqual(["alice", "@bob"]);
    expect(collectEntries(root).some(([pattern]) => pattern.includes("node_modules"))).toBe(false);

    expect(generateCodeowners(root, { check: true })).toBe(1);

    process.chdir(root);
    const command = commandWithOptions({ check: true, alwaysInclude: ["first-tree-gate"] });
    runCodeownersCommand(context(command));
    expect(process.exitCode).toBe(1);
  });
});
