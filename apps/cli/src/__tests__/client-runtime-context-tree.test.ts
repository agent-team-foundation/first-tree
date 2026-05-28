import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Context Tree sync is agent-scoped: `AgentSlot.start()` binds the agent,
 * then fetches `/api/v1/agent/context-tree/info` through that agent's SDK.
 * The CLI-level `ClientRuntime` must not resolve one shared user-primary-org
 * binding and pass it into every slot.
 */

const slotInstances: Array<{
  name: string;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  getQuietGateSnapshot: ReturnType<typeof vi.fn>;
}> = [];
const updateDisposeMock = vi.fn();
const updateAttachOptions: unknown[] = [];
const updateAttachMock = vi.fn((_connection: unknown, options: unknown) => {
  updateAttachOptions.push(options);
  return { dispose: updateDisposeMock };
});
const killAllMock = vi.fn(async () => undefined);
const gcOrphanSessionBranchesMock = vi.fn(async () => ({ scanned: 0, deleted: 0, failed: 0 }));
const slotStartResults: unknown[] = [];
const slotQuietSnapshots = new Map<string, { activeCount: number; lastActivityMs: number }>();
const connectionListeners = new Map<string, (...args: unknown[]) => void>();
const connectionMock = {
  clientId: "client-test",
  paused: false,
  on: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
    connectionListeners.set(event, fn);
  }),
  connect: vi.fn(async () => undefined),
  disconnect: vi.fn(async () => undefined),
  clearPaused: vi.fn(() => {
    connectionMock.paused = false;
  }),
  emit: vi.fn(),
  getPausedReason: vi.fn(() => (connectionMock.paused ? "auth_refresh_failed" : null)),
  isPaused: vi.fn(() => connectionMock.paused),
};
vi.mock("@first-tree/client", () => {
  class FakeAgentSlot {
    public readonly name: string;
    public start = vi.fn(async () => {
      const next = slotStartResults.shift();
      if (next instanceof Error) throw next;
      if (next && typeof next === "object") return next;
      return { displayName: this.name, agentId: this.name };
    });
    public stop = vi.fn(async () => undefined);
    public getQuietGateSnapshot = vi.fn(
      () => slotQuietSnapshots.get(this.name) ?? { activeCount: 0, lastActivityMs: 0 },
    );
    constructor(opts: { name: string }) {
      this.name = opts.name;
      slotInstances.push(this);
    }
  }
  return {
    AgentSlot: FakeAgentSlot,
    ClientConnection: class {
      clientId = connectionMock.clientId;
      on = connectionMock.on;
      connect = connectionMock.connect;
      disconnect = connectionMock.disconnect;
      clearPaused = connectionMock.clearPaused;
      emit = connectionMock.emit;
      getPausedReason = connectionMock.getPausedReason;
      isPaused = connectionMock.isPaused;
    },
    UpdateManager: { attach: updateAttachMock },
    createGitMirrorManager: vi.fn(() => ({
      ensureMirror: vi.fn(),
      fetchMirror: vi.fn(),
      createWorktree: vi.fn(),
      removeWorktree: vi.fn(),
      gcMirrors: vi.fn(async () => ({ removed: [] })),
      gcOrphanSessionBranches: gcOrphanSessionBranchesMock,
      mirrorsRoot: "/tmp/fake-mirrors",
    })),
    createLogger: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      fatal: vi.fn(),
      child: vi.fn().mockReturnThis(),
    })),
    getChildProcessRegistry: vi.fn(() => ({ killAll: killAllMock })),
    getHandlerFactory: vi.fn(() => vi.fn()),
    registerBuiltinHandlers: vi.fn(),
  };
});

vi.mock("../core/bootstrap.js", () => ({
  ensureFreshAccessToken: vi.fn(async () => "tok-test"),
}));

vi.mock("../core/output.js", () => ({
  print: {
    status: vi.fn(),
    check: vi.fn(),
    blank: vi.fn(),
    line: vi.fn(),
    result: vi.fn(),
    fail: vi.fn(),
  },
  setJsonMode: vi.fn(),
  isJsonMode: vi.fn(() => false),
}));

