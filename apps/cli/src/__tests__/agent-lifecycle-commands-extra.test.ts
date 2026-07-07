import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const clientSdkMocks = vi.hoisted(() => ({
  FirstTreeHubSDK: vi.fn(),
}));

const configMocks = vi.hoisted(() => ({
  agentConfigSchema: {},
  clientConfigSchema: {},
  defaultConfigDir: vi.fn(),
  defaultDataDir: vi.fn(),
  defaultHome: vi.fn(),
  loadAgents: vi.fn(),
  resolveConfigReadonly: vi.fn(),
  setConfigValue: vi.fn(),
}));

const bootstrapMocks = vi.hoisted(() => ({
  ensureFreshAccessToken: vi.fn(),
  resolveServerUrl: vi.fn(),
  saveAgentConfig: vi.fn(),
}));

const cliFetchMock = vi.hoisted(() => vi.fn());

const coreMocks = vi.hoisted(() => ({
  COMMAND_VERSION: "0.5.0",
  CLI_USER_AGENT: "first-tree-test",
  cliFetch: cliFetchMock,
  detectInstallMode: vi.fn(),
  ensureFreshAccessToken: vi.fn(),
  fetchLatestVersion: vi.fn(),
  fetchPortableLatestVersion: vi.fn(),
  fetchServerCommandVersion: vi.fn(),
  findStaleAliases: vi.fn(),
  formatStaleReason: vi.fn((reason: string) => reason),
  getClientServiceStatus: vi.fn(),
  installClientService: vi.fn(),
  installGlobalLatest: vi.fn(),
  installGlobalSpec: vi.fn(),
  installPortableSpec: vi.fn(),
  isServiceSupported: vi.fn(),
  listLiveClientRuntimeMarkers: vi.fn(),
  loadCredentials: vi.fn(),
  PACKAGE_NAME: "first-tree",
  promptAddAgent: vi.fn(),
  readActiveClientIdFromIndex: vi.fn(),
  readActiveRootClientId: vi.fn(),
  recordActiveClientOwner: vi.fn(),
  removeLocalAgent: vi.fn(),
  resolveServerUrl: vi.fn(),
  restartClientService: vi.fn(),
  stopClientService: vi.fn(),
  stopClientRuntimeProcess: vi.fn(),
}));

const outputMocks = vi.hoisted(() => ({
  fail: vi.fn((code: string, message: string, exitCode = 1) => {
    throw Object.assign(new Error(message), { code, exitCode });
  }),
  success: vi.fn(),
}));

const printLineMock = vi.hoisted(() => vi.fn());

vi.mock("@first-tree/client", () => clientSdkMocks);
vi.mock("@first-tree/shared/config", () => configMocks);
vi.mock("../core/bootstrap.js", () => bootstrapMocks);
vi.mock("../core/cli-fetch.js", () => ({ cliFetch: cliFetchMock }));
vi.mock("../core/index.js", () => coreMocks);
vi.mock("../cli/output.js", () => outputMocks);
vi.mock("../core/output.js", () => ({
  print: { line: printLineMock, result: outputMocks.success, fail: outputMocks.fail },
}));

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

function jwt(payload: Record<string, unknown>): string {
  return `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`;
}

async function runAgent(args: string[]): Promise<void> {
  const { registerAgentCommands } = await import("../commands/agent/index.js");
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeErr: () => undefined, writeOut: () => undefined });
  registerAgentCommands(program);
  await program.parseAsync(["node", "test", "agent", ...args]);
}

