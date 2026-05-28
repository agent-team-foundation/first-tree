import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "../runtime/config.js";
import type { UpdateHooks, UpdateManagerOptions } from "../runtime/update-manager.js";

type SlotBehavior = "resolve" | "reject";

type FakeSlot = {
  name: string;
  agentId: string;
  start: ReturnType<typeof vi.fn<() => Promise<void>>>;
  stop: ReturnType<typeof vi.fn<() => Promise<void>>>;
  getQuietGateSnapshot: ReturnType<typeof vi.fn<() => { activeCount: number; lastActivityMs: number }>>;
};

type FakeConnection = EventEmitter & {
  clientId: string;
  config: {
    serverUrl: string;
    clientId?: string;
    sdkVersion?: string;
    userAgent?: string;
    getAccessToken: () => Promise<string>;
    getLastUpdateAttempt?: () => unknown;
  };
  connect: ReturnType<typeof vi.fn<() => Promise<void>>>;
  disconnect: ReturnType<typeof vi.fn<() => Promise<void>>>;
};

type MockRuntimeState = {
  slots: FakeSlot[];
  connections: FakeConnection[];
  gitManager: {
    gcOrphanSessionBranches: ReturnType<typeof vi.fn<() => Promise<{ scanned: number }>>>;
  };
  logger: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    child: ReturnType<typeof vi.fn<(bindings: Record<string, unknown>) => MockRuntimeState["logger"]>>;
  };
  updateDispose: ReturnType<typeof vi.fn>;
  updateAttach: ReturnType<typeof vi.fn>;
  updateOptions: UpdateManagerOptions | null;
};

function makeRuntimeConfig(): RuntimeConfig {
  return {
    server: "http://hub.test",
    agents: {
      alpha: {
        agentId: "agent-alpha",
        type: "claude-code",
        session: {
          idle_timeout: 300,
          max_sessions: 10,
          working_grace_seconds: 3600,
          reconcile_interval_seconds: 300,
        },
        concurrency: 2,
      },
      beta: {
        agentId: "agent-beta",
        type: "codex",
        session: {
          idle_timeout: 300,
          max_sessions: 10,
          working_grace_seconds: 3600,
          reconcile_interval_seconds: 300,
        },
        concurrency: 3,
      },
    },
  };
}

function makeUpdateHooks(): UpdateHooks {
  return {
    updateConfig: {
      policy: "auto",
      restart_quiet_seconds: 30,
      restart_check_interval_seconds: 10,
      prompt_timeout_seconds: 60,
    },
    prompt: vi.fn(async () => true),
    executeUpdate: vi.fn(async () => ({ installed: true })),
  };
}

function installRuntimeMocks(options?: {
  slotBehavior?: Record<string, SlotBehavior>;
  gcResult?: { scanned: number };
  gcError?: Error;
  snapshots?: Record<string, { activeCount: number; lastActivityMs: number }>;
  stopPromise?: Promise<void>;
}): MockRuntimeState {
  vi.resetModules();

  const state: MockRuntimeState = {
    slots: [],
    connections: [],
    gitManager: {
      gcOrphanSessionBranches: vi.fn(async () => {
        if (options?.gcError) throw options.gcError;
        return options?.gcResult ?? { scanned: 0 };
      }),
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(),
    },
    updateDispose: vi.fn(),
    updateAttach: vi.fn(),
    updateOptions: null,
  };
  state.logger.child.mockReturnValue(state.logger);

  vi.doMock("@first-tree/shared/config", () => ({
    defaultDataDir: () => "/tmp/first-tree-data",
  }));
  vi.doMock("../observability/logger.js", () => ({
    createLogger: () => state.logger,
  }));
  vi.doMock("../client-connection.js", () => ({
    ClientConnection: class extends EventEmitter implements FakeConnection {
      clientId: string;
      config: FakeConnection["config"];
      connect = vi.fn(async () => {});
      disconnect = vi.fn(async () => {});

      constructor(config: FakeConnection["config"]) {
        super();
        this.config = config;
        this.clientId = config.clientId ?? "generated-client";
        state.connections.push(this);
      }
    },
  }));
  vi.doMock("../runtime/git-mirror-manager.js", () => ({
    createGitMirrorManager: vi.fn(() => state.gitManager),
  }));
  vi.doMock("../runtime/handler.js", () => ({
    getHandlerFactory: vi.fn((type: string) => ({ type })),
  }));
  vi.doMock("../runtime/agent-slot.js", () => ({
    AgentSlot: class {
      name: string;
      agentId: string;
      start: FakeSlot["start"];
      stop: FakeSlot["stop"];
      getQuietGateSnapshot: FakeSlot["getQuietGateSnapshot"];

      constructor(config: { name: string; agentId: string }) {
        this.name = config.name;
        this.agentId = config.agentId;
        this.start = vi.fn(async () => {
          if (options?.slotBehavior?.[config.name] === "reject") {
            throw new Error(`${config.name} failed`);
          }
        });
        this.stop = vi.fn(() => options?.stopPromise ?? Promise.resolve());
        this.getQuietGateSnapshot = vi.fn(
          () => options?.snapshots?.[config.name] ?? { activeCount: 0, lastActivityMs: 0 },
        );
        state.slots.push(this);
      }
    },
  }));
  vi.doMock("../runtime/update-manager.js", () => ({
    UpdateManager: {
      attach: vi.fn((connection: unknown, opts: UpdateManagerOptions) => {
        state.updateAttach(connection, opts);
        state.updateOptions = opts;
        return { dispose: state.updateDispose };
      }),
    },
  }));

  return state;
}

