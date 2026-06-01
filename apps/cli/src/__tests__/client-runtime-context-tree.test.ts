import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClientPausedReason } from "@first-tree/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Context Tree sync is agent-scoped: `AgentSlot.start()` binds the agent,
 * then fetches `/api/v1/agent/context-tree/info` through that agent's SDK.
 * The CLI-level `ClientRuntime` must not resolve one shared user-primary-org
 * binding and pass it into every slot.
 */

const slotInstances: Array<{
  agentId: string;
  name: string;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  getQuietGateSnapshot: ReturnType<typeof vi.fn>;
}> = [];
const connectionListeners = new Map<string, (...args: unknown[]) => void>();
const RUNTIME_TEST_TIMEOUT_MS = 15_000;
const disposeMock = vi.fn();
const killAllMock = vi.fn(async () => undefined);
const sweepMock = vi.fn(async () => ({ scanned: 0, deleted: 0, failed: 0 }));
const connectionMock = {
  clientId: "client-test",
  on: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
    connectionListeners.set(event, fn);
  }),
  connect: vi.fn(async () => undefined),
  disconnect: vi.fn(async () => undefined),
  emit: vi.fn(),
  isPaused: vi.fn(() => false),
  getPausedReason: vi.fn<() => ClientPausedReason | null>(() => null),
  clearPaused: vi.fn(),
};
vi.mock("@first-tree/client", () => {
  class FakeAgentSlot {
    public readonly agentId: string;
    public readonly name: string;
    public start = vi.fn(async () => ({ displayName: this.name, agentId: this.name }));
    public stop = vi.fn(async () => undefined);
    public getQuietGateSnapshot = vi.fn(() => ({ activeCount: 0, lastActivityMs: 0 }));
    constructor(opts: { agentId: string; name: string }) {
      this.agentId = opts.agentId;
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
      emit = connectionMock.emit;
      isPaused = connectionMock.isPaused;
      getPausedReason = connectionMock.getPausedReason;
      clearPaused = connectionMock.clearPaused;
    },
    UpdateManager: { attach: vi.fn(() => ({ dispose: disposeMock })) },
    createGitMirrorManager: vi.fn(() => ({
      ensureMirror: vi.fn(),
      fetchMirror: vi.fn(),
      createWorktree: vi.fn(),
      removeWorktree: vi.fn(),
      gcMirrors: vi.fn(async () => ({ removed: [] })),
      gcOrphanSessionBranches: sweepMock,
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
    // Mirror the real registry: only the built-in providers have a handler.
    // The unsupported-runtime guard in addAgent keys off this.
    hasHandler: vi.fn((type: string) => type === "claude-code" || type === "codex"),
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
  const originalHome = process.env.FIRST_TREE_HOME;
  let home: string;

  beforeEach(() => {
    vi.resetModules();
    home = mkdtempSync(join(tmpdir(), "ft-client-runtime-"));
    process.env.FIRST_TREE_HOME = home;
    slotInstances.length = 0;
    connectionListeners.clear();
    connectionMock.on.mockClear();
    connectionMock.connect.mockClear();
    connectionMock.disconnect.mockClear();
    connectionMock.emit.mockClear();
    connectionMock.isPaused.mockReset();
    connectionMock.isPaused.mockReturnValue(false);
    connectionMock.getPausedReason.mockReset();
    connectionMock.getPausedReason.mockReturnValue(null);
    connectionMock.clearPaused.mockClear();
    disposeMock.mockClear();
    killAllMock.mockClear();
    sweepMock.mockReset();
    sweepMock.mockResolvedValue({ scanned: 0, deleted: 0, failed: 0 });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.FIRST_TREE_HOME;
    else process.env.FIRST_TREE_HOME = originalHome;
    vi.clearAllMocks();
  });

  it(
    "starts eager slots without a shared Context Tree binding",
    async () => {
      const { ClientRuntime } = await import("../core/client-runtime.js");
      const rt = new ClientRuntime("https://first-tree.test", "client-test");
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
      await rt.stop();
    },
    RUNTIME_TEST_TIMEOUT_MS,
  );

  it(
    "reports suspended local aliases as skipped instead of connection failures",
    async () => {
      const { print } = await import("../core/output.js");
      const { ClientRuntime } = await import("../core/client-runtime.js");
      const rt = new ClientRuntime("https://first-tree.test", "client-test");
      rt.addAgent("active", {
        agentId: "agent-active",
        runtime: "claude-code",
        session: { idle_timeout: 300, max_sessions: 4, working_grace_seconds: 3600 },
        concurrency: 1,
      } as unknown as Parameters<typeof rt.addAgent>[1]);
      rt.addAgent("paused", {
        agentId: "agent-paused",
        runtime: "claude-code",
        session: { idle_timeout: 300, max_sessions: 4, working_grace_seconds: 3600 },
        concurrency: 1,
      } as unknown as Parameters<typeof rt.addAgent>[1]);
      slotInstances[1]?.start.mockRejectedValueOnce(new Error("agent:bind rejected (agent_suspended)"));

      await rt.start();

      expect(print.status).toHaveBeenCalledWith("•", "paused: skipped (suspended)");
      expect(print.status).toHaveBeenCalledWith("", "1 agent(s) running, 1 skipped. Press Ctrl+C to stop.");
      expect(print.check).not.toHaveBeenCalledWith(
        false,
        "paused: connection failed",
        expect.stringContaining("agent_suspended"),
      );

      const pinned = connectionListeners.get("agent:pinned");
      if (!pinned) throw new Error("agent:pinned listener missing");
      pinned({
        agentId: "agent-paused",
        name: "paused",
        runtimeProvider: "claude-code",
      });

      await vi.waitFor(() => expect(slotInstances[1]?.start).toHaveBeenCalledTimes(2));
      expect(print.status).toHaveBeenCalledWith("", "agent reactivated: paused");
      expect(print.check).toHaveBeenCalledWith(true, "paused: connected", "agent: paused");
      await rt.stop();
    },
    RUNTIME_TEST_TIMEOUT_MS,
  );

  it("handles connection events, update hooks, and graceful stop", async () => {
    const { print } = await import("../core/output.js");
    const client = await import("@first-tree/client");
    sweepMock.mockResolvedValueOnce({ scanned: 3, deleted: 2, failed: 1 });
    slotInstances.length = 0;

    const update = {
      updateConfig: { policy: "prompt" },
      prompt: vi.fn(),
      executeUpdate: vi.fn(),
    } as unknown as NonNullable<
      ConstructorParameters<typeof import("../core/client-runtime.js").ClientRuntime>[2]
    >["update"];
    const { ClientRuntime } = await import("../core/client-runtime.js");
    const rt = new ClientRuntime("https://first-tree.test", "client-test", { currentVersion: "0.0.1", update });
    rt.addAgent("alpha", {
      agentId: "agent-alpha",
      runtime: "claude-code",
      session: { idle_timeout: 300, max_sessions: 4, working_grace_seconds: 3600 },
      concurrency: 1,
    } as unknown as Parameters<typeof rt.addAgent>[1]);

    await rt.start();
    expect(client.UpdateManager.attach).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ currentVersion: "0.0.1", updateConfig: { policy: "prompt" } }),
    );
    expect(print.status).toHaveBeenCalledWith(
      "[git-mirror]",
      "swept orphan session branches — scanned=3 deleted=2 failed=1",
    );

    connectionMock.isPaused.mockReturnValue(true);
    connectionMock.getPausedReason.mockReturnValue("auth_refresh_failed");
    expect(rt.isPaused()).toBe(true);
    expect(rt.pausedReason()).toBe("auth_refresh_failed");
    rt.emitConnectionResilienceEvent("resilience.update.failed", {
      targetVersion: "0.0.2",
      retryable: true,
      reasonCode: "INSTALL_FAILED",
    });
    expect(connectionMock.emit).toHaveBeenCalledWith("resilience.update.failed", {
      targetVersion: "0.0.2",
      retryable: true,
      reasonCode: "INSTALL_FAILED",
    });

    await rt.stop();
    expect(disposeMock).toHaveBeenCalled();
    expect(slotInstances[0]?.stop).toHaveBeenCalled();
    expect(connectionMock.disconnect).toHaveBeenCalled();
    expect(killAllMock).toHaveBeenCalledWith("client-runtime-stop");
  });

  it("auto-adds server-pinned agents and skips duplicates", async () => {
    const { ClientRuntime } = await import("../core/client-runtime.js");
    const rt = new ClientRuntime("https://first-tree.test", "client-test");
    const agentsDir = join(home, "config", "agents");
    mkdirSync(agentsDir, { recursive: true });
    rt.watchAgentsDir(agentsDir);

    const pinned = connectionListeners.get("agent:pinned");
    if (!pinned) throw new Error("agent:pinned listener missing");
    pinned({
      agentId: "019e70b3-0000-7000-8000-000000000001",
      name: "kael",
      runtimeProvider: "claude-code",
    });

    const text = readFileSync(join(agentsDir, "kael", "agent.yaml"), "utf8");
    expect(text).toContain("019e70b3-0000-7000-8000-000000000001");
    expect(text).toContain("claude-code");
    expect(slotInstances.map((slot) => slot.name)).toEqual(["kael"]);
    expect(slotInstances[0]?.start).toHaveBeenCalled();

    pinned({
      agentId: "019e70b3-0000-7000-8000-000000000001",
      name: "kael",
      runtimeProvider: "claude-code",
    });
    expect(slotInstances).toHaveLength(1);

    pinned({
      agentId: "019e70b3-0000-7000-8000-000000000002",
      name: "kael",
      runtimeProvider: "codex",
    });
    expect(readFileSync(join(agentsDir, "agent-019e70b300007000", "agent.yaml"), "utf8")).toContain("codex");
    expect(slotInstances.map((slot) => slot.name)).toEqual(["kael", "agent-019e70b300007000"]);
    await rt.stop();
  });

  it("reports pinned agents when no agent directory is set and ignores duplicate watched agents", async () => {
    const { print } = await import("../core/output.js");
    const { ClientRuntime } = await import("../core/client-runtime.js");
    const rt = new ClientRuntime("https://first-tree.test", "client-test");

    const pinned = connectionListeners.get("agent:pinned");
    if (!pinned) throw new Error("agent:pinned listener missing");
    pinned({
      agentId: "agent-missing-dir",
      name: "missing",
      runtimeProvider: "claude-code",
    });
    expect(print.status).toHaveBeenCalledWith(
      "⚠️",
      "agent pinned (agent-missing-dir) but no agents dir set — cannot auto-register.",
    );

    const agentsDir = join(home, "config", "agents");
    mkdirSync(join(agentsDir, "newcomer"), { recursive: true });
    writeFileSync(join(agentsDir, "newcomer", "agent.yaml"), "agentId: agent-new\nruntime: claude-code\n");
    rt.watchAgentsDir(agentsDir);
    pinned({
      agentId: "agent-new",
      name: "newcomer",
      runtimeProvider: "claude-code",
    });
    expect(slotInstances.map((slot) => slot.name)).toContain("newcomer");
    pinned({
      agentId: "agent-new",
      name: "newcomer",
      runtimeProvider: "claude-code",
    });
    expect(slotInstances.filter((slot) => slot.name === "newcomer")).toHaveLength(1);
    await rt.stop();
  });

  it("registers paused-mode recovery and reports auth lifecycle events", async () => {
    const { print } = await import("../core/output.js");
    const { ClientRuntime } = await import("../core/client-runtime.js");
    mkdirSync(join(home, "config"), { recursive: true });
    writeFileSync(join(home, "config", "credentials.json"), JSON.stringify({ refreshToken: "old" }));
    const rt = new ClientRuntime("https://first-tree.test", "client-test");
    connectionMock.isPaused.mockReturnValue(true);

    const paused = connectionListeners.get("auth:paused");
    if (!paused) throw new Error("auth:paused listener missing");
    paused("auth_refresh_failed", new Error("refresh rejected"));
    expect(print.status).toHaveBeenCalledWith("✗", "auth rejected — pausing agents until fresh credentials arrive.");
    expect(rt.isPaused()).toBe(true);

    const resumed = connectionListeners.get("auth:resumed");
    if (!resumed) throw new Error("auth:resumed listener missing");
    resumed("auth_refresh_failed");
    expect(print.status).toHaveBeenCalledWith(
      "✓",
      "credentials refreshed — resuming agents (was paused: auth_refresh_failed)",
    );

    const expired = connectionListeners.get("auth:expired");
    if (!expired) throw new Error("auth:expired listener missing");
    expired();
    expect(print.status).toHaveBeenCalledWith("⚠️", "access token expired — reconnecting after refresh...");

    const error = connectionListeners.get("error");
    if (!error) throw new Error("error listener missing");
    error(new Error("socket reset"));
    expect(print.status).toHaveBeenCalledWith("⚠️", "client connection error: socket reset");
    await rt.stop();
  });

  it(
    "skips an agent whose runtime has no handler on this build, without crashing startup",
    async () => {
      const { print } = await import("../core/output.js");
      const { ClientRuntime } = await import("../core/client-runtime.js");
      const rt = new ClientRuntime("https://first-tree.test", "client-test");

      // A valid enum provider this client build ships no handler for yet
      // (e.g. claude-code-tui before the TUI handler lands). Added FIRST so the
      // test also proves it does not abort registration of the agent after it.
      rt.addAgent("tui-agent", {
        agentId: "agent-tui",
        runtime: "claude-code-tui",
        session: { idle_timeout: 300, max_sessions: 4, working_grace_seconds: 3600 },
        concurrency: 1,
      } as unknown as Parameters<typeof rt.addAgent>[1]);
      rt.addAgent("alpha", {
        agentId: "agent-alpha",
        runtime: "claude-code",
        session: { idle_timeout: 300, max_sessions: 4, working_grace_seconds: 3600 },
        concurrency: 1,
      } as unknown as Parameters<typeof rt.addAgent>[1]);

      // Must not throw despite the unsupported agent in the load set.
      await rt.start();

      // Only the supported agent built a slot; the unsupported one was skipped.
      expect(slotInstances).toHaveLength(1);
      expect(slotInstances[0]?.name).toBe("alpha");
      // Operator got a clear warning naming the agent and its runtime.
      expect(print.status).toHaveBeenCalledWith(
        "⚠️",
        expect.stringContaining('agent "tui-agent" uses runtime "claude-code-tui"'),
      );

      await rt.stop();
    },
    RUNTIME_TEST_TIMEOUT_MS,
  );
});
