import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const outputMocks = vi.hoisted(() => ({
  fail: vi.fn((code: string, message: string, exitCode = 1) => {
    throw Object.assign(new Error(message), { code, exitCode });
  }),
  line: vi.fn(),
}));

const promptMocks = vi.hoisted(() => ({
  confirm: vi.fn(),
}));

const serviceMocks = vi.hoisted(() => ({
  getClientServiceStatus: vi.fn(),
  stopClientService: vi.fn(),
}));

vi.mock("@inquirer/prompts", () => promptMocks);
vi.mock("../cli/output.js", () => ({ fail: outputMocks.fail }));
vi.mock("../core/output.js", () => ({ print: { line: outputMocks.line } }));
vi.mock("../core/service-install.js", () => serviceMocks);

let home = "";
let originalHome: string | undefined;
const children: ChildProcess[] = [];

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeClientYaml(clientId: string, serverUrl: string, dir = join(home, "config")): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "client.yaml"), `server:\n  url: ${serverUrl}\nclient:\n  id: ${clientId}\n`);
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function daemonStartCommand(): string {
  const escapedNode = process.execPath.replace(/'/g, "'\\''");
  return `exec -a 'first-tree daemon start' '${escapedNode}' -e 'setInterval(() => {}, 1000)'`;
}

async function waitForChildVisible(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 75));
}

beforeEach(() => {
  vi.clearAllMocks();
  originalHome = process.env.FIRST_TREE_HOME;
  home = mkdtempSync(join(tmpdir(), "ft-client-switch-tx-"));
  process.env.FIRST_TREE_HOME = home;
  serviceMocks.getClientServiceStatus.mockReturnValue({ state: "inactive", platform: "test" });
  serviceMocks.stopClientService.mockReturnValue({ ok: true });
});

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null && child.pid) {
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {
        // Already stopped.
      }
    }
  }
  rmSync(home, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.FIRST_TREE_HOME;
  else process.env.FIRST_TREE_HOME = originalHome;
});

