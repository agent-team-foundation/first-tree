import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const clientMocks = vi.hoisted(() => ({
  applyClientLoggerConfig: vi.fn(),
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    warn: vi.fn(),
  })),
  FirstTreeHubSDK: vi.fn(),
  SdkError: class SdkError extends Error {},
  setCliBinding: vi.fn(),
}));

const registrationMocks = vi.hoisted(() => ({
  registerAgentCommands: vi.fn(),
  registerChatCommands: vi.fn(),
  registerComputerCommands: vi.fn(),
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

const migrationMocks = vi.hoisted(() => ({
  runLegacyGithubScanMigration: vi.fn(),
}));

vi.mock("@first-tree/client", () => clientMocks);
vi.mock("../commands/agent/index.js", () => ({ registerAgentCommands: registrationMocks.registerAgentCommands }));
vi.mock("../commands/chat/index.js", () => ({ registerChatCommands: registrationMocks.registerChatCommands }));
vi.mock("../commands/computer/index.js", () => ({
  registerComputerCommands: registrationMocks.registerComputerCommands,
}));
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
vi.mock("../core/retire-github-scan-launchd.js", () => migrationMocks);

const originalCwd = process.cwd();
const originalHome = process.env.FIRST_TREE_HOME;
const originalJson = process.env.FIRST_TREE_JSON;
const originalLogLevel = process.env.FIRST_TREE_LOG_LEVEL;
const originalProcessTitle = process.title;
const originalArgv = process.argv;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  process.env.FIRST_TREE_HOME = originalHome;
  process.env.FIRST_TREE_JSON = originalJson;
  process.env.FIRST_TREE_LOG_LEVEL = originalLogLevel;
  process.argv = ["node", "first-tree", "status"];
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
  process.title = originalProcessTitle;
  process.argv = originalArgv;
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
    expect(process.title).toBe("first-tree-dev");
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
        registrationMocks.registerComputerCommands,
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

  it("keeps help and version invocations outside the migration boundary", async () => {
    for (const args of [["--help"], ["--version"], ["help", "status"]]) {
      vi.resetModules();
      vi.clearAllMocks();
      process.argv = ["node", "first-tree", ...args];
      const parseSpy = vi.spyOn(Command.prototype, "parse").mockImplementation(function parse(this: Command) {
        return this;
      });
      await import("../cli/index.js");
      // The migration must be a preAction concern, never a module-load side
      // effect — Commander keeps help/version rendering out of preAction.
      expect(migrationMocks.runLegacyGithubScanMigration).not.toHaveBeenCalled();
      parseSpy.mockRestore();
    }
  });

  it("runs the startup migration inside preAction, before output-mode setup", async () => {
    process.argv = ["node", "first-tree", "daemon", "start"];
    const parseSpy = vi.spyOn(Command.prototype, "parse").mockImplementation(function parse(this: Command) {
      return this;
    });

    await import("../cli/index.js");
    expect(migrationMocks.runLegacyGithubScanMigration).not.toHaveBeenCalled();

    const program = parseSpy.mock.contexts[0] as Command;
    const hooks = (program as unknown as { _lifeCycleHooks: { preAction: Array<(cmd: Command) => void> } })
      ._lifeCycleHooks.preAction;
    hooks.at(-1)?.(program);

    expect(migrationMocks.runLegacyGithubScanMigration).toHaveBeenCalledTimes(1);
    const migrationOrder = migrationMocks.runLegacyGithubScanMigration.mock.invocationCallOrder[0];
    const jsonModeOrder = outputMocks.setJsonMode.mock.invocationCallOrder[0];
    expect(migrationOrder).toBeDefined();
    expect(jsonModeOrder).toBeDefined();
    expect(migrationOrder).toBeLessThan(jsonModeOrder ?? Number.NEGATIVE_INFINITY);
    parseSpy.mockRestore();
  });

  it("never lets a migration failure break the command hook", async () => {
    migrationMocks.runLegacyGithubScanMigration.mockImplementation(() => {
      throw new Error("sweep exploded");
    });
    const parseSpy = vi.spyOn(Command.prototype, "parse").mockImplementation(function parse(this: Command) {
      return this;
    });

    await import("../cli/index.js");
    const program = parseSpy.mock.contexts[0] as Command;
    const hooks = (program as unknown as { _lifeCycleHooks: { preAction: Array<(cmd: Command) => void> } })
      ._lifeCycleHooks.preAction;
    expect(() => hooks.at(-1)?.(program)).not.toThrow();
    expect(outputMocks.setJsonMode).toHaveBeenCalled();
    parseSpy.mockRestore();
  });

  it("covers a portable self-update that switches current without any restart hook", async () => {
    // Model the X-side portable updater: it flips `current` to Y and exits
    // without running Y. The first eligible Y command owns the sweep.
    process.env.FIRST_TREE_INSTALL_MODE = "portable";
    process.env.FIRST_TREE_PORTABLE_ROOT = "/tmp/portable/current";
    try {
      const parseSpy = vi.spyOn(Command.prototype, "parse").mockImplementation(function parse(this: Command) {
        return this;
      });

      await import("../cli/index.js");
      const program = parseSpy.mock.contexts[0] as Command;
      const hooks = (program as unknown as { _lifeCycleHooks: { preAction: Array<(cmd: Command) => void> } })
        ._lifeCycleHooks.preAction;
      hooks.at(-1)?.(program);
      expect(migrationMocks.runLegacyGithubScanMigration).toHaveBeenCalledTimes(1);
      parseSpy.mockRestore();
    } finally {
      delete process.env.FIRST_TREE_INSTALL_MODE;
      delete process.env.FIRST_TREE_PORTABLE_ROOT;
    }
  });

  it("loads the programmatic entrypoint exports", async () => {
    const api = await import("../index.js");

    expect(api.FirstTreeHubSDK).toBe(clientMocks.FirstTreeHubSDK);
    expect(api.SdkError).toBe(clientMocks.SdkError);
    expect(api.HubUrlDerivationError).toBeDefined();
    expect(api.ClientRuntime).toBeDefined();
    expect(api.ContextTreeSeedPreflightCliError).toBeDefined();
    expect(api.preflightContextTreeSeed).toBeDefined();
    expect(api.ContextTreeWritePreflightCliError).toBeDefined();
    expect(api.preflightContextTreeWrite).toBeDefined();
    expect("rotateClientIdWithBackup" in api).toBe(false);
  });
});
