import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify as stringifyYaml } from "yaml";

const doctorCoreMocks = vi.hoisted(() => ({
  checkAgentConfigs: vi.fn(),
  checkBackgroundService: vi.fn(),
  checkClientConfig: vi.fn(),
  checkLegacyGithubScanRunner: vi.fn(),
  checkNodeVersion: vi.fn(),
  checkServerReachable: vi.fn(),
  checkWebSocket: vi.fn(),
  ensureFreshAccessToken: vi.fn(),
  reconcileAgentConfigs: vi.fn(),
  resolveServerUrl: vi.fn(),
  runtimeProviderChecks: vi.fn(),
}));

const clientMocks = vi.hoisted(() => ({
  FirstTreeHubSDK: vi.fn(),
  ClientOrgMismatchError: class ClientOrgMismatchError extends Error {},
  probeCapabilities: vi.fn(),
}));

const configMocks = vi.hoisted(() => ({
  clientConfigSchema: {},
  initConfig: vi.fn(),
  resetConfig: vi.fn(),
  resetConfigMeta: vi.fn(),
}));

const cliFetchMock = vi.hoisted(() => vi.fn());

const outputMocks = vi.hoisted(() => ({
  fail: vi.fn((code: string, message: string, exitCode = 1) => {
    throw Object.assign(new Error(message), { code, exitCode });
  }),
}));

const printMocks = vi.hoisted(() => ({
  blank: vi.fn(),
  line: vi.fn(),
}));

vi.mock("../core/index.js", () => ({
  CLI_USER_AGENT: "first-tree-test",
  ...doctorCoreMocks,
}));
vi.mock("@first-tree/client", () => clientMocks);
vi.mock("@first-tree/shared/config", () => configMocks);
vi.mock("../core/cli-fetch.js", () => ({ cliFetch: cliFetchMock }));
vi.mock("../cli/output.js", () => outputMocks);
vi.mock("../core/output.js", () => ({ print: printMocks }));

let tempDir = "";
const originalExit = process.exit;

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: vi.fn(async () => body),
    text: vi.fn(async () => (typeof body === "string" ? body : JSON.stringify(body))),
  } as unknown as Response;
}

function setRawArgs(command: Command, rawArgs: string[]): void {
  Object.defineProperty(command, "rawArgs", { configurable: true, value: rawArgs, writable: true });
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "ft-cli-helper-extra-"));
  vi.clearAllMocks();
  doctorCoreMocks.checkAgentConfigs.mockReturnValue({ label: "Agents", ok: true, detail: "local" });
  doctorCoreMocks.checkBackgroundService.mockReturnValue({ label: "Service", ok: true, detail: "running" });
  doctorCoreMocks.checkClientConfig.mockReturnValue({ label: "Config", ok: true, detail: "ok" });
  doctorCoreMocks.checkLegacyGithubScanRunner.mockReturnValue({
    label: "Legacy github-scan",
    ok: true,
    detail: "no stranded runner",
  });
  doctorCoreMocks.checkNodeVersion.mockReturnValue({ label: "Node", ok: true, detail: "v24" });
  doctorCoreMocks.checkServerReachable.mockResolvedValue({ label: "Server", ok: true, detail: "ok" });
  doctorCoreMocks.checkWebSocket.mockResolvedValue({ label: "WebSocket", ok: true, detail: "ok" });
  doctorCoreMocks.ensureFreshAccessToken.mockResolvedValue("token");
  doctorCoreMocks.reconcileAgentConfigs.mockResolvedValue({ label: "Agents", ok: true, detail: "reconciled" });
  doctorCoreMocks.resolveServerUrl.mockReturnValue("https://hub.example");
  doctorCoreMocks.runtimeProviderChecks.mockReturnValue([{ label: "codex", ok: true, detail: "ok — bundled" }]);
  clientMocks.probeCapabilities.mockResolvedValue({});
  configMocks.initConfig.mockResolvedValue({ client: { id: "client-1" } });
  clientMocks.FirstTreeHubSDK.mockImplementation(() => ({ listMyAgents: vi.fn(async () => []) }));
  process.exit = vi.fn(((code?: number) => {
    throw Object.assign(new Error("process.exit"), { code });
  }) as never);
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  process.exit = originalExit;
  process.exitCode = undefined;
});

