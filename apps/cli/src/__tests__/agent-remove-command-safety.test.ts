import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import type { MockInstance } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const commandMocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  defaultConfigDir: vi.fn(),
  defaultHome: vi.fn(),
  ensureFreshAccessToken: vi.fn(),
  findStaleAliases: vi.fn(),
  formatStaleReason: vi.fn(),
  listMyAgents: vi.fn(),
  readClientId: vi.fn(),
  removeLocalAgent: vi.fn(),
  resolveServerUrl: vi.fn(),
}));

const filesystemProbeMocks = vi.hoisted(() => ({
  existsSync: vi.fn(),
  lstatSync: vi.fn(),
  realpathSync: vi.fn(),
  statSync: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, ...filesystemProbeMocks };
});

vi.mock("@first-tree/client", () => ({
  FirstTreeHubSDK: class {
    readonly listMyAgents = commandMocks.listMyAgents;
  },
}));

vi.mock("@first-tree/shared/config", () => ({
  defaultConfigDir: commandMocks.defaultConfigDir,
  defaultHome: commandMocks.defaultHome,
}));

vi.mock("@inquirer/prompts", () => ({ confirm: commandMocks.confirm }));

vi.mock("../commands/_shared/local-agent.js", () => ({
  readClientId: commandMocks.readClientId,
}));

vi.mock("../core/index.js", () => ({
  CLI_USER_AGENT: "first-tree-command-safety-test",
  ensureFreshAccessToken: commandMocks.ensureFreshAccessToken,
  findStaleAliases: commandMocks.findStaleAliases,
  formatStaleReason: commandMocks.formatStaleReason,
  removeLocalAgent: commandMocks.removeLocalAgent,
  resolveServerUrl: commandMocks.resolveServerUrl,
}));

import {
  INVALID_LOCAL_AGENT_NAME_MESSAGE,
  LocalAgentRemovalError,
  UNKNOWN_LOCAL_AGENT_REMOVAL_MESSAGE,
} from "../core/agent-prune.js";
import { setJsonMode } from "../core/output.js";

const originalExit = process.exit;
const originalExitCode = process.exitCode;

let stderrChunks: string[];
let stderrSpy: MockInstance<typeof process.stderr.write>;

async function runRemoveArgs(args: string[]): Promise<void> {
  const { registerAgentRemoveCommand } = await import("../commands/agent/remove.js");
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeErr: () => undefined, writeOut: () => undefined });
  const agent = program.command("agent");
  registerAgentRemoveCommand(agent);
  await program.parseAsync(["node", "test", "agent", "remove", ...args]);
}

async function runRemove(name: string): Promise<void> {
  await runRemoveArgs([name]);
}

async function runPrune(args: string[]): Promise<void> {
  const { registerAgentPruneCommand } = await import("../commands/agent/prune.js");
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeErr: () => undefined, writeOut: () => undefined });
  const agent = program.command("agent");
  registerAgentPruneCommand(agent);
  await program.parseAsync(["node", "test", "agent", "prune", ...args]);
}

function output(): string {
  return stderrChunks.join("");
}

function failureEnvelope(): unknown {
  return JSON.parse(output().trim());
}

beforeEach(() => {
  commandMocks.confirm.mockReset().mockResolvedValue(true);
  commandMocks.defaultConfigDir.mockReset().mockReturnValue("/state/config");
  commandMocks.defaultHome.mockReset().mockReturnValue("/state");
  commandMocks.ensureFreshAccessToken.mockReset().mockResolvedValue("access-token");
  commandMocks.findStaleAliases.mockReset().mockResolvedValue([]);
  commandMocks.formatStaleReason.mockReset().mockReturnValue("no longer owned");
  commandMocks.listMyAgents.mockReset().mockResolvedValue([]);
  commandMocks.readClientId.mockReset().mockReturnValue("client-test");
  commandMocks.removeLocalAgent.mockReset().mockReturnValue(true);
  commandMocks.resolveServerUrl.mockReset().mockReturnValue("https://first-tree.example");
  filesystemProbeMocks.existsSync.mockClear();
  filesystemProbeMocks.lstatSync.mockClear();
  filesystemProbeMocks.realpathSync.mockClear();
  filesystemProbeMocks.statSync.mockClear();

  setJsonMode(false);
  process.exitCode = undefined;
  stderrChunks = [];
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
    stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write);
  process.exit = vi.fn(((code?: number) => {
    throw Object.assign(new Error("process.exit"), { exitCode: code });
  }) as never);
});

afterEach(() => {
  stderrSpy.mockRestore();
  process.exit = originalExit;
  process.exitCode = originalExitCode;
});

