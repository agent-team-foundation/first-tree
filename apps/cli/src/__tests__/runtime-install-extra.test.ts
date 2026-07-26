import { EventEmitter } from "node:events";
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveNpmInvocation } from "../core/npm-invocation.js";

const clientMocks = vi.hoisted(() => ({
  classify: vi.fn(() => ({ kind: "transient", reasonCode: "classified_transient" })),
  getChildProcessRegistry: vi.fn(),
  probeCapabilities: vi.fn(),
  ERROR_KINDS: {
    TRANSIENT: "transient",
  },
}));

const outputMocks = vi.hoisted(() => ({
  fail: vi.fn((code: string, message: string, exitCode: number) => {
    throw new Error(`${code}:${message}:${exitCode}`);
  }),
  isJsonMode: vi.fn(() => false),
  line: vi.fn(),
  result: vi.fn(),
  status: vi.fn(),
}));

const coreIndexMocks = vi.hoisted(() => ({
  installClaudeRuntime: vi.fn(),
  installCodexRuntime: vi.fn(),
  printResults: vi.fn(),
  runtimeProviderChecks: vi.fn(() => [{ detail: "installed", label: "Runtime", ok: true }]),
}));

vi.mock("@first-tree/client", () => clientMocks);

vi.mock("../cli/output.js", () => ({
  fail: outputMocks.fail,
}));

vi.mock("../core/output.js", () => ({
  isJsonMode: outputMocks.isJsonMode,
  print: {
    line: outputMocks.line,
    result: outputMocks.result,
    status: outputMocks.status,
  },
}));

vi.mock("../core/index.js", () => coreIndexMocks);

class MockChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
}

function subcommand(parent: Command, name: string): Command {
  const found = parent.commands.find((entry) => entry.name() === name);
  if (!found) throw new Error(`Missing command ${name}`);
  return found;
}

function prepareSpawn(child = new MockChild()): { child: MockChild; spawn: ReturnType<typeof vi.fn> } {
  const spawn = vi.fn(() => ({ child }));
  clientMocks.getChildProcessRegistry.mockReturnValue({ spawn });
  return { child, spawn };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.exitCode = undefined;
  outputMocks.isJsonMode.mockReturnValue(false);
  clientMocks.classify.mockReturnValue({ kind: "transient", reasonCode: "classified_transient" });
  clientMocks.probeCapabilities.mockResolvedValue({ providers: [] });
});