describe("client switch transaction recovery", () => {
  it("clears a completed journal before starting a fresh switch", async () => {
    const { switchLocalClientForLogin, clientSwitchJournalPath, clientSwitchLockPath } = await import(
      "../core/client-switch.js"
    );
    writeClientYaml("client_aabbccdd", "https://old.example");
    mkdirSync(join(home, "state"), { recursive: true });
    writeJson(clientSwitchLockPath(home), { pid: process.pid });
    writeJson(clientSwitchJournalPath(home), {
      version: 1,
      id: "switch-complete",
      phase: "complete",
      from: { clientId: "client_aabbccdd", userId: "user-old", serverUrl: "https://old.example" },
      to: { clientId: "client_11223344", userId: "user-new", serverUrl: "https://new.example" },
      moves: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const config = await switchLocalClientForLogin({
      existingCredentials: {
        accessToken: "old-access",
        refreshToken: "old-refresh",
        serverUrl: "https://old.example",
      },
      previousOwnerSub: "user-old",
      targetTokens: {
        accessToken: "new-access",
        refreshToken: "new-refresh",
        serverUrl: "https://new.example",
      },
      targetOwnerSub: "user-new",
    });

    expect(config.server.url).toBe("https://new.example");
    expect(existsSync(clientSwitchJournalPath(home))).toBe(false);
    expect(existsSync(clientSwitchLockPath(home))).toBe(false);
  });

  it("parks the active client and creates a fresh target client", async () => {
    const { switchLocalClientForLogin, clientSwitchJournalPath, clientSwitchLockPath } = await import(
      "../core/client-switch.js"
    );
    writeClientYaml("client_aabbccdd", "https://old.example");
    mkdirSync(join(home, "config", "agents", "old-agent"), { recursive: true });
    mkdirSync(join(home, "data", "sessions", "old-session"), { recursive: true });

    const config = await switchLocalClientForLogin({
      existingCredentials: {
        accessToken: "old-access",
        refreshToken: "old-refresh",
        serverUrl: "https://old.example",
      },
      previousOwnerSub: "user-old",
      targetTokens: {
        accessToken: "new-access",
        refreshToken: "new-refresh",
        serverUrl: "https://new.example",
      },
      targetOwnerSub: "user-new",
    });

    expect(config.client.id).toMatch(/^client_[a-f0-9]{8}$/);
    expect(config.server.url).toBe("https://new.example");
    expect(existsSync(join(home, "parked-clients", "client_aabbccdd", "config", "client.yaml"))).toBe(true);
    expect(existsSync(join(home, "parked-clients", "client_aabbccdd", "config", "agents", "old-agent"))).toBe(true);
    expect(readFileSync(join(home, "config", "credentials.json"), "utf8")).toContain("new-refresh");
    expect(existsSync(clientSwitchJournalPath(home))).toBe(false);
    expect(existsSync(clientSwitchLockPath(home))).toBe(false);

    const index = readJson(join(home, "parked-clients", "index.json")) as {
      activeClientId: string;
      clients: Record<string, { storage: string }>;
    };
    expect(index.activeClientId).toBe(config.client.id);
    expect(index.clients.client_aabbccdd?.storage).toBe("parked");
    expect(index.clients[config.client.id]?.storage).toBe("active-root");
  });

  it("restores a remembered parked client during login switching", async () => {
    const { switchLocalClientForLogin } = await import("../core/client-switch.js");
    writeClientYaml("client_aabbccdd", "https://old.example");
    const parkedTarget = join(home, "parked-clients", "client_11223344");
    writeClientYaml("client_11223344", "https://new.example", join(parkedTarget, "config"));
    mkdirSync(join(parkedTarget, "config", "agents", "target-agent"), { recursive: true });
    mkdirSync(join(parkedTarget, "data", "sessions", "target-session"), { recursive: true });
    writeJson(join(home, "parked-clients", "index.json"), {
      version: 1,
      activeClientId: "client_aabbccdd",
      accountDefaults: {
        "https://new.example\nuser-new": "client_11223344",
      },
      clients: {
        client_11223344: {
          clientId: "client_11223344",
          userId: "user-new",
          serverUrl: "https://new.example",
          storage: "parked",
          parkedPath: parkedTarget,
          updatedAt: new Date().toISOString(),
        },
      },
    });

    const config = await switchLocalClientForLogin({
      existingCredentials: {
        accessToken: "old-access",
        refreshToken: "old-refresh",
        serverUrl: "https://old.example",
      },
      previousOwnerSub: "user-old",
      targetTokens: {
        accessToken: "new-access",
        refreshToken: "new-refresh",
        serverUrl: "https://new.example",
      },
      targetOwnerSub: "user-new",
    });

    expect(config.client.id).toBe("client_11223344");
    expect(existsSync(join(home, "config", "agents", "target-agent"))).toBe(true);
    expect(existsSync(join(home, "data", "sessions", "target-session"))).toBe(true);
    const index = readJson(join(home, "parked-clients", "index.json")) as {
      activeClientId: string;
      clients: Record<string, { storage: string }>;
    };
    expect(index.activeClientId).toBe("client_11223344");
    expect(index.clients.client_11223344?.storage).toBe("active-root");
  });

  it("resumes a pending journal and restores the target client", async () => {
    const { switchLocalClientForLogin, clientSwitchJournalPath, clientSwitchLockPath } = await import(
      "../core/client-switch.js"
    );
    const parkedTarget = join(home, "parked-clients", "client_11223344");
    writeClientYaml("client_11223344", "https://new.example", join(parkedTarget, "config"));
    mkdirSync(join(home, "state"), { recursive: true });
    writeJson(clientSwitchLockPath(home), { pid: process.pid });
    writeJson(clientSwitchJournalPath(home), {
      version: 1,
      id: "switch-pending",
      phase: "parked-old-client",
      from: { clientId: "client_aabbccdd", userId: "user-old", serverUrl: "https://old.example" },
      to: { clientId: "client_11223344", userId: "user-new", serverUrl: "https://new.example" },
      moves: [
        {
          kind: "park-client-yaml",
          group: "park",
          source: join(home, "config", "client.yaml"),
          target: join(home, "parked-clients", "client_aabbccdd", "config", "client.yaml"),
          required: true,
          state: "done",
        },
        {
          kind: "restore-client-yaml",
          group: "restore",
          source: join(parkedTarget, "config", "client.yaml"),
          target: join(home, "config", "client.yaml"),
          required: true,
          state: "pending",
        },
        {
          kind: "restore-agents",
          group: "restore",
          source: join(parkedTarget, "config", "agents"),
          target: join(home, "config", "agents"),
          required: false,
          state: "pending",
        },
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const config = await switchLocalClientForLogin({
      targetTokens: { accessToken: "new", refreshToken: "refresh", serverUrl: "https://new.example" },
      targetOwnerSub: "user-new",
    });

    expect(config.client.id).toBe("client_11223344");
    expect(existsSync(clientSwitchJournalPath(home))).toBe(false);
    expect(existsSync(clientSwitchLockPath(home))).toBe(false);
    const index = readJson(join(home, "parked-clients", "index.json")) as {
      activeClientId: string;
      clients: Record<string, { storage: string }>;
    };
    expect(index.activeClientId).toBe("client_11223344");
    expect(index.clients.client_aabbccdd?.storage).toBe("parked");
  });

  it("fails before switching when the existing owner or active client id is unknown", async () => {
    const { switchLocalClientForLogin } = await import("../core/client-switch.js");

    await expect(
      switchLocalClientForLogin({
        targetTokens: { accessToken: "new", refreshToken: "refresh", serverUrl: "https://new.example" },
        targetOwnerSub: "user-new",
      }),
    ).rejects.toMatchObject({ code: "CLIENT_OWNER_UNKNOWN_REQUIRES_RESET_OR_OWNER_LOGIN" });

    mkdirSync(join(home, "config"), { recursive: true });
    writeFileSync(join(home, "config", "client.yaml"), "server:\n  url: https://old.example\n");
    await expect(
      switchLocalClientForLogin({
        existingCredentials: { accessToken: "old", refreshToken: "refresh", serverUrl: "https://old.example" },
        previousOwnerSub: "user-old",
        targetTokens: { accessToken: "new", refreshToken: "refresh", serverUrl: "https://new.example" },
        targetOwnerSub: "user-new",
      }),
    ).rejects.toMatchObject({ code: "CLIENT_OWNER_UNKNOWN_REQUIRES_RESET_OR_OWNER_LOGIN" });
  });

  it("guards pending journals that need manual repair or a fresh retry", async () => {
    const { switchLocalClientForLogin, clientSwitchJournalPath, clientSwitchLockPath } = await import(
      "../core/client-switch.js"
    );
    mkdirSync(join(home, "state"), { recursive: true });
    writeJson(join(home, "state", "client-switch.lock"), { pid: process.pid });
    writeJson(clientSwitchJournalPath(home), {
      version: 1,
      id: "switch-test",
      phase: "service-stopped",
      from: { clientId: "client_aabbccdd", userId: "user-old", serverUrl: "https://old.example" },
      to: { userId: "other-user", serverUrl: "https://new.example" },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await expect(
      switchLocalClientForLogin({
        targetTokens: { accessToken: "new", refreshToken: "refresh", serverUrl: "https://new.example" },
        targetOwnerSub: "user-new",
      }),
    ).rejects.toMatchObject({ code: "CLIENT_SWITCH_MANUAL_REPAIR_REQUIRED" });

    writeJson(clientSwitchJournalPath(home), {
      version: 1,
      id: "switch-test",
      phase: "service-stopped",
      from: { clientId: "client_aabbccdd", userId: "user-old", serverUrl: "https://old.example" },
      to: { userId: "user-new", serverUrl: "https://new.example" },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await expect(
      switchLocalClientForLogin({
        targetTokens: { accessToken: "new", refreshToken: "refresh", serverUrl: "https://new.example" },
        targetOwnerSub: "user-new",
      }),
    ).rejects.toMatchObject({ code: "CLIENT_SWITCH_RETRY_REQUIRED" });
    expect(existsSync(clientSwitchJournalPath(home))).toBe(false);
    expect(existsSync(clientSwitchLockPath(home))).toBe(false);
  });

  it("requires manual repair when an existing lock blocks a fresh switch", async () => {
    const { switchLocalClientForLogin, clientSwitchLockPath } = await import("../core/client-switch.js");
    writeClientYaml("client_aabbccdd", "https://old.example");
    mkdirSync(join(home, "state"), { recursive: true });
    writeJson(clientSwitchLockPath(home), { pid: process.pid });

    await expect(
      switchLocalClientForLogin({
        existingCredentials: { accessToken: "old", refreshToken: "refresh", serverUrl: "https://old.example" },
        previousOwnerSub: "user-old",
        targetTokens: { accessToken: "new", refreshToken: "refresh", serverUrl: "https://new.example" },
        targetOwnerSub: "user-new",
      }),
    ).rejects.toMatchObject({ code: "CLIENT_SWITCH_MANUAL_REPAIR_REQUIRED" });
  });

  it("fails pending journal recovery when move state is ambiguous", async () => {
    const { switchLocalClientForLogin, clientSwitchJournalPath, clientSwitchLockPath } = await import(
      "../core/client-switch.js"
    );
    const parkedTarget = join(home, "parked-clients", "client_11223344");
    writeClientYaml("client_11223344", "https://new.example", join(parkedTarget, "config"));
    writeClientYaml("client_existing", "https://new.example", join(home, "config"));
    mkdirSync(join(home, "state"), { recursive: true });
    writeJson(clientSwitchLockPath(home), { pid: process.pid });
    writeJson(clientSwitchJournalPath(home), {
      version: 1,
      id: "switch-ambiguous",
      phase: "parked-old-client",
      from: { clientId: "client_aabbccdd", userId: "user-old", serverUrl: "https://old.example" },
      to: { clientId: "client_11223344", userId: "user-new", serverUrl: "https://new.example" },
      moves: [
        {
          kind: "restore-client-yaml",
          group: "restore",
          source: join(parkedTarget, "config", "client.yaml"),
          target: join(home, "config", "client.yaml"),
          required: true,
          state: "pending",
        },
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await expect(
      switchLocalClientForLogin({
        targetTokens: { accessToken: "new", refreshToken: "refresh", serverUrl: "https://new.example" },
        targetOwnerSub: "user-new",
      }),
    ).rejects.toMatchObject({ code: "CLIENT_SWITCH_MANUAL_REPAIR_REQUIRED" });
  });

  it("fails pending journal recovery when a required move disappeared", async () => {
    const { switchLocalClientForLogin, clientSwitchJournalPath, clientSwitchLockPath } = await import(
      "../core/client-switch.js"
    );
    mkdirSync(join(home, "state"), { recursive: true });
    writeJson(clientSwitchLockPath(home), { pid: process.pid });
    writeJson(clientSwitchJournalPath(home), {
      version: 1,
      id: "switch-missing",
      phase: "parked-old-client",
      from: { clientId: "client_aabbccdd", userId: "user-old", serverUrl: "https://old.example" },
      to: { clientId: "client_11223344", userId: "user-new", serverUrl: "https://new.example" },
      moves: [
        {
          kind: "restore-client-yaml",
          group: "restore",
          source: join(home, "missing", "client.yaml"),
          target: join(home, "config", "client.yaml"),
          required: true,
          state: "pending",
        },
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await expect(
      switchLocalClientForLogin({
        targetTokens: { accessToken: "new", refreshToken: "refresh", serverUrl: "https://new.example" },
        targetOwnerSub: "user-new",
      }),
    ).rejects.toMatchObject({ code: "CLIENT_SWITCH_MANUAL_REPAIR_REQUIRED" });
  });

  it("fails when the supervisor cannot be proven safely stopped", async () => {
    const { switchLocalClientForLogin } = await import("../core/client-switch.js");
    writeClientYaml("client_aabbccdd", "https://old.example");
    serviceMocks.getClientServiceStatus.mockReturnValueOnce({
      state: "unknown",
      platform: "test",
      detail: "no supervisor",
    });

    await expect(
      switchLocalClientForLogin({
        existingCredentials: { accessToken: "old", refreshToken: "refresh", serverUrl: "https://old.example" },
        previousOwnerSub: "user-old",
        targetTokens: { accessToken: "new", refreshToken: "refresh", serverUrl: "https://new.example" },
        targetOwnerSub: "user-new",
      }),
    ).rejects.toMatchObject({ code: "CLIENT_SWITCH_SUPERVISOR_UNSAFE" });
  });

  it("fails when an active supervisor cannot be stopped", async () => {
    const { switchLocalClientForLogin } = await import("../core/client-switch.js");
    writeClientYaml("client_aabbccdd", "https://old.example");
    serviceMocks.getClientServiceStatus.mockReturnValueOnce({ state: "active", platform: "test" });
    serviceMocks.stopClientService.mockReturnValueOnce({ ok: false, reason: "permission denied" });

    await expect(
      switchLocalClientForLogin({
        existingCredentials: { accessToken: "old", refreshToken: "refresh", serverUrl: "https://old.example" },
        previousOwnerSub: "user-old",
        targetTokens: { accessToken: "new", refreshToken: "refresh", serverUrl: "https://new.example" },
        targetOwnerSub: "user-new",
      }),
    ).rejects.toMatchObject({ code: "CLIENT_SWITCH_SUPERVISOR_UNSAFE" });
  });

  it("fails when the supervisor remains active after stop", async () => {
    const { switchLocalClientForLogin } = await import("../core/client-switch.js");
    writeClientYaml("client_aabbccdd", "https://old.example");
    serviceMocks.getClientServiceStatus
      .mockReturnValueOnce({ state: "active", platform: "test" })
      .mockReturnValueOnce({ state: "active", platform: "test", detail: "still running" });

    await expect(
      switchLocalClientForLogin({
        existingCredentials: { accessToken: "old", refreshToken: "refresh", serverUrl: "https://old.example" },
        previousOwnerSub: "user-old",
        targetTokens: { accessToken: "new", refreshToken: "refresh", serverUrl: "https://new.example" },
        targetOwnerSub: "user-new",
      }),
    ).rejects.toMatchObject({ code: "CLIENT_SWITCH_SUPERVISOR_UNSAFE" });
  });

  it("fails when a runtime marker is still live for the active client", async () => {
    const { switchLocalClientForLogin, registerClientRuntimeMarker } = await import("../core/client-switch.js");
    writeClientYaml("client_aabbccdd", "https://old.example");
    registerClientRuntimeMarker({ clientId: "client_aabbccdd", mode: "foreground", home, pid: process.pid });

    await expect(
      switchLocalClientForLogin({
        existingCredentials: { accessToken: "old", refreshToken: "refresh", serverUrl: "https://old.example" },
        previousOwnerSub: "user-old",
        targetTokens: { accessToken: "new", refreshToken: "refresh", serverUrl: "https://new.example" },
        targetOwnerSub: "user-new",
      }),
    ).rejects.toMatchObject({ code: "CLIENT_SWITCH_RUNTIME_ACTIVE" });
  });

  it("summarizes many live runtime markers before switching", async () => {
    const { switchLocalClientForLogin, clientRuntimeMarkerPath } = await import("../core/client-switch.js");
    writeClientYaml("client_aabbccdd", "https://old.example");
    const markerDir = join(home, "state", "client-runtimes");
    mkdirSync(markerDir, { recursive: true });
    for (let index = 0; index < 9; index += 1) {
      const pid = 70_000 + index;
      writeJson(clientRuntimeMarkerPath(home, pid), {
        version: 1,
        pid,
        clientId: "client_aabbccdd",
        home,
        mode: index % 2 === 0 ? "foreground" : "service",
        createdAt: new Date().toISOString(),
      });
    }
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      await expect(
        switchLocalClientForLogin({
          existingCredentials: { accessToken: "old", refreshToken: "refresh", serverUrl: "https://old.example" },
          previousOwnerSub: "user-old",
          targetTokens: { accessToken: "new", refreshToken: "refresh", serverUrl: "https://new.example" },
          targetOwnerSub: "user-new",
        }),
      ).rejects.toMatchObject({
        code: "CLIENT_SWITCH_RUNTIME_ACTIVE",
        message: expect.stringContaining("...and 1 more"),
      });
    } finally {
      kill.mockRestore();
    }
  });

  it("fails when marked provider work is still running for the active client", async () => {
    const { switchLocalClientForLogin } = await import("../core/client-switch.js");
    writeClientYaml("client_aabbccdd", "https://old.example");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
      env: {
        ...process.env,
        FIRST_TREE_HOME: home,
        FIRST_TREE_CLIENT_ID: "client_aabbccdd",
        FIRST_TREE_SWITCH_DRAIN_VERSION: "1",
        FIRST_TREE_PROVIDER: "codex",
      },
    });
    children.push(child);

    await expect(
      switchLocalClientForLogin({
        existingCredentials: { accessToken: "old", refreshToken: "refresh", serverUrl: "https://old.example" },
        previousOwnerSub: "user-old",
        targetTokens: { accessToken: "new", refreshToken: "refresh", serverUrl: "https://new.example" },
        targetOwnerSub: "user-new",
      }),
    ).rejects.toMatchObject({ code: "CLIENT_SWITCH_DRAIN_TIMEOUT" });
  });

  it("fails when provider work appears during the second switch drain scan", async () => {
    const { switchLocalClientForLogin } = await import("../core/client-switch.js");
    writeClientYaml("client_aabbccdd", "https://old.example");
    setTimeout(() => {
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
        env: {
          ...process.env,
          FIRST_TREE_HOME: home,
          FIRST_TREE_CLIENT_ID: "client_aabbccdd",
          FIRST_TREE_SWITCH_DRAIN_VERSION: "1",
          FIRST_TREE_PROVIDER: "codex",
          FIRST_TREE_AGENT_ID: "agent-late",
          FIRST_TREE_CHAT_ID: "chat-late",
        },
      });
      children.push(child);
    }, 100);

    await expect(
      switchLocalClientForLogin({
        existingCredentials: { accessToken: "old", refreshToken: "refresh", serverUrl: "https://old.example" },
        previousOwnerSub: "user-old",
        targetTokens: { accessToken: "new", refreshToken: "refresh", serverUrl: "https://new.example" },
        targetOwnerSub: "user-new",
      }),
    ).rejects.toMatchObject({
      code: "CLIENT_SWITCH_DRAIN_TIMEOUT",
      message: expect.stringContaining("agent=agent-late"),
    });
  });

  it("fails closed when a daemon process lacks trusted drain markers", async () => {
    const { switchLocalClientForLogin } = await import("../core/client-switch.js");
    writeClientYaml("client_aabbccdd", "https://old.example");
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.FIRST_TREE_HOME;
    delete env.FIRST_TREE_CLIENT_ID;
    delete env.FIRST_TREE_SWITCH_DRAIN_VERSION;
    const child = spawn("bash", ["-c", daemonStartCommand()], { env });
    children.push(child);
    await waitForChildVisible();

    await expect(
      switchLocalClientForLogin({
        existingCredentials: { accessToken: "old", refreshToken: "refresh", serverUrl: "https://old.example" },
        previousOwnerSub: "user-old",
        targetTokens: { accessToken: "new", refreshToken: "refresh", serverUrl: "https://new.example" },
        targetOwnerSub: "user-new",
      }),
    ).rejects.toMatchObject({
      code: "CLIENT_SWITCH_DRAIN_UNSUPPORTED",
      message: expect.stringContaining("daemon runtime lacks trusted switch drain markers"),
    });
  });

  it("ignores daemon processes that belong to another client", async () => {
    const { switchLocalClientForLogin } = await import("../core/client-switch.js");
    writeClientYaml("client_aabbccdd", "https://old.example");
    const env: NodeJS.ProcessEnv = { ...process.env, FIRST_TREE_CLIENT_ID: "client_11223344" };
    delete env.FIRST_TREE_HOME;
    delete env.FIRST_TREE_SWITCH_DRAIN_VERSION;
    const child = spawn("bash", ["-c", daemonStartCommand()], { env });
    children.push(child);
    await waitForChildVisible();

    const config = await switchLocalClientForLogin({
      existingCredentials: { accessToken: "old", refreshToken: "refresh", serverUrl: "https://old.example" },
      previousOwnerSub: "user-old",
      targetTokens: { accessToken: "new", refreshToken: "refresh", serverUrl: "https://new.example" },
      targetOwnerSub: "user-new",
    });

    expect(config.server.url).toBe("https://new.example");
  });

  it("confirms interactive switches and records cross-server confirmation output", async () => {
    const { confirmLocalClientSwitch } = await import("../core/client-switch.js");
    const originalTty = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    promptMocks.confirm.mockResolvedValueOnce(true);

    await confirmLocalClientSwitch({
      existingServerUrl: "https://old.example",
      targetServerUrl: "https://new.example",
      existingUserId: "user-old",
      targetUserId: "user-new",
      existingClientId: "client_aabbccdd",
      targetClientId: "client_11223344",
    });

    expect(promptMocks.confirm).toHaveBeenCalledWith({
      message: expect.stringContaining("client_aabbccdd"),
      default: false,
    });
    expect(outputMocks.line).toHaveBeenCalledWith(
      expect.stringContaining("https://old.example -> https://new.example"),
    );
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: originalTty });
  });

  it("formats interactive confirmation defaults when user and client ids are unknown", async () => {
    const { confirmLocalClientSwitch } = await import("../core/client-switch.js");
    const originalTty = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    promptMocks.confirm.mockResolvedValueOnce(true);

    await confirmLocalClientSwitch({
      existingServerUrl: "https://same.example",
      targetServerUrl: "https://same.example",
    });

    expect(promptMocks.confirm).toHaveBeenCalledWith({
      message: expect.stringContaining("the current user"),
      default: false,
    });
    expect(promptMocks.confirm).toHaveBeenCalledWith({
      message: expect.stringContaining("create or restore a separate local client"),
      default: false,
    });
    expect(outputMocks.line).not.toHaveBeenCalledWith(expect.stringContaining("Switching server:"));
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: originalTty });
  });

  it("supports forced switches and rejects non-interactive or cancelled confirmations", async () => {
    const { confirmLocalClientSwitch } = await import("../core/client-switch.js");
    const originalTty = process.stdin.isTTY;

    await expect(
      confirmLocalClientSwitch({
        existingServerUrl: "https://old.example",
        targetServerUrl: "https://new.example",
        forceSwitch: true,
      }),
    ).resolves.toBeUndefined();

    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
    await expect(
      confirmLocalClientSwitch({
        existingServerUrl: "https://old.example",
        targetServerUrl: "https://new.example",
      }),
    ).rejects.toMatchObject({ code: "ACCOUNT_SWITCH_REQUIRES_CONFIRMATION" });

    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    promptMocks.confirm.mockResolvedValueOnce(false);
    await expect(
      confirmLocalClientSwitch({
        existingServerUrl: "https://same.example",
        targetServerUrl: "https://same.example",
      }),
    ).rejects.toMatchObject({ code: "ACCOUNT_SWITCH_CANCELLED" });

    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: originalTty });
  });
});