describe("command context and command groups", () => {
  it("resolves debug and quiet precedence from raw argv and invokes wrapped actions", async () => {
    const { createCommandContext, withCommandContext } = await import("../commands/context.js");
    const program = new Command();
    program.name("first-tree").option("--json").option("--debug", undefined, false).option("--quiet", undefined, false);
    const child = program.command("probe");
    setRawArgs(program, ["node", "first-tree", "--quiet", "-d", "probe"]);
    program.setOptionValue("json", true);

    expect(createCommandContext(child).options).toEqual({ json: true, debug: true, quiet: false });

    setRawArgs(program, ["node", "first-tree", "-dq", "probe"]);
    expect(createCommandContext(child).options).toEqual({ json: true, debug: false, quiet: true });

    setRawArgs(program, ["probe", "--debug", "--", "--quiet"]);
    expect(createCommandContext(child).options).toEqual({ json: true, debug: true, quiet: false });

    const action = vi.fn();
    withCommandContext(action).call(child);
    expect(action).toHaveBeenCalledWith(expect.objectContaining({ command: child }));
  });

  it("registers command groups with help for bare invocation and unknown-command handling", async () => {
    const { registerCommandGroup } = await import("../commands/groups.js");
    const program = new Command();
    const action = vi.fn();
    registerCommandGroup(program, "tree", "Tree commands", [
      { name: "status", alias: "st", summary: "Show", description: "Show status", action },
    ]);

    const tree = program.commands.find((entry) => entry.name() === "tree");
    if (!tree) throw new Error("missing tree command");
    const help = vi.spyOn(tree, "outputHelp").mockImplementation(() => undefined);
    tree.args = [];
    await program.parseAsync(["tree"], { from: "user" });
    expect(help).toHaveBeenCalled();

    const unknown = vi
      .spyOn(tree as Command & { unknownCommand(): void }, "unknownCommand")
      .mockImplementation(() => undefined);
    tree.args = ["typo"];
    await program.parseAsync(["tree", "typo"], { from: "user" });
    expect(unknown).toHaveBeenCalled();
  });
});

describe("doctor checks and agent resolver", () => {
  it("runs server-aware daemon checks and falls back to local agent checks", async () => {
    const { runDaemonChecks } = await import("../commands/_shared/doctor-checks.js");

    await expect(runDaemonChecks()).resolves.toEqual([
      { label: "Node", ok: true, detail: "v24" },
      { label: "Config", ok: true, detail: "ok" },
      { label: "Server", ok: true, detail: "ok" },
      { label: "Agents", ok: true, detail: "reconciled" },
      { label: "WebSocket", ok: true, detail: "ok" },
      { label: "Service", ok: true, detail: "running" },
      { label: "Legacy github-scan", ok: true, detail: "no stranded runner" },
      { label: "codex", ok: true, detail: "ok — bundled" },
    ]);
    expect(configMocks.resetConfig).toHaveBeenCalled();
    expect(configMocks.resetConfigMeta).toHaveBeenCalled();

    configMocks.initConfig.mockRejectedValueOnce(new Error("no config"));
    const fallback = await runDaemonChecks();
    expect(fallback[3]).toEqual({ label: "Agents", ok: true, detail: "local" });
  });

  it("resolves managed agents by name or uuid and maps fetch/not-found failures", async () => {
    const { resolveAgent } = await import("../commands/_shared/resolve-agent.js");
    cliFetchMock.mockResolvedValueOnce(
      jsonResponse([
        { uuid: "agent-1", name: "nova", displayName: "Nova" },
        { uuid: "agent-2", name: null, displayName: null },
      ]),
    );
    await expect(resolveAgent("https://hub.example", "token", "nova")).resolves.toMatchObject({ uuid: "agent-1" });

    cliFetchMock.mockResolvedValueOnce(jsonResponse([{ uuid: "agent-2", name: null, displayName: null }]));
    await expect(resolveAgent("https://hub.example", "token", "agent-2")).resolves.toMatchObject({ uuid: "agent-2" });

    cliFetchMock.mockResolvedValueOnce(jsonResponse("bad", false, 503));
    await expect(resolveAgent("https://hub.example", "token", "missing")).rejects.toMatchObject({
      code: "FETCH_ERROR",
      exitCode: 1,
    });

    cliFetchMock.mockResolvedValueOnce(jsonResponse([]));
    await expect(resolveAgent("https://hub.example", "token", "missing")).rejects.toMatchObject({
      code: "NOT_FOUND",
      exitCode: 1,
    });
  });
});