async function runTopLevel(register: (program: Command) => void, args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeErr: () => undefined, writeOut: () => undefined });
  register(program);
  await program.parseAsync(["node", "test", ...args]);
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "ft-cli-agent-commands-"));
  vi.clearAllMocks();
  configMocks.defaultHome.mockReturnValue(tempDir);
  configMocks.defaultConfigDir.mockReturnValue(tempDir);
  configMocks.defaultDataDir.mockReturnValue(join(tempDir, "data"));
  configMocks.resolveConfigReadonly.mockReturnValue({ client: { id: "client-1" } });
  bootstrapMocks.ensureFreshAccessToken.mockResolvedValue("user-token");
  bootstrapMocks.resolveServerUrl.mockReturnValue("https://hub.example");
  bootstrapMocks.saveAgentConfig.mockReturnValue(join(tempDir, "agents", "nova"));
  coreMocks.ensureFreshAccessToken.mockResolvedValue("user-token");
  coreMocks.resolveServerUrl.mockReturnValue("https://hub.example");
  coreMocks.fetchLatestVersion.mockReturnValue({ ok: true, version: "99.0.0" });
  coreMocks.fetchPortableLatestVersion.mockResolvedValue({ ok: true, version: "99.0.0" });
  coreMocks.fetchServerCommandVersion.mockResolvedValue({ ok: true, version: "99.0.0" });
  coreMocks.installGlobalLatest.mockResolvedValue({ ok: true, mode: "global", installedVersion: "99.0.0" });
  coreMocks.installGlobalSpec.mockResolvedValue({ ok: true, mode: "global", installedVersion: "99.0.0" });
  coreMocks.installPortableSpec.mockResolvedValue({ ok: true, mode: "portable", installedVersion: "99.0.0" });
  coreMocks.loadCredentials.mockReturnValue(null);
  coreMocks.listLiveClientRuntimeMarkers.mockReturnValue([]);
  coreMocks.readActiveClientIdFromIndex.mockReturnValue(null);
  coreMocks.readActiveRootClientId.mockReturnValue(null);
  coreMocks.stopClientRuntimeProcess.mockResolvedValue({ ok: true });
  cliFetchMock.mockReset();
  coreMocks.promptAddAgent.mockResolvedValue({ name: "nova", agentId: "agent-1" });
  coreMocks.findStaleAliases.mockResolvedValue([
    { name: "old", agentId: "agent-old", reason: "unpinned" },
    { name: "broken", agentId: null, reason: "unreadable" },
  ]);
  clientSdkMocks.FirstTreeHubSDK.mockImplementation(() => ({ listMyAgents: vi.fn(async () => []) }));
});

afterEach(() => {
  rmSync(tempDir, { force: true, recursive: true });
  process.exit = originalExit;
});

describe("agent lifecycle CLI commands", () => {
  it("adds an existing agent, handles missing prompt args, and reports prompt cancellation", async () => {
    await runAgent(["add", "--agent-id", "agent-1"]);

    expect(coreMocks.promptAddAgent).toHaveBeenCalledWith({ agentId: "agent-1" });
    expect(configMocks.setConfigValue).toHaveBeenCalledWith(
      join(tempDir, "agents", "nova", "agent.yaml"),
      "agentId",
      "agent-1",
    );
    expect(printLineMock.mock.calls.map((call) => String(call[0])).join("")).toContain('Agent "nova" added');

    process.exit = vi.fn(((code?: number) => {
      throw Object.assign(new Error("process.exit"), { code });
    }) as never);
    coreMocks.promptAddAgent.mockResolvedValueOnce({ name: "", agentId: "" });
    await expect(runAgent(["add"])).rejects.toMatchObject({ code: 1 });

    coreMocks.promptAddAgent.mockRejectedValueOnce(Object.assign(new Error("cancelled"), { name: "ExitPromptError" }));
    await runAgent(["add"]);
    expect(printLineMock.mock.calls.map((call) => String(call[0])).join("")).toContain("Cancelled.");
  });

  it("creates agents for single-org and explicit-org users and validates org selection", async () => {
    cliFetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          memberships: [{ organizationId: "org-1", organizationName: "Acme", role: "admin" }],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ uuid: "agent-created", name: "nova" }));

    await runAgent([
      "create",
      "nova",
      "--type",
      "agent",
      "--client-id",
      "client-1",
      "--runtime",
      "codex",
      "--display-name",
      "Nova",
    ]);

    expect(cliFetchMock).toHaveBeenNthCalledWith(2, "https://hub.example/api/v1/orgs/org-1/agents", {
      method: "POST",
      headers: { Authorization: "Bearer user-token", "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "nova",
        type: "agent",
        clientId: "client-1",
        runtimeProvider: "codex",
        displayName: "Nova",
      }),
      signal: expect.any(AbortSignal),
    });
    expect(bootstrapMocks.saveAgentConfig).toHaveBeenCalledWith("nova", "agent-created", "codex");

    cliFetchMock.mockResolvedValueOnce(
      jsonResponse({
        memberships: [
          { organizationId: "org-1", organizationName: "Acme", role: "admin" },
          { organizationId: "org-2", organizationName: "Beta", role: "member" },
        ],
      }),
    );
    await expect(runAgent(["create", "bot", "--type", "agent", "--client-id", "client-1"])).rejects.toMatchObject({
      code: "CREATE_ERROR",
      exitCode: 1,
    });

    cliFetchMock.mockResolvedValueOnce(
      jsonResponse({ memberships: [{ organizationId: "org-1", organizationName: "Acme", role: "admin" }] }),
    );
    await expect(
      runAgent(["create", "bot", "--type", "agent", "--client-id", "client-1", "--org", "missing"]),
    ).rejects.toMatchObject({ code: "CREATE_ERROR", exitCode: 1 });
  });

  it("lists local and remote agents, including empty and error paths", async () => {
    configMocks.loadAgents.mockReturnValueOnce(
      new Map([
        ["nova", { runtime: "claude-code", agentId: "agent-1" }],
        ["codex", { runtime: "codex", agentId: "agent-2" }],
      ]),
    );
    await runAgent(["list"]);
    const localOutput = printLineMock.mock.calls.map((call) => String(call[0])).join("");
    expect(localOutput).toContain("nova");
    expect(localOutput).toContain("uuid: agent-1");

    cliFetchMock.mockResolvedValueOnce(
      jsonResponse([
        {
          uuid: "agent-1",
          name: "nova",
          displayName: "Nova",
          type: "agent",
          organizationId: "org-1",
          runtimeProvider: "claude-code",
          clientId: "client-1",
        },
        {
          uuid: "agent-2",
          name: null,
          displayName: "No Handle",
          type: "human",
          organizationId: "org-2",
          runtimeProvider: "codex",
          clientId: null,
        },
      ]),
    );
    await runAgent(["list", "--remote", "--org", "org-2"]);
    const remoteOutput = printLineMock.mock.calls.map((call) => String(call[0])).join("");
    expect(remoteOutput).toContain("agent-2");
    expect(remoteOutput).toContain("ORG");

    cliFetchMock.mockResolvedValueOnce(jsonResponse("nope", false, 503));
    await expect(runAgent(["list", "--remote"])).rejects.toMatchObject({ code: "LIST_ERROR", exitCode: 1 });
  });

  it("prunes stale aliases with dry-run, confirmation skip, removal failures, and missing client id", async () => {
    await runAgent(["prune", "--dry-run"]);
    expect(coreMocks.removeLocalAgent).not.toHaveBeenCalled();
    expect(printLineMock.mock.calls.map((call) => String(call[0])).join("")).toContain("Dry run");

    await runAgent(["prune", "--yes"]);
    expect(coreMocks.removeLocalAgent).toHaveBeenCalledWith("old");
    expect(coreMocks.removeLocalAgent).toHaveBeenCalledWith("broken");

    coreMocks.removeLocalAgent.mockImplementationOnce(() => {
      throw new Error("locked");
    });
    await runAgent(["prune", "--yes"]);
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;

    coreMocks.findStaleAliases.mockResolvedValueOnce([]);
    await runAgent(["prune", "--yes"]);
    expect(printLineMock.mock.calls.map((call) => String(call[0])).join("")).toContain("No stale agent aliases");

    configMocks.resolveConfigReadonly.mockReturnValueOnce({ client: {} });
    await expect(runAgent(["prune", "--yes"])).rejects.toMatchObject({ code: "PRUNE_ERROR", exitCode: 1 });
  });
});