vi.mock("../core/version.js", () => ({
  CLI_USER_AGENT: "first-tree-test/0.0.0",
}));

describe("ClientRuntime context-tree wiring", () => {
  let tmp: string;
  let previousFirstTreeHome: string | undefined;

  beforeEach(() => {
    previousFirstTreeHome = process.env.FIRST_TREE_HOME;
    tmp = mkdtempSync(join(tmpdir(), "first-tree-client-runtime-"));
    slotInstances.length = 0;
    slotStartResults.length = 0;
    slotQuietSnapshots.clear();
    updateAttachOptions.length = 0;
    connectionListeners.clear();
    connectionMock.paused = false;
    connectionMock.on.mockClear();
    connectionMock.connect.mockClear();
    connectionMock.disconnect.mockClear();
    connectionMock.clearPaused.mockClear();
    connectionMock.emit.mockClear();
    connectionMock.getPausedReason.mockClear();
    connectionMock.isPaused.mockClear();
    updateAttachMock.mockClear();
    updateDisposeMock.mockClear();
    killAllMock.mockClear();
    gcOrphanSessionBranchesMock.mockResolvedValue({ scanned: 0, deleted: 0, failed: 0 });
  });

  afterEach(() => {
    vi.clearAllMocks();
    if (previousFirstTreeHome === undefined) delete process.env.FIRST_TREE_HOME;
    else process.env.FIRST_TREE_HOME = previousFirstTreeHome;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("starts eager slots without a shared Context Tree binding", async () => {
    const { ClientRuntime } = await import("../core/client-runtime.js");
    const rt = new ClientRuntime("https://hub.test", "client-test");
    rt.addAgent("alpha", {
      agentId: "agent-alpha",
      runtime: "claude-code",
      session: { idle_timeout: 300, max_sessions: 4, working_grace_seconds: 3600 },
      concurrency: 1,
    } as unknown as Parameters<typeof rt.addAgent>[1]);

    await rt.start();

    expect(slotInstances).toHaveLength(1);
    const slot = slotInstances[0];
    if (!slot) throw new Error("slot not constructed");
    expect(slot.start).toHaveBeenCalledTimes(1);
    expect(slot.start.mock.calls[0]).toEqual([]);
  }, 30_000);

  it("reports no configured agents and attaches update hooks only when fully configured", async () => {
    gcOrphanSessionBranchesMock.mockResolvedValueOnce({ scanned: 4, deleted: 3, failed: 1 });
    const { ClientRuntime } = await import("../core/client-runtime.js");
    const { print } = await import("../core/output.js");
    const rt = new ClientRuntime("https://hub.test", "client-test", {
      currentVersion: "1.2.3",
      update: { onUpdateFailed: vi.fn() },
    } as unknown as ConstructorParameters<typeof ClientRuntime>[2]);

    await rt.start();

    expect(connectionMock.connect).toHaveBeenCalledTimes(1);
    expect(updateAttachMock).toHaveBeenCalledTimes(1);
    expect(print.status).toHaveBeenCalledWith(
      "[git-mirror]",
      "swept orphan session branches — scanned=4 deleted=3 failed=1",
    );
    expect(print.status).toHaveBeenCalledWith("", "no agents configured yet.");
    expect(print.status).toHaveBeenCalledWith(
      "",
      "add one with: first-tree agent create <name> --type claude-code --client-id <id>",
    );

    await rt.stop();

    expect(updateDisposeMock).toHaveBeenCalledTimes(1);
    expect(connectionMock.disconnect).toHaveBeenCalledTimes(1);
    expect(killAllMock).toHaveBeenCalledWith("client-runtime-stop");
  }, 30_000);

  it("auto-registers a server-pinned agent by writing local config and starting the slot", async () => {
    const { ClientRuntime } = await import("../core/client-runtime.js");
    const rt = new ClientRuntime("https://hub.test", "client-test");
    Object.assign(rt, { agentsDir: tmp });

    const pinned = connectionListeners.get("agent:pinned");
    if (!pinned) throw new Error("missing agent:pinned listener");
    pinned({ agentId: "agent-beta", name: "beta", runtimeProvider: "codex" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const configPath = join(tmp, "beta", "agent.yaml");
    expect(existsSync(configPath)).toBe(true);
    expect(readFileSync(configPath, "utf-8")).toContain("agentId: agent-beta");
    expect(readFileSync(configPath, "utf-8")).toContain("runtime: codex");
    expect(slotInstances.map((slot) => slot.name)).toEqual(["beta"]);
    expect(slotInstances[0]?.start).toHaveBeenCalledTimes(1);
  }, 30_000);

  it("exposes paused status and forwards resilience update events", async () => {
    const { ClientRuntime } = await import("../core/client-runtime.js");
    const { print } = await import("../core/output.js");
    const rt = new ClientRuntime("https://hub.test", "client-test");
    connectionMock.paused = true;

    const paused = connectionListeners.get("auth:paused");
    if (!paused) throw new Error("missing auth:paused listener");
    paused("auth_refresh_failed", new Error("refresh rejected"));

    expect(rt.isPaused()).toBe(true);
    expect(rt.pausedReason()).toBe("auth_refresh_failed");
    expect(print.status).toHaveBeenCalledWith("✗", "auth rejected — pausing agents until fresh credentials arrive.");
    expect(print.status).toHaveBeenCalledWith("", "refresh rejected");

    rt.emitConnectionResilienceEvent("resilience.update.failed", {
      reasonCode: "download_failed",
      retryable: true,
      targetVersion: "1.2.4",
    });

    expect(connectionMock.emit).toHaveBeenCalledWith("resilience.update.failed", {
      reasonCode: "download_failed",
      retryable: true,
      targetVersion: "1.2.4",
    });
  });

  it("covers transport events, quiet-gate aggregation, and slot start failures", async () => {
    const { ClientRuntime } = await import("../core/client-runtime.js");
    const { print } = await import("../core/output.js");
    const rt = new ClientRuntime("https://hub.test", "client-test", {
      currentVersion: "1.2.3",
      update: { onUpdateFailed: vi.fn() },
    } as unknown as ConstructorParameters<typeof ClientRuntime>[2]);
    rt.addAgent("alpha", {
      agentId: "agent-alpha",
      runtime: "claude-code",
      session: { idle_timeout: 300, max_sessions: 4, working_grace_seconds: 3600 },
      concurrency: 1,
    } as unknown as Parameters<typeof rt.addAgent>[1]);
    rt.addAgent("beta", {
      agentId: "agent-beta",
      runtime: "codex",
      session: { idle_timeout: 300, max_sessions: 4, working_grace_seconds: 3600 },
      concurrency: 1,
    } as unknown as Parameters<typeof rt.addAgent>[1]);
    slotQuietSnapshots.set("alpha", { activeCount: 2, lastActivityMs: 25 });
    slotQuietSnapshots.set("beta", { activeCount: 1, lastActivityMs: 40 });
    slotStartResults.push({ displayName: "Alpha", agentId: "agent-alpha" }, new Error("beta offline"));
    gcOrphanSessionBranchesMock.mockRejectedValueOnce(new Error("gc unavailable"));

    connectionListeners.get("auth:expired")?.();
    connectionListeners.get("auth:resumed")?.("auth_refresh_failed");
    connectionListeners.get("error")?.(new Error("socket reset"));
    await rt.start();

    const attachOptions = updateAttachOptions[0];
    if (!attachOptions || typeof attachOptions !== "object" || !("getQuietGateSnapshot" in attachOptions)) {
      throw new Error("missing update attach options");
    }
    const quietSnapshot = Reflect.get(attachOptions, "getQuietGateSnapshot");
    if (typeof quietSnapshot !== "function") throw new Error("missing quiet gate callback");

    expect(quietSnapshot()).toEqual({ activeCount: 3, lastActivityMs: 40 });
    expect(print.status).toHaveBeenCalledWith("⚠️", "access token expired — reconnecting after refresh...");
    expect(print.status).toHaveBeenCalledWith(
      "✓",
      "credentials refreshed — resuming agents (was paused: auth_refresh_failed)",
    );
    expect(print.status).toHaveBeenCalledWith("⚠️", "client connection error: socket reset");
    expect(print.status).toHaveBeenCalledWith("⚠️", "git-mirror orphan sweep failed: gc unavailable");
    expect(print.check).toHaveBeenCalledWith(false, "beta: connection failed", "beta offline");
  }, 30_000);

  it("watches agent and credential directories, then closes pending watchers", async () => {
    process.env.FIRST_TREE_HOME = tmp;
    const configDir = join(tmp, "config");
    const agentsDir = join(configDir, "agents");
    const credentialsPath = join(configDir, "credentials.json");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(credentialsPath, JSON.stringify({ accessToken: "old" }));

    const { ClientRuntime } = await import("../core/client-runtime.js");
    const { print } = await import("../core/output.js");
    const rt = new ClientRuntime("https://hub.test", "client-test");
    rt.watchAgentsDir(join(tmp, "missing-agents"));
    rt.watchAgentsDir(agentsDir);
    rt.watchAgentsDir(agentsDir);

    connectionMock.paused = true;
    connectionListeners.get("auth:paused")?.("auth_refresh_failed", new Error("refresh rejected"));
    writeFileSync(credentialsPath, JSON.stringify({ accessToken: "new" }));
    await new Promise((resolve) => setTimeout(resolve, 350));

    expect(connectionMock.clearPaused).toHaveBeenCalledTimes(1);
    expect(print.status).toHaveBeenCalledWith("", "credentials.json updated — clearing paused mode");

    rt.unwatchAgentsDir();
    await rt.stop();
  }, 30_000);

  it("handles pinned-agent edge cases and scan failures", async () => {
    const { writeFileSync } = await import("node:fs");
    const { ClientRuntime } = await import("../core/client-runtime.js");
    const { print } = await import("../core/output.js");
    const invokePrivate = (target: object, name: string, ...args: unknown[]): unknown => {
      const fn = Reflect.get(target, name);
      if (typeof fn !== "function") throw new Error(`missing ${name}`);
      return Reflect.apply(fn, target, args);
    };

    const rt = new ClientRuntime("https://hub.test", "client-test");
    const pinned = connectionListeners.get("agent:pinned");
    if (!pinned) throw new Error("missing agent:pinned listener");

    pinned({ agentId: "agent-without-dir", name: "missing-dir-agent", runtimeProvider: "claude-code" });
    expect(print.status).toHaveBeenCalledWith(
      "⚠️",
      "agent pinned (agent-without-dir) but no agents dir set — cannot auto-register.",
    );

    Object.assign(rt, { agentsDir: tmp });
    rt.addAgent("agent-019e6dc95fed7c1a", {
      agentId: "existing-agent",
      runtime: "claude-code",
      session: { idle_timeout: 300, max_sessions: 4, working_grace_seconds: 3600 },
      concurrency: 1,
    } as unknown as Parameters<typeof rt.addAgent>[1]);
    pinned({ agentId: "019e6dc95fed-7c1a-aabb-ccddeeff0011", runtimeProvider: "codex" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(existsSync(join(tmp, "agent-019e6dc95fed7c1a-2", "agent.yaml"))).toBe(true);

    writeFileSync(join(tmp, "not-a-directory"), "");
    Object.assign(rt, { agentsDir: join(tmp, "not-a-directory") });
    pinned({ agentId: "agent-write-fails", name: "will-fail", runtimeProvider: "codex" });
    expect(print.check).toHaveBeenCalledWith(false, 'failed to auto-add agent "will-fail"', expect.any(String));

    invokePrivate(rt, "scanForNewAgents", join(tmp, "not-a-directory"));
    invokePrivate(rt, "startAgent", "does-not-exist");

    const names = Reflect.get(rt, "agentNames");
    if (!(names instanceof Set)) throw new Error("missing agentNames");
    for (let suffix = 2; suffix < 1000; suffix++) {
      names.add(`agent-deadbeef-${suffix}`);
    }
    names.add("agent-deadbeef");
    expect(
      invokePrivate(rt, "pickLocalName", {
        agentId: "deadbeef",
        runtimeProvider: "claude-code",
      }),
    ).toBe("agent-deadbeef");
  }, 30_000);
});