describe("client org mismatch handler", () => {
  it("fails closed with reset-first recovery and leaves client.yaml unchanged", async () => {
    const yamlPath = join(tempDir, "client.yaml");
    const before = stringifyYaml({ client: { id: "client_11111111" } });
    writeFileSync(yamlPath, before);
    const { handleClientOrgMismatch } = await import("../core/client-reidentify.js");

    await expect(
      handleClientOrgMismatch(new Error("wrong org") as never, {
        managed: false,
        configDir: tempDir,
        rerunCommand: "first-tree-dev login token",
      }),
    ).rejects.toMatchObject({ code: 1 });

    expect(readFileSync(yamlPath, "utf8")).toBe(before);
    const output = printMocks.line.mock.calls.map((call) => String(call[0])).join("");
    expect(output).toContain("wrong org");
    expect(output).toContain("first-tree-dev login <code>");
    expect(output).toContain("first-tree-dev computer reset");
    expect(output).toContain("valid server-side owner pair");
    expect(output).not.toContain("Rotate");
    expect(output).not.toContain("Rotated");
    expect(output).not.toContain("client.yaml.bak");
  });

  it("uses the same reset-first recovery in managed mode", async () => {
    const { handleClientOrgMismatch } = await import("../core/client-reidentify.js");

    await expect(
      handleClientOrgMismatch(new Error("wrong org") as never, {
        managed: true,
        configDir: tempDir,
        rerunCommand: "ignored",
      }),
    ).rejects.toMatchObject({ code: 1 });

    const output = printMocks.line.mock.calls.map((call) => String(call[0])).join("");
    expect(output).toContain("first-tree-dev login <code>");
    expect(output).toContain("first-tree-dev computer reset");
  });

  it("routes managed recovery text through an injected output sink", async () => {
    const { handleClientOrgMismatch } = await import("../core/client-reidentify.js");
    const output = {
      blank: vi.fn(),
      line: vi.fn(),
    };

    await expect(
      handleClientOrgMismatch(new Error("wrong org") as never, {
        managed: true,
        configDir: tempDir,
        rerunCommand: "ignored",
        output,
      }),
    ).rejects.toMatchObject({ code: 1 });

    expect(output.blank).toHaveBeenCalled();
    expect(output.line).toHaveBeenCalledWith(expect.stringContaining("wrong org"));
    expect(printMocks.blank).not.toHaveBeenCalled();
    expect(printMocks.line).not.toHaveBeenCalled();
  });

  it("routes managed logger output through an error-level status summary", async () => {
    const { handleClientOrgMismatch } = await import("../core/client-reidentify.js");
    const output = {
      blank: vi.fn(),
      line: vi.fn(),
      status: vi.fn(),
    };

    await expect(
      handleClientOrgMismatch(new Error("wrong org") as never, {
        managed: true,
        configDir: tempDir,
        rerunCommand: "ignored",
        output,
      }),
    ).rejects.toMatchObject({ code: 1 });

    expect(output.status).toHaveBeenCalledWith("✗", expect.stringContaining("wrong org"));
    expect(output.status).toHaveBeenCalledWith("✗", expect.stringContaining("first-tree-dev login <code>"));
    expect(output.status).toHaveBeenCalledWith("✗", expect.stringContaining("first-tree-dev computer reset"));
    expect(output.blank).not.toHaveBeenCalled();
    expect(output.line).not.toHaveBeenCalled();
    expect(printMocks.blank).not.toHaveBeenCalled();
    expect(printMocks.line).not.toHaveBeenCalled();
  });
});