describe("logout and upgrade commands", () => {
  it("logout remembers the active client owner before removing credentials", async () => {
    const credentials = join(tempDir, "credentials.json");
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(credentials, "{}");
    coreMocks.loadCredentials.mockReturnValue({
      accessToken: jwt({ sub: "user-old" }),
      refreshToken: "refresh",
      serverUrl: "https://first-tree.example",
    });
    coreMocks.readActiveRootClientId.mockReturnValue("client_aabbccdd");
    coreMocks.isServiceSupported.mockReturnValue(false);

    const { registerLogoutCommand } = await import("../commands/logout.js");
    await runTopLevel(registerLogoutCommand, ["logout"]);

    expect(coreMocks.recordActiveClientOwner).toHaveBeenCalledWith({
      clientId: "client_aabbccdd",
      userId: "user-old",
      serverUrl: "https://first-tree.example",
    });
    expect(() => readFileSync(credentials, "utf8")).toThrow();
  });

  it("logout stops an active service and removes credentials, client config, and agent runtime state when purging", async () => {
    const credentials = join(tempDir, "credentials.json");
    const clientYaml = join(tempDir, "client.yaml");
    const agentsDir = join(tempDir, "agents");
    const sessionsDir = join(tempDir, "data", "sessions");
    const workspacesDir = join(tempDir, "data", "workspaces");
    const parkedClientsDir = join(tempDir, "parked-clients");
    const switchLock = join(tempDir, "state", "client-switch.lock");
    const switchJournal = join(tempDir, "state", "client-switch-journal.json");
    mkdirSync(tempDir, { recursive: true });
    mkdirSync(agentsDir, { recursive: true });
    mkdirSync(sessionsDir, { recursive: true });
    mkdirSync(workspacesDir, { recursive: true });
    mkdirSync(join(parkedClientsDir, "client_old", "data", "workspaces"), { recursive: true });
    mkdirSync(join(tempDir, "state"), { recursive: true });
    writeFileSync(credentials, "{}");
    writeFileSync(clientYaml, "client:\n  id: client-1\n");
    writeFileSync(join(agentsDir, "agent.yaml"), "agentId: agent-1\n");
    writeFileSync(join(sessionsDir, "session.json"), "{}");
    writeFileSync(join(workspacesDir, "workspace.json"), "{}");
    writeFileSync(join(parkedClientsDir, "index.json"), "{}");
    writeFileSync(join(parkedClientsDir, "client_old", "data", "workspaces", "marker.txt"), "old");
    writeFileSync(switchLock, "locked");
    writeFileSync(switchJournal, "{}");
    coreMocks.isServiceSupported.mockReturnValue(true);
    coreMocks.getClientServiceStatus.mockReturnValue({ state: "active", platform: "launchd" });
    coreMocks.stopClientService.mockReturnValue({ ok: true });
    coreMocks.loadCredentials.mockReturnValue({
      accessToken: jwt({ sub: "user-old" }),
      refreshToken: "refresh",
      serverUrl: "https://first-tree.example",
    });
    coreMocks.readActiveRootClientId.mockReturnValue("client-1");
    cliFetchMock.mockResolvedValue(jsonResponse({}, true, 204));

    const { registerLogoutCommand } = await import("../commands/logout.js");
    await runTopLevel(registerLogoutCommand, ["logout", "--purge"]);

    expect(coreMocks.stopClientService).toHaveBeenCalled();
    expect(cliFetchMock).toHaveBeenCalledWith(
      "https://first-tree.example/api/v1/clients/client-1",
      expect.objectContaining({
        method: "DELETE",
        headers: { Authorization: "Bearer user-token" },
      }),
    );
    expect(() => readFileSync(credentials, "utf8")).toThrow();
    expect(() => readFileSync(clientYaml, "utf8")).toThrow();
    expect(() => readFileSync(join(agentsDir, "agent.yaml"), "utf8")).toThrow();
    expect(() => readFileSync(join(sessionsDir, "session.json"), "utf8")).toThrow();
    expect(() => readFileSync(join(workspacesDir, "workspace.json"), "utf8")).toThrow();
    expect(existsSync(parkedClientsDir)).toBe(false);
    expect(existsSync(switchLock)).toBe(false);
    expect(existsSync(switchJournal)).toBe(false);
    expect(printLineMock.mock.calls.map((call) => String(call[0])).join("")).toContain("Logged out");
  });

  it("uses the active switch-index client id for logout purge when client.yaml has no id", async () => {
    const credentials = join(tempDir, "credentials.json");
    const clientYaml = join(tempDir, "client.yaml");
    const agentsDir = join(tempDir, "agents");
    mkdirSync(tempDir, { recursive: true });
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(credentials, "{}");
    writeFileSync(clientYaml, "server:\n  url: https://first-tree.example\n");
    writeFileSync(join(agentsDir, "agent.yaml"), "agentId: agent-1\n");
    coreMocks.isServiceSupported.mockReturnValue(false);
    coreMocks.loadCredentials.mockReturnValue({
      accessToken: jwt({ sub: "user-old" }),
      refreshToken: "refresh",
      serverUrl: "https://first-tree.example",
    });
    coreMocks.readActiveRootClientId.mockReturnValue(null);
    coreMocks.readActiveClientIdFromIndex.mockReturnValue("client_aabbccdd");
    cliFetchMock.mockResolvedValue(jsonResponse({}, true, 204));

    const { registerLogoutCommand } = await import("../commands/logout.js");
    await runTopLevel(registerLogoutCommand, ["logout", "--purge"]);

    expect(coreMocks.listLiveClientRuntimeMarkers).toHaveBeenCalledWith(tempDir, "client_aabbccdd");
    expect(cliFetchMock).toHaveBeenCalledWith(
      "https://first-tree.example/api/v1/clients/client_aabbccdd",
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(existsSync(credentials)).toBe(false);
    expect(existsSync(clientYaml)).toBe(false);
    expect(existsSync(agentsDir)).toBe(false);
  });

  it("logout purge stops foreground daemon markers before server retire and local deletion", async () => {
    const credentials = join(tempDir, "credentials.json");
    const clientYaml = join(tempDir, "client.yaml");
    const agentsDir = join(tempDir, "agents");
    mkdirSync(tempDir, { recursive: true });
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(credentials, "{}");
    writeFileSync(clientYaml, "client:\n  id: client-1\n");
    writeFileSync(join(agentsDir, "agent.yaml"), "agentId: agent-1\n");
    coreMocks.isServiceSupported.mockReturnValue(false);
    coreMocks.loadCredentials.mockReturnValue({
      accessToken: jwt({ sub: "user-old" }),
      refreshToken: "refresh",
      serverUrl: "https://first-tree.example",
    });
    coreMocks.readActiveRootClientId.mockReturnValue("client-1");
    coreMocks.listLiveClientRuntimeMarkers.mockReturnValue([
      {
        pid: 4321,
        clientId: "client-1",
        mode: "foreground",
        command: "first-tree-dev",
      },
    ]);
    coreMocks.stopClientRuntimeProcess.mockResolvedValue({ ok: true });
    cliFetchMock.mockResolvedValue(jsonResponse({}, true, 204));

    const { registerLogoutCommand } = await import("../commands/logout.js");
    await runTopLevel(registerLogoutCommand, ["logout", "--purge"]);

    expect(coreMocks.listLiveClientRuntimeMarkers).toHaveBeenCalledWith(tempDir, "client-1");
    expect(coreMocks.stopClientRuntimeProcess).toHaveBeenCalledWith(4321, { timeoutMs: 5000 });
    expect(coreMocks.stopClientRuntimeProcess.mock.invocationCallOrder[0]).toBeLessThan(
      cliFetchMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(cliFetchMock).toHaveBeenCalledWith(
      "https://first-tree.example/api/v1/clients/client-1",
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(() => readFileSync(credentials, "utf8")).toThrow();
    expect(() => readFileSync(clientYaml, "utf8")).toThrow();
    expect(() => readFileSync(join(agentsDir, "agent.yaml"), "utf8")).toThrow();
    const output = printLineMock.mock.calls.map((call) => String(call[0])).join("");
    expect(output).toContain("Stopped foreground daemon pid 4321");
  });

  it("computer reset uses the same guarded local-state removal without server retire", async () => {
    const credentials = join(tempDir, "credentials.json");
    const clientYaml = join(tempDir, "client.yaml");
    const agentsDir = join(tempDir, "agents");
    const sessionsDir = join(tempDir, "data", "sessions");
    const workspacesDir = join(tempDir, "data", "workspaces");
    const parkedClientsDir = join(tempDir, "parked-clients");
    const switchLock = join(tempDir, "state", "client-switch.lock");
    const switchJournal = join(tempDir, "state", "client-switch-journal.json");
    mkdirSync(tempDir, { recursive: true });
    mkdirSync(agentsDir, { recursive: true });
    mkdirSync(sessionsDir, { recursive: true });
    mkdirSync(workspacesDir, { recursive: true });
    mkdirSync(join(parkedClientsDir, "client_old", "data", "sessions"), { recursive: true });
    mkdirSync(join(tempDir, "state"), { recursive: true });
    writeFileSync(credentials, "{}");
    writeFileSync(clientYaml, "client:\n  id: client-1\n");
    writeFileSync(join(agentsDir, "agent.yaml"), "agentId: agent-1\n");
    writeFileSync(join(sessionsDir, "session.json"), "{}");
    writeFileSync(join(workspacesDir, "workspace.json"), "{}");
    writeFileSync(join(parkedClientsDir, "index.json"), "{}");
    writeFileSync(join(parkedClientsDir, "client_old", "data", "sessions", "marker.json"), "{}");
    writeFileSync(switchLock, "locked");
    writeFileSync(switchJournal, "{}");
    coreMocks.isServiceSupported.mockReturnValue(true);
    coreMocks.getClientServiceStatus.mockReturnValue({ state: "active", platform: "launchd" });
    coreMocks.stopClientService.mockReturnValue({ ok: true });

    const { registerComputerCommands } = await import("../commands/computer/index.js");
    await runTopLevel(registerComputerCommands, ["computer", "reset"]);

    expect(coreMocks.stopClientService).toHaveBeenCalled();
    expect(cliFetchMock).not.toHaveBeenCalled();
    expect(() => readFileSync(credentials, "utf8")).toThrow();
    expect(() => readFileSync(clientYaml, "utf8")).toThrow();
    expect(() => readFileSync(join(agentsDir, "agent.yaml"), "utf8")).toThrow();
    expect(() => readFileSync(join(sessionsDir, "session.json"), "utf8")).toThrow();
    expect(() => readFileSync(join(workspacesDir, "workspace.json"), "utf8")).toThrow();
    expect(existsSync(parkedClientsDir)).toBe(false);
    expect(existsSync(switchLock)).toBe(false);
    expect(existsSync(switchJournal)).toBe(false);
  });

  it("refuses purge before deleting local state when an active service cannot be stopped", async () => {
    const credentials = join(tempDir, "credentials.json");
    const clientYaml = join(tempDir, "client.yaml");
    const agentsDir = join(tempDir, "agents");
    const sessionsDir = join(tempDir, "data", "sessions");
    const workspacesDir = join(tempDir, "data", "workspaces");
    mkdirSync(tempDir, { recursive: true });
    mkdirSync(agentsDir, { recursive: true });
    mkdirSync(sessionsDir, { recursive: true });
    mkdirSync(workspacesDir, { recursive: true });
    writeFileSync(credentials, "{}");
    writeFileSync(clientYaml, "client:\n  id: client-1\n");
    writeFileSync(join(agentsDir, "agent.yaml"), "agentId: agent-1\n");
    writeFileSync(join(sessionsDir, "session.json"), "{}");
    writeFileSync(join(workspacesDir, "workspace.json"), "{}");
    coreMocks.isServiceSupported.mockReturnValue(true);
    coreMocks.getClientServiceStatus.mockReturnValue({ state: "active", platform: "launchd" });
    coreMocks.stopClientService.mockReturnValue({ ok: false, reason: "permission denied" });

    const { registerLogoutCommand } = await import("../commands/logout.js");
    await expect(runTopLevel(registerLogoutCommand, ["logout", "--purge"])).rejects.toMatchObject({
      code: "PURGE_DAEMON_STOP_FAILED",
      exitCode: 1,
    });

    expect(readFileSync(credentials, "utf8")).toBe("{}");
    expect(readFileSync(clientYaml, "utf8")).toContain("client-1");
    expect(readFileSync(join(agentsDir, "agent.yaml"), "utf8")).toContain("agent-1");
    expect(readFileSync(join(sessionsDir, "session.json"), "utf8")).toBe("{}");
    expect(readFileSync(join(workspacesDir, "workspace.json"), "utf8")).toBe("{}");
    const output = printLineMock.mock.calls.map((call) => String(call[0])).join("");
    expect(output).toContain("Refusing to purge");
    expect(output).toContain("first-tree-dev daemon stop");
  });

  it("refuses purge before server retire or local deletion when service state is unknown", async () => {
    const credentials = join(tempDir, "credentials.json");
    const clientYaml = join(tempDir, "client.yaml");
    const agentsDir = join(tempDir, "agents");
    mkdirSync(tempDir, { recursive: true });
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(credentials, "{}");
    writeFileSync(clientYaml, "client:\n  id: client-1\n");
    writeFileSync(join(agentsDir, "agent.yaml"), "agentId: agent-1\n");
    coreMocks.isServiceSupported.mockReturnValue(true);
    coreMocks.getClientServiceStatus.mockReturnValue({
      state: "unknown",
      platform: "launchd",
      detail: "launchctl failed",
    });
    coreMocks.readActiveRootClientId.mockReturnValue("client-1");

    const { registerLogoutCommand } = await import("../commands/logout.js");
    await expect(runTopLevel(registerLogoutCommand, ["logout", "--purge"])).rejects.toMatchObject({
      code: "PURGE_DAEMON_STATE_UNKNOWN",
      exitCode: 1,
    });

    expect(coreMocks.stopClientService).not.toHaveBeenCalled();
    expect(cliFetchMock).not.toHaveBeenCalled();
    expect(readFileSync(credentials, "utf8")).toBe("{}");
    expect(readFileSync(clientYaml, "utf8")).toContain("client-1");
    expect(readFileSync(join(agentsDir, "agent.yaml"), "utf8")).toContain("agent-1");
    const output = printLineMock.mock.calls.map((call) => String(call[0])).join("");
    expect(output).toContain("service state");
    expect(output).toContain("Refusing to purge");
  });

  it("refuses logout purge before server retire or local deletion when a foreground daemon cannot be stopped", async () => {
    const credentials = join(tempDir, "credentials.json");
    const clientYaml = join(tempDir, "client.yaml");
    const agentsDir = join(tempDir, "agents");
    const sessionsDir = join(tempDir, "data", "sessions");
    const workspacesDir = join(tempDir, "data", "workspaces");
    mkdirSync(tempDir, { recursive: true });
    mkdirSync(agentsDir, { recursive: true });
    mkdirSync(sessionsDir, { recursive: true });
    mkdirSync(workspacesDir, { recursive: true });
    writeFileSync(credentials, "{}");
    writeFileSync(clientYaml, "client:\n  id: client-1\n");
    writeFileSync(join(agentsDir, "agent.yaml"), "agentId: agent-1\n");
    writeFileSync(join(sessionsDir, "session.json"), "{}");
    writeFileSync(join(workspacesDir, "workspace.json"), "{}");
    coreMocks.isServiceSupported.mockReturnValue(false);
    coreMocks.readActiveRootClientId.mockReturnValue("client-1");
    coreMocks.listLiveClientRuntimeMarkers.mockReturnValue([
      {
        pid: 4321,
        clientId: "client-1",
        mode: "foreground",
        command: "first-tree-dev daemon start --foreground",
      },
    ]);
    coreMocks.stopClientRuntimeProcess.mockResolvedValue({ ok: false, reason: "still running" });

    const { registerLogoutCommand } = await import("../commands/logout.js");
    await expect(runTopLevel(registerLogoutCommand, ["logout", "--purge"])).rejects.toMatchObject({
      code: "PURGE_FOREGROUND_DAEMON_STOP_FAILED",
      exitCode: 1,
    });

    expect(cliFetchMock).not.toHaveBeenCalled();
    expect(readFileSync(credentials, "utf8")).toBe("{}");
    expect(readFileSync(clientYaml, "utf8")).toContain("client-1");
    expect(readFileSync(join(agentsDir, "agent.yaml"), "utf8")).toContain("agent-1");
    expect(readFileSync(join(sessionsDir, "session.json"), "utf8")).toBe("{}");
    expect(readFileSync(join(workspacesDir, "workspace.json"), "utf8")).toBe("{}");
    const output = printLineMock.mock.calls.map((call) => String(call[0])).join("");
    expect(output).toContain("Could not stop foreground daemon pid 4321");
    expect(output).toContain("Refusing to purge");
  });

  it("refuses logout purge instead of killing an untrusted reused foreground marker pid", async () => {
    const credentials = join(tempDir, "credentials.json");
    const clientYaml = join(tempDir, "client.yaml");
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(credentials, "{}");
    writeFileSync(clientYaml, "client:\n  id: client-1\n");
    coreMocks.isServiceSupported.mockReturnValue(false);
    coreMocks.readActiveRootClientId.mockReturnValue("client-1");
    coreMocks.listLiveClientRuntimeMarkers.mockReturnValue([
      {
        pid: 4321,
        clientId: "client-1",
        mode: "foreground",
        command: "sleep 1000",
      },
    ]);

    const { registerLogoutCommand } = await import("../commands/logout.js");
    await expect(runTopLevel(registerLogoutCommand, ["logout", "--purge"])).rejects.toMatchObject({
      code: "PURGE_FOREGROUND_DAEMON_STOP_FAILED",
      exitCode: 1,
    });

    expect(coreMocks.stopClientRuntimeProcess).not.toHaveBeenCalled();
    expect(cliFetchMock).not.toHaveBeenCalled();
    expect(readFileSync(credentials, "utf8")).toBe("{}");
    expect(readFileSync(clientYaml, "utf8")).toContain("client-1");
    const output = printLineMock.mock.calls.map((call) => String(call[0])).join("");
    expect(output).toContain("Could not safely stop foreground daemon marker");
    expect(output).toContain("sleep 1000");
  });

  it("refuses logout purge before deleting local state when server retire fails", async () => {
    const credentials = join(tempDir, "credentials.json");
    const clientYaml = join(tempDir, "client.yaml");
    const agentsDir = join(tempDir, "agents");
    mkdirSync(tempDir, { recursive: true });
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(credentials, "{}");
    writeFileSync(clientYaml, "client:\n  id: client-1\n");
    writeFileSync(join(agentsDir, "agent.yaml"), "agentId: agent-1\n");
    coreMocks.isServiceSupported.mockReturnValue(false);
    coreMocks.loadCredentials.mockReturnValue({
      accessToken: jwt({ sub: "user-old" }),
      refreshToken: "refresh",
      serverUrl: "https://first-tree.example",
    });
    coreMocks.readActiveRootClientId.mockReturnValue("client-1");
    cliFetchMock.mockResolvedValue(jsonResponse({ error: "delete pinned agents first" }, false, 409));

    const { registerLogoutCommand } = await import("../commands/logout.js");
    await expect(runTopLevel(registerLogoutCommand, ["logout", "--purge"])).rejects.toMatchObject({
      code: "PURGE_CLIENT_RETIRE_FAILED",
      exitCode: 1,
    });

    expect(readFileSync(credentials, "utf8")).toBe("{}");
    expect(readFileSync(clientYaml, "utf8")).toContain("client-1");
    expect(readFileSync(join(agentsDir, "agent.yaml"), "utf8")).toContain("agent-1");
    const output = printLineMock.mock.calls.map((call) => String(call[0])).join("");
    expect(output).toContain("server-side client retire failed");
    expect(output).toContain("delete pinned agents first");
  });

  it("upgrade covers source, npx, check-only, install failure, no service, inactive service, and restart failure paths", async () => {
    process.exit = vi.fn(((code?: number) => {
      throw Object.assign(new Error("process.exit"), { code });
    }) as never);
    const { registerUpgradeCommand } = await import("../commands/upgrade.js");

    coreMocks.detectInstallMode.mockReturnValueOnce("source");
    await runTopLevel(registerUpgradeCommand, ["upgrade"]);
    expect(printLineMock.mock.calls.map((call) => String(call[0])).join("")).toContain("git pull");

    coreMocks.detectInstallMode.mockReturnValueOnce("npx");
    await runTopLevel(registerUpgradeCommand, ["upgrade"]);
    expect(printLineMock.mock.calls.map((call) => String(call[0])).join("")).toContain("npm i -g first-tree");

    coreMocks.detectInstallMode.mockReturnValue("global");
    coreMocks.fetchServerCommandVersion.mockResolvedValueOnce({ ok: false, reason: "server down" });
    await expect(runTopLevel(registerUpgradeCommand, ["upgrade"])).rejects.toMatchObject({ code: 1 });
    expect(printLineMock.mock.calls.map((call) => String(call[0])).join("")).toContain(
      "first-tree-dev upgrade --latest",
    );

    await runTopLevel(registerUpgradeCommand, ["upgrade", "--check"]);
    expect(printLineMock.mock.calls.map((call) => String(call[0])).join("")).toContain("Upgrade available");

    coreMocks.fetchLatestVersion.mockReturnValueOnce({ ok: true, version: "100.0.0" });
    await runTopLevel(registerUpgradeCommand, ["upgrade", "--check", "--latest"]);
    expect(printLineMock.mock.calls.map((call) => String(call[0])).join("")).toContain("100.0.0");

    await runTopLevel(registerUpgradeCommand, ["upgrade", "--latest", "--no-restart"]);
    expect(coreMocks.installGlobalLatest).toHaveBeenCalled();

    coreMocks.detectInstallMode.mockReturnValue("portable");
    coreMocks.fetchPortableLatestVersion.mockResolvedValueOnce({ ok: true, version: "101.0.0" });
    await runTopLevel(registerUpgradeCommand, ["upgrade", "--latest", "--no-restart"]);
    expect(coreMocks.fetchPortableLatestVersion).toHaveBeenCalled();
    expect(coreMocks.installPortableSpec).toHaveBeenCalledWith("latest");

    coreMocks.installGlobalSpec.mockResolvedValueOnce({ ok: false, reason: "permission denied" });
    coreMocks.detectInstallMode.mockReturnValue("global");
    await expect(runTopLevel(registerUpgradeCommand, ["upgrade"])).rejects.toMatchObject({ code: 1 });

    await runTopLevel(registerUpgradeCommand, ["upgrade", "--no-restart"]);
    expect(coreMocks.installGlobalSpec).toHaveBeenCalledWith("99.0.0");
    expect(printLineMock.mock.calls.map((call) => String(call[0])).join("")).toContain("first-tree-dev daemon restart");

    coreMocks.isServiceSupported.mockReturnValueOnce(false);
    await runTopLevel(registerUpgradeCommand, ["upgrade"]);
    expect(printLineMock.mock.calls.map((call) => String(call[0])).join("")).toContain("No service manager");

    coreMocks.isServiceSupported.mockReturnValue(true);
    coreMocks.getClientServiceStatus.mockReturnValueOnce({ state: "not-installed" });
    await runTopLevel(registerUpgradeCommand, ["upgrade"]);
    expect(printLineMock.mock.calls.map((call) => String(call[0])).join("")).toContain("nothing to restart");

    coreMocks.getClientServiceStatus.mockReturnValueOnce({ state: "inactive" });
    await runTopLevel(registerUpgradeCommand, ["upgrade"]);
    expect(printLineMock.mock.calls.map((call) => String(call[0])).join("")).toContain("leaving it stopped");

    coreMocks.getClientServiceStatus.mockReturnValueOnce({ state: "active" });
    coreMocks.installClientService.mockImplementationOnce(() => {
      throw new Error("unit denied");
    });
    coreMocks.restartClientService.mockReturnValueOnce({ ok: false, reason: "restart denied" });
    await expect(runTopLevel(registerUpgradeCommand, ["upgrade"])).rejects.toMatchObject({ code: 1 });

    coreMocks.getClientServiceStatus.mockReturnValueOnce({ state: "active" });
    coreMocks.restartClientService.mockReturnValueOnce({ ok: true });
    await runTopLevel(registerUpgradeCommand, ["upgrade"]);
    expect(printLineMock.mock.calls.map((call) => String(call[0])).join("")).toContain("Service restarted");
  });
});