describe("agent remove command safety", () => {
  it.each([
    ["parent traversal", ".."],
    ["absolute path", join(tmpdir(), "first-tree-remove-secret")],
    ["POSIX separator", "alpha/beta"],
    ["Windows separator", "alpha\\beta"],
  ])("rejects %s before path inspection or removal", async (_label, name) => {
    await expect(runRemove(name)).rejects.toMatchObject({ exitCode: 2 });

    expect(failureEnvelope()).toEqual({
      ok: false,
      error: { code: "INVALID_AGENT_NAME", message: INVALID_LOCAL_AGENT_NAME_MESSAGE },
    });
    expect(process.exit).toHaveBeenCalledWith(2);
    expect(commandMocks.removeLocalAgent).not.toHaveBeenCalled();
    expect(commandMocks.defaultConfigDir).not.toHaveBeenCalled();
    expect(commandMocks.defaultHome).not.toHaveBeenCalled();
    expect(filesystemProbeMocks.existsSync).not.toHaveBeenCalled();
    expect(filesystemProbeMocks.lstatSync).not.toHaveBeenCalled();
    expect(filesystemProbeMocks.realpathSync).not.toHaveBeenCalled();
    expect(filesystemProbeMocks.statSync).not.toHaveBeenCalled();
    expect(output()).not.toContain(name);
  });

  it("returns not-found without calling core when the configuration alias is genuinely missing", async () => {
    filesystemProbeMocks.lstatSync.mockImplementationOnce(() => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });

    await expect(runRemove("missing-agent")).rejects.toMatchObject({ exitCode: 1 });

    expect(output()).toContain('Agent "missing-agent" not found.');
    expect(commandMocks.removeLocalAgent).not.toHaveBeenCalled();
  });

  it("sanitizes a native configuration presence-check failure", async () => {
    const sensitivePath = join(tmpdir(), "first-tree-remove-private", "alpha");
    filesystemProbeMocks.lstatSync.mockImplementationOnce(() => {
      throw Object.assign(new Error(`lstat failed at ${sensitivePath}`), { code: "EACCES" });
    });

    await expect(runRemove("alpha")).rejects.toMatchObject({ exitCode: 1 });

    expect(failureEnvelope()).toEqual({
      ok: false,
      error: {
        code: "REMOVE_ERROR",
        message: "Unable to inspect the local agent configuration safely (EACCES).",
      },
    });
    expect(output()).not.toContain(sensitivePath);
    expect(commandMocks.removeLocalAgent).not.toHaveBeenCalled();
  });

  it("reports removed after a successful presence gate without consulting a core return value", async () => {
    commandMocks.removeLocalAgent.mockReturnValueOnce(false);

    await runRemove("alpha");

    expect(commandMocks.removeLocalAgent).toHaveBeenCalledWith("alpha");
    expect(output()).toContain('Agent "alpha" removed.');
    expect(output()).not.toContain("not found");
  });

  it("surfaces a typed diagnostic without exposing a filesystem path", async () => {
    const sensitivePath = join(tmpdir(), "first-tree-remove-private", "alpha");
    const diagnostic = "Refusing to remove local agent workspace: target failed its managed-directory safety check.";
    commandMocks.removeLocalAgent.mockImplementation(() => {
      throw new LocalAgentRemovalError("UNSAFE_LOCAL_AGENT_PATH", diagnostic);
    });

    await expect(runRemove("alpha")).rejects.toMatchObject({ exitCode: 1 });

    expect(failureEnvelope()).toEqual({
      ok: false,
      error: { code: "REMOVE_ERROR", message: diagnostic },
    });
    expect(output()).toContain("workspace");
    expect(output()).toContain("safety check");
    expect(output()).not.toContain(sensitivePath);
  });

  it("replaces an unknown native error with a fixed path-free message", async () => {
    const sensitivePath = join(tmpdir(), "first-tree-remove-private", "alpha");
    const nativeMessage = `rm failed at ${sensitivePath}`;
    commandMocks.removeLocalAgent.mockImplementation(() => {
      throw new Error(nativeMessage);
    });

    await expect(runRemove("alpha")).rejects.toMatchObject({ exitCode: 1 });

    expect(failureEnvelope()).toEqual({
      ok: false,
      error: { code: "REMOVE_ERROR", message: UNKNOWN_LOCAL_AGENT_REMOVAL_MESSAGE },
    });
    expect(output()).not.toContain(nativeMessage);
    expect(output()).not.toContain(sensitivePath);
  });

  it("removes a grandfathered leading-hyphen name after the option terminator", async () => {
    await runRemoveArgs(["--", "-legacy"]);

    expect(commandMocks.removeLocalAgent).toHaveBeenCalledWith("-legacy");
  });
});

describe("agent prune command safety", () => {
  it("replaces an unknown per-alias removal error with a fixed path-free message", async () => {
    const sensitivePath = join(tmpdir(), "first-tree-prune-private", "stale-agent");
    const nativeMessage = `rm failed at ${sensitivePath}`;
    commandMocks.findStaleAliases.mockResolvedValue([
      { name: "stale-agent", agentId: "agent-stale", reason: { kind: "unowned" } },
    ]);
    commandMocks.removeLocalAgent.mockImplementation(() => {
      throw new Error(nativeMessage);
    });

    await runPrune(["--yes"]);

    expect(commandMocks.removeLocalAgent).toHaveBeenCalledWith("stale-agent");
    expect(output()).toContain(`✗ stale-agent (${UNKNOWN_LOCAL_AGENT_REMOVAL_MESSAGE})`);
    expect(output()).not.toContain(nativeMessage);
    expect(output()).not.toContain(sensitivePath);
    expect(process.exitCode).toBe(1);
  });

  it("escapes control characters when displaying an invalid stale alias", async () => {
    const unsafeName = "bad\n\t\u001b\u0085\u2028\u202e[31m";
    commandMocks.findStaleAliases.mockResolvedValue([
      { name: unsafeName, agentId: null, reason: { kind: "unreadable", error: "invalid local alias name" } },
    ]);

    await runPrune(["--dry-run"]);

    expect(output()).toContain('"bad\\n\\t\\u001b\\u0085\\u2028\\u202e[31m"');
    expect(output()).toContain("\\n");
    expect(output()).toContain("\\t");
    expect(output()).toContain("\\u001b");
    expect(output()).toContain("\\u0085");
    expect(output()).toContain("\\u2028");
    expect(output()).toContain("\\u202e");
    expect(output()).not.toContain(unsafeName);
    expect(output()).not.toContain("\u001b");
    expect(output()).not.toContain("\u0085");
    expect(output()).not.toContain("\u2028");
    expect(output()).not.toContain("\u202e");
    expect(commandMocks.removeLocalAgent).not.toHaveBeenCalled();
  });
});