function captureProcessSignals(): {
  getSigint: () => (() => Promise<void>) | null;
  getSigterm: () => (() => Promise<void>) | null;
} {
  let sigint: (() => Promise<void>) | null = null;
  let sigterm: (() => Promise<void>) | null = null;
  vi.spyOn(process, "on").mockImplementation(((event: string | symbol, listener: (...args: never[]) => unknown) => {
    if (event === "SIGINT") {
      sigint = async () => {
        await listener();
      };
    }
    if (event === "SIGTERM") {
      sigterm = async () => {
        await listener();
      };
    }
    return process;
  }) as never);
  return { getSigint: () => sigint, getSigterm: () => sigterm };
}

describe("AgentRuntime", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.doUnmock("@first-tree/shared/config");
    vi.doUnmock("../observability/logger.js");
    vi.doUnmock("../client-connection.js");
    vi.doUnmock("../runtime/git-mirror-manager.js");
    vi.doUnmock("../runtime/handler.js");
    vi.doUnmock("../runtime/agent-slot.js");
    vi.doUnmock("../runtime/update-manager.js");
    vi.resetModules();
  });

  it("wires constructor dependencies and logs connection errors", async () => {
    const state = installRuntimeMocks();
    const { AgentRuntime } = await import("../runtime/runtime.js");

    new AgentRuntime({
      config: makeRuntimeConfig(),
      clientId: "client-test",
      currentVersion: "1.2.3",
      userAgent: "first-tree-test",
      getAccessToken: async () => "token",
      getLastUpdateAttempt: () => null,
    });
    state.connections[0]?.emit("error", new Error("socket failed"));

    expect(state.connections[0]?.config).toMatchObject({
      serverUrl: "http://hub.test",
      clientId: "client-test",
      sdkVersion: "1.2.3",
      userAgent: "first-tree-test",
    });
    expect(state.slots.map((slot) => `${slot.name}:${slot.agentId}`)).toEqual(["alpha:agent-alpha", "beta:agent-beta"]);
    expect(state.logger.error).toHaveBeenCalledWith({ err: new Error("socket failed") }, "client connection error");
  });

  it("starts, attaches updates, reports partial slot failures, and shuts down on SIGINT", async () => {
    const state = installRuntimeMocks({
      gcResult: { scanned: 2 },
      slotBehavior: { beta: "reject" },
      snapshots: {
        alpha: { activeCount: 1, lastActivityMs: 10 },
        beta: { activeCount: 2, lastActivityMs: 30 },
      },
    });
    const signals = captureProcessSignals();
    const { AgentRuntime } = await import("../runtime/runtime.js");
    const runtime = new AgentRuntime({
      config: makeRuntimeConfig(),
      clientId: "client-test",
      currentVersion: "1.2.3",
      update: makeUpdateHooks(),
      getAccessToken: async () => "token",
      shutdownTimeout: 50,
    });

    const started = runtime.start();
    await vi.waitFor(() => expect(signals.getSigint()).not.toBeNull());

    expect(state.gitManager.gcOrphanSessionBranches).toHaveBeenCalledTimes(1);
    expect(state.logger.info).toHaveBeenCalledWith({ scanned: 2 }, "swept orphan session branches");
    expect(state.updateAttach).toHaveBeenCalledTimes(1);
    expect(state.updateOptions?.getQuietGateSnapshot()).toEqual({ activeCount: 3, lastActivityMs: 30 });
    state.updateOptions?.log("info", "update log line");
    expect(state.logger.info).toHaveBeenCalledWith("update log line");
    expect(state.connections[0]?.connect).toHaveBeenCalledTimes(1);
    expect(state.logger.error).toHaveBeenCalledWith(
      {
        err: new Error("beta failed"),
        agentName: "beta",
        agentId: "agent-beta",
        reason: "beta failed",
      },
      "failed to start agent",
    );
    expect(state.logger.warn).toHaveBeenCalledWith(
      {
        failedCount: 1,
        totalCount: 2,
        failures: [{ agentName: "beta", agentId: "agent-beta", reason: "beta failed" }],
      },
      "some agents failed to start — check that each agentId is still pinned to this client",
    );

    const firstShutdown = signals.getSigint()?.();
    const secondShutdown = signals.getSigint()?.();
    await firstShutdown;
    await secondShutdown;
    await expect(started).resolves.toBeUndefined();
    expect(state.updateDispose).toHaveBeenCalledTimes(1);
    expect(state.slots[0]?.stop).toHaveBeenCalledTimes(1);
    expect(state.slots[1]?.stop).toHaveBeenCalledTimes(1);
    expect(state.connections[0]?.disconnect).toHaveBeenCalledTimes(1);
  });

  it("logs GC failures and can shut down through SIGTERM without update hooks", async () => {
    const state = installRuntimeMocks({ gcError: new Error("gc failed") });
    const signals = captureProcessSignals();
    const { AgentRuntime } = await import("../runtime/runtime.js");
    const runtime = new AgentRuntime({
      config: makeRuntimeConfig(),
      getAccessToken: async () => "token",
      shutdownTimeout: 50,
    });

    const started = runtime.start();
    await vi.waitFor(() => expect(signals.getSigterm()).not.toBeNull());
    await signals.getSigterm()?.();

    await expect(started).resolves.toBeUndefined();
    expect(state.logger.warn).toHaveBeenCalledWith(
      { err: new Error("gc failed") },
      "gcOrphanSessionBranches threw — continuing startup",
    );
    expect(state.updateAttach).not.toHaveBeenCalled();
    expect(state.updateDispose).not.toHaveBeenCalled();
  });

  it("forces exit when shutdown exceeds the timeout", async () => {
    vi.useFakeTimers();
    let releaseStop: () => void = () => {};
    const stopPromise = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    installRuntimeMocks({ stopPromise });
    const signals = captureProcessSignals();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const { AgentRuntime } = await import("../runtime/runtime.js");
    const runtime = new AgentRuntime({
      config: makeRuntimeConfig(),
      getAccessToken: async () => "token",
      shutdownTimeout: 50,
    });

    const started = runtime.start();
    await vi.waitFor(() => expect(signals.getSigint()).not.toBeNull());
    const shutdown = signals.getSigint()?.();
    await vi.advanceTimersByTimeAsync(50);

    expect(exitSpy).toHaveBeenCalledWith(1);
    releaseStop();
    await shutdown;
    await expect(started).resolves.toBeUndefined();
  });

  it("logs unknown slots and string rejection reasons defensively", async () => {
    const state = installRuntimeMocks();
    const signals = captureProcessSignals();
    vi.spyOn(Promise, "allSettled").mockResolvedValueOnce([
      { status: "fulfilled", value: undefined },
      { status: "fulfilled", value: undefined },
      { status: "rejected", reason: "orphan failure" },
    ]);
    const { AgentRuntime } = await import("../runtime/runtime.js");
    const runtime = new AgentRuntime({
      config: makeRuntimeConfig(),
      getAccessToken: async () => "token",
      shutdownTimeout: 50,
    });

    const started = runtime.start();
    await vi.waitFor(() => expect(signals.getSigterm()).not.toBeNull());
    await signals.getSigterm()?.();
    await expect(started).resolves.toBeUndefined();

    expect(state.logger.error).toHaveBeenCalledWith(
      {
        err: "orphan failure",
        agentName: "<unknown>",
        agentId: "<unknown>",
        reason: "orphan failure",
      },
      "failed to start agent",
    );
  });

  it("throws when every agent slot fails to start", async () => {
    installRuntimeMocks({ slotBehavior: { alpha: "reject", beta: "reject" } });
    const { AgentRuntime } = await import("../runtime/runtime.js");
    const runtime = new AgentRuntime({
      config: makeRuntimeConfig(),
      getAccessToken: async () => "token",
    });

    await expect(runtime.start()).rejects.toThrow("All agents failed to start");
  });
});