describe("native runtime installers", () => {
  it("rejects unsafe install specs before spawning npm", async () => {
    const { installClaudeRuntime } = await import("../core/install-claude-runtime.js");
    const { installCodexRuntime } = await import("../core/install-codex-runtime.js");

    await expect(installCodexRuntime("-bad")).resolves.toEqual({
      ok: false,
      reason: 'Refusing to install: invalid npm spec "-bad"',
      retryable: false,
      reasonCode: "invalid_spec",
    });
    await expect(installClaudeRuntime("bad spec")).resolves.toMatchObject({
      ok: false,
      retryable: false,
      reasonCode: "invalid_spec",
    });
    await expect(installClaudeRuntime("-bad")).resolves.toMatchObject({
      ok: false,
      retryable: false,
      reasonCode: "invalid_spec",
    });
    await expect(installCodexRuntime("x".repeat(129))).resolves.toMatchObject({
      ok: false,
      retryable: false,
      reasonCode: "invalid_spec",
    });
    expect(clientMocks.getChildProcessRegistry).not.toHaveBeenCalled();
  });

  it("spawns npm installs and extracts package versions from successful output", async () => {
    const { installCodexRuntime } = await import("../core/install-codex-runtime.js");
    const { child, spawn } = prepareSpawn();

    const result = installCodexRuntime("0.140.0");
    child.stdout.emit("data", Buffer.from("+ @openai/codex@0.140.0\n"));
    child.emit("exit", 0, null);

    await expect(result).resolves.toEqual({ ok: true, installedVersion: "0.140.0" });
    const npm = resolveNpmInvocation(["install", "-g", "@openai/codex@0.140.0"]);
    expect(spawn).toHaveBeenCalledWith(
      npm.command,
      npm.args,
      expect.objectContaining({
        category: "npm-install",
        label: "npm install -g @openai/codex@0.140.0",
        timeoutMs: 480_000,
        stdio: ["ignore", "pipe", "pipe"],
        shell: npm.shell,
      }),
    );
  });

  it("spawns Claude npm installs and extracts package versions from successful output", async () => {
    const { installClaudeRuntime } = await import("../core/install-claude-runtime.js");
    const { child, spawn } = prepareSpawn();

    const result = installClaudeRuntime("2.1.84");
    child.stdout.emit("data", Buffer.from("+ @anthropic-ai/claude-code@2.1.84\n"));
    child.emit("exit", 0, null);

    await expect(result).resolves.toEqual({ ok: true, installedVersion: "2.1.84" });
    const npm = resolveNpmInvocation(["install", "-g", "@anthropic-ai/claude-code@2.1.84"]);
    expect(spawn).toHaveBeenCalledWith(
      npm.command,
      npm.args,
      expect.objectContaining({
        category: "npm-install",
        label: "npm install -g @anthropic-ai/claude-code@2.1.84",
        timeoutMs: 480_000,
        stdio: ["ignore", "pipe", "pipe"],
        shell: npm.shell,
      }),
    );
  });

  it("returns null installedVersion when npm success output does not include a package version", async () => {
    const { installClaudeRuntime } = await import("../core/install-claude-runtime.js");
    const { child } = prepareSpawn();

    const result = installClaudeRuntime();
    child.stdout.emit("data", Buffer.from("added 1 package\n"));
    child.emit("exit", 0, null);

    await expect(result).resolves.toEqual({ ok: true, installedVersion: null });
  });

  it("returns null Codex installedVersion when npm success output omits a package version", async () => {
    const { installCodexRuntime } = await import("../core/install-codex-runtime.js");
    const { child } = prepareSpawn();

    const result = installCodexRuntime();
    child.stdout.emit("data", Buffer.from("added 1 package\n"));
    child.emit("exit", 0, null);

    await expect(result).resolves.toEqual({ ok: true, installedVersion: null });
  });

  it("classifies spawn errors, npm failures, and timeout exits", async () => {
    const { installCodexRuntime } = await import("../core/install-codex-runtime.js");

    const spawnError = prepareSpawn().child;
    const spawnResult = installCodexRuntime("latest");
    spawnError.emit("error", "spawn failed");
    await expect(spawnResult).resolves.toEqual({
      ok: false,
      reason: "spawn failed",
      retryable: true,
      reasonCode: "classified_transient",
    });

    const npmFailure = prepareSpawn().child;
    const failedResult = installCodexRuntime("latest");
    npmFailure.stderr.emit("data", Buffer.from("line 1\nline 2\nline 3\nline 4\n"));
    npmFailure.emit("exit", 1, null);
    await expect(failedResult).resolves.toMatchObject({
      ok: false,
      retryable: true,
      reasonCode: "classified_transient",
    });
    await expect(failedResult).resolves.toMatchObject({
      reason: expect.stringContaining("line 2 | line 3 | line 4"),
    });
    expect(outputMocks.line).toHaveBeenCalledWith("line 1\nline 2\nline 3\nline 4\n");

    const timeout = prepareSpawn().child;
    const timeoutResult = installCodexRuntime("latest");
    timeout.emit("exit", null, "SIGTERM");
    await expect(timeoutResult).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining("killed by signal SIGTERM (timeout)"),
      retryable: true,
      reasonCode: "npm_timeout",
    });
  });

  it("classifies Claude spawn errors, npm failures, and timeout exits", async () => {
    const { installClaudeRuntime } = await import("../core/install-claude-runtime.js");

    const spawnError = prepareSpawn().child;
    const spawnResult = installClaudeRuntime("latest");
    spawnError.emit("error", "spawn denied");
    await expect(spawnResult).resolves.toEqual({
      ok: false,
      reason: "spawn denied",
      retryable: true,
      reasonCode: "classified_transient",
    });

    const npmFailure = prepareSpawn().child;
    const failedResult = installClaudeRuntime("latest");
    npmFailure.stderr.emit("data", Buffer.from("one\ntwo\nthree\nfour\n"));
    npmFailure.emit("exit", 1, null);
    await expect(failedResult).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining("two | three | four"),
      retryable: true,
      reasonCode: "classified_transient",
    });
    expect(outputMocks.line).toHaveBeenCalledWith("one\ntwo\nthree\nfour\n");

    const timeout = prepareSpawn().child;
    const timeoutResult = installClaudeRuntime("latest");
    timeout.emit("exit", null, "SIGTERM");
    await expect(timeoutResult).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining("killed by signal SIGTERM (timeout)"),
      retryable: true,
      reasonCode: "npm_timeout",
    });
  });

  it("maps synchronous registry spawn failures for both runtime installers", async () => {
    const spawnError = Object.assign(new Error("spawn EINVAL"), { code: "EINVAL" });
    clientMocks.getChildProcessRegistry.mockReturnValue({
      spawn: vi.fn(() => {
        throw spawnError;
      }),
    });
    const { installCodexRuntime } = await import("../core/install-codex-runtime.js");
    const { installClaudeRuntime } = await import("../core/install-claude-runtime.js");

    await expect(installCodexRuntime()).resolves.toMatchObject({
      ok: false,
      reason: "spawn EINVAL",
      retryable: true,
      reasonCode: "classified_transient",
    });
    await expect(installClaudeRuntime()).resolves.toMatchObject({
      ok: false,
      reason: "spawn EINVAL",
      retryable: true,
      reasonCode: "classified_transient",
    });
  });
});

describe("daemon native runtime install commands", () => {
  it("prints text-mode success and failure flows for codex and claude installers", async () => {
    const { registerDaemonInstallClaudeCommand } = await import("../commands/daemon/install-claude.js");
    const { registerDaemonInstallCodexCommand } = await import("../commands/daemon/install-codex.js");

    const codexRoot = new Command();
    registerDaemonInstallCodexCommand(codexRoot);
    coreIndexMocks.installCodexRuntime.mockResolvedValueOnce({ ok: true, installedVersion: "0.140.0" });
    await subcommand(codexRoot, "install-codex").parseAsync(["--spec", "0.140.0"], { from: "user" });
    expect(coreIndexMocks.installCodexRuntime).toHaveBeenCalledWith("0.140.0");
    expect(clientMocks.probeCapabilities).toHaveBeenCalled();
    expect(coreIndexMocks.runtimeProviderChecks).toHaveBeenCalledWith({ providers: [] });
    expect(coreIndexMocks.printResults).toHaveBeenCalledWith([{ detail: "installed", label: "Runtime", ok: true }]);
    expect(outputMocks.status).toHaveBeenCalledWith("✓", "Installed @openai/codex@0.140.0");

    const codexFailureRoot = new Command();
    registerDaemonInstallCodexCommand(codexFailureRoot);
    coreIndexMocks.installCodexRuntime.mockResolvedValueOnce({
      ok: false,
      reason: "npm registry timeout",
      retryable: true,
      reasonCode: "classified_transient",
    });
    await subcommand(codexFailureRoot, "install-codex").parseAsync([], { from: "user" });
    expect(outputMocks.status).toHaveBeenLastCalledWith("✖", "Codex install failed: npm registry timeout");
    expect(outputMocks.line).toHaveBeenCalledWith("  This looks transient — retry in a moment.\n\n");
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;

    const claudeRoot = new Command();
    registerDaemonInstallClaudeCommand(claudeRoot);
    coreIndexMocks.installClaudeRuntime.mockResolvedValueOnce({
      ok: false,
      reason: "registry unavailable",
      retryable: true,
      reasonCode: "classified_transient",
    });
    await subcommand(claudeRoot, "install-claude").parseAsync([], { from: "user" });
    expect(outputMocks.status).toHaveBeenLastCalledWith("✖", "Claude install failed: registry unavailable");
    expect(outputMocks.line).toHaveBeenCalledWith("  This looks transient — retry in a moment.\n\n");
    expect(process.exitCode).toBe(1);
  });

  it("uses JSON-mode envelopes for daemon installer success and failure", async () => {
    const { registerDaemonInstallClaudeCommand } = await import("../commands/daemon/install-claude.js");
    const { registerDaemonInstallCodexCommand } = await import("../commands/daemon/install-codex.js");

    const codexRoot = new Command();
    registerDaemonInstallCodexCommand(codexRoot);
    coreIndexMocks.installCodexRuntime.mockResolvedValueOnce({ ok: true, installedVersion: null });
    await subcommand(codexRoot, "install-codex").parseAsync(["--json"], { from: "user" });
    expect(outputMocks.result).toHaveBeenCalledWith({ providers: [] });
    expect(coreIndexMocks.printResults).not.toHaveBeenCalled();

    const claudeRoot = new Command();
    registerDaemonInstallClaudeCommand(claudeRoot);
    coreIndexMocks.installClaudeRuntime.mockResolvedValueOnce({
      ok: false,
      reason: "bad spec",
      retryable: false,
      reasonCode: "invalid_spec",
    });
    await expect(subcommand(claudeRoot, "install-claude").parseAsync(["--json"], { from: "user" })).rejects.toThrow(
      "CLAUDE_INSTALL_FAILED:bad spec:1",
    );
  });

  it("prints Claude text and JSON success flows", async () => {
    const { registerDaemonInstallClaudeCommand } = await import("../commands/daemon/install-claude.js");

    const textRoot = new Command();
    registerDaemonInstallClaudeCommand(textRoot);
    coreIndexMocks.installClaudeRuntime.mockResolvedValueOnce({ ok: true, installedVersion: "2.1.84" });
    await subcommand(textRoot, "install-claude").parseAsync(["--spec", "2.1.84"], { from: "user" });
    expect(coreIndexMocks.installClaudeRuntime).toHaveBeenCalledWith("2.1.84");
    expect(outputMocks.status).toHaveBeenCalledWith("✓", "Installed @anthropic-ai/claude-code@2.1.84");
    expect(coreIndexMocks.printResults).toHaveBeenCalledWith([{ detail: "installed", label: "Runtime", ok: true }]);
    expect(outputMocks.line).toHaveBeenCalledWith(expect.stringContaining("claude-code now reports `ok`"));

    vi.clearAllMocks();
    const unknownVersionRoot = new Command();
    registerDaemonInstallClaudeCommand(unknownVersionRoot);
    coreIndexMocks.installClaudeRuntime.mockResolvedValueOnce({ ok: true, installedVersion: null });
    await subcommand(unknownVersionRoot, "install-claude").parseAsync([], { from: "user" });
    expect(outputMocks.status).toHaveBeenCalledWith("✓", "Installed @anthropic-ai/claude-code");

    vi.clearAllMocks();
    clientMocks.probeCapabilities.mockResolvedValue({ providers: [{ provider: "claude-code", state: "ok" }] });
    const jsonRoot = new Command();
    registerDaemonInstallClaudeCommand(jsonRoot);
    coreIndexMocks.installClaudeRuntime.mockResolvedValueOnce({ ok: true, installedVersion: null });
    await subcommand(jsonRoot, "install-claude").parseAsync(["--json"], { from: "user" });
    expect(outputMocks.result).toHaveBeenCalledWith({ providers: [{ provider: "claude-code", state: "ok" }] });
    expect(coreIndexMocks.printResults).not.toHaveBeenCalled();
  });
});
