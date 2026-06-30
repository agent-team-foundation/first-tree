import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClientConnection, SessionReconcileResult } from "../client-connection.js";
import type { AgentSlotConfig } from "../runtime/agent-slot.js";
import type { HandlerConfig } from "../runtime/handler.js";
import { type FirstTreeHubSDK, type RegisterResult, SdkError } from "../sdk.js";

type FakeLogger = {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  child: ReturnType<typeof vi.fn<(bindings: Record<string, unknown>) => FakeLogger>>;
};

type FakeSessionState = {
  activeCount: number;
  lastActivityMs: number;
  sessionStates: Array<{ chatId: string; state: "active" | "suspended" | "evicted" }>;
  evictedChatIds: string[];
  runtimeStates: Array<{ chatId: string; runtimeState: "idle" | "working" | "blocked" | "error" }>;
  aggregateRuntimeState: "idle" | "working" | "blocked" | "error" | null;
  heldChatIds: string[];
  dispatch: ReturnType<typeof vi.fn<(entry: unknown) => Promise<void>>>;
  handleCommand: ReturnType<
    typeof vi.fn<(chatId: string, type: "session:suspend" | "session:terminate") => Promise<void>>
  >;
  applyStaleChatIds: ReturnType<typeof vi.fn<(chatIds: string[]) => void>>;
  shutdown: ReturnType<typeof vi.fn<() => Promise<void>>>;
};

type MockState = {
  logger: FakeLogger;
  syncResult: { path: string; repoUrl: string; branch: string } | null;
  syncCalls: Array<{ sdk: unknown; messages: string[] }>;
  sessions: FakeSessionState[];
  sessionConfigs: unknown[];
};

class FakeClientConnection extends EventEmitter {
  bindAgent = vi.fn(async () => ({ sdk: this.sdk }));
  unbindAgent = vi.fn(async () => {});
  sendInboxAck = vi.fn();
  reportSessionState = vi.fn();
  reportRuntimeState = vi.fn();
  reportSessionEvent = vi.fn();
  reportSessionRuntime = vi.fn();
  sendSessionReconcile = vi.fn();

  constructor(private readonly sdk: unknown) {
    super();
  }
}

function makeLogger(): FakeLogger {
  const logger: FakeLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  };
  logger.child.mockReturnValue(logger);
  return logger;
}

function makeAgent(overrides: Partial<RegisterResult> = {}): RegisterResult {
  return {
    agentId: "agent-1",
    inboxId: "inbox-1",
    status: "online",
    displayName: "Agent One",
    type: "agent",
    visibility: "organization",
    delegateMention: null,
    metadata: {},
    ...overrides,
  };
}

function makeSdk(options?: {
  agent?: RegisterResult;
  configError?: unknown;
  /** Throw `error` on the first `times` config fetches, then succeed — models a transient blip. */
  configErrorsThenSucceed?: { error: unknown; times: number };
  activeRuntimeChatIds?: string[];
  activeRuntimeChatIdsError?: unknown;
}): FirstTreeHubSDK {
  const agent = options?.agent ?? makeAgent();
  let configCalls = 0;
  const sdk = {
    register: vi.fn(async () => agent),
    fetchAgentConfig: vi.fn(async () => {
      configCalls++;
      const blip = options?.configErrorsThenSucceed;
      if (blip && configCalls <= blip.times) throw blip.error;
      if (options?.configError) throw options.configError;
      return {
        agentId: agent.agentId,
        version: 7,
        payload: {
          kind: "claude-code",
          prompt: { append: "" },
          model: "claude-sonnet",
          mcpServers: [],
          env: [],
          gitRepos: [],
          resourceSkills: [],
          reasoningEffort: "",
        },
        updatedAt: "2026-01-01T00:00:00.000Z",
        updatedBy: "user-1",
      };
    }),
    listActiveRuntimeChatIds: vi.fn(async () => {
      if (options?.activeRuntimeChatIdsError) throw options.activeRuntimeChatIdsError;
      return { chatIds: options?.activeRuntimeChatIds ?? ["chat-1", "chat-2", "chat-evicted"] };
    }),
  };
  // AgentSlot only uses this SDK subset; the concrete SDK type has many HTTP methods irrelevant here.
  return sdk as unknown as FirstTreeHubSDK;
}

function makeFrame(overrides: Record<string, unknown> = {}) {
  return {
    entryId: 42,
    inboxId: "inbox-1",
    chatId: "chat-1",
    message: {
      id: "msg-1",
      chatId: "chat-1",
      senderId: "user-1",
      format: "text",
      content: "hello",
      metadata: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    ...overrides,
  };
}

function installMocks(options: { syncResult?: MockState["syncResult"]; syncDelayMs?: number } = {}): MockState {
  vi.resetModules();
  const state: MockState = {
    logger: makeLogger(),
    syncResult:
      options.syncResult === undefined
        ? { path: "/tmp/tree", repoUrl: "git@example/tree.git", branch: "main" }
        : options.syncResult,
    syncCalls: [],
    sessions: [],
    sessionConfigs: [],
  };

  vi.doMock("@first-tree/shared/config", () => ({
    defaultDataDir: () => "/tmp/first-tree-test-data",
  }));
  vi.doMock("../observability/logger.js", () => ({
    createLogger: () => state.logger,
  }));
  vi.doMock("../runtime/bootstrap.js", () => ({
    resolveAgentContextTreeBinding: vi.fn(async (sdk: unknown, _workspaceRoot: string, log: (msg: string) => void) => {
      const messages: string[] = [];
      log("sync log");
      messages.push("sync log");
      state.syncCalls.push({ sdk, messages });
      if (options.syncDelayMs && options.syncDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, options.syncDelayMs));
      }
      return state.syncResult;
    }),
  }));
  vi.doMock("../runtime/session-manager.js", () => ({
    SessionManager: class {
      state: FakeSessionState;

      constructor(readonly config: unknown) {
        state.sessionConfigs.push(config);
        this.state = {
          activeCount: 2,
          lastActivityMs: 123,
          sessionStates: [{ chatId: "chat-1", state: "active" }],
          evictedChatIds: ["chat-evicted"],
          runtimeStates: [{ chatId: "chat-1", runtimeState: "working" }],
          aggregateRuntimeState: "working",
          heldChatIds: ["chat-1", "chat-2"],
          dispatch: vi.fn(async () => {}),
          handleCommand: vi.fn(async () => {}),
          applyStaleChatIds: vi.fn(),
          shutdown: vi.fn(async () => {}),
        };
        state.sessions.push(this.state);
      }

      getQuietGateSnapshot(): { activeCount: number; lastActivityMs: number } {
        return { activeCount: this.state.activeCount, lastActivityMs: this.state.lastActivityMs };
      }

      getSessionStates(activeChatIds?: ReadonlySet<string> | null): FakeSessionState["sessionStates"] {
        if (!activeChatIds) return this.state.sessionStates;
        return this.state.sessionStates.filter(({ chatId }) => activeChatIds.has(chatId));
      }

      getEvictedChatIds(activeChatIds?: ReadonlySet<string> | null): string[] {
        if (!activeChatIds) return this.state.evictedChatIds;
        return this.state.evictedChatIds.filter((chatId) => activeChatIds.has(chatId));
      }

      getSessionRuntimeStates(activeChatIds?: ReadonlySet<string> | null): FakeSessionState["runtimeStates"] {
        if (!activeChatIds) return this.state.runtimeStates;
        return this.state.runtimeStates.filter(({ chatId }) => activeChatIds.has(chatId));
      }

      getAggregateRuntimeState(): FakeSessionState["aggregateRuntimeState"] {
        return this.state.aggregateRuntimeState;
      }

      dispatch(entry: unknown): Promise<void> {
        return this.state.dispatch(entry);
      }

      handleCommand(chatId: string, type: "session:suspend" | "session:terminate"): Promise<void> {
        return this.state.handleCommand(chatId, type);
      }

      applyStaleChatIds(chatIds: string[]): void {
        this.state.applyStaleChatIds(chatIds);
      }

      getHeldChatIds(activeChatIds?: ReadonlySet<string> | null): string[] {
        if (!activeChatIds) return this.state.heldChatIds;
        return this.state.heldChatIds.filter((chatId) => activeChatIds.has(chatId));
      }

      shutdown(): Promise<void> {
        return this.state.shutdown();
      }
    },
  }));

  return state;
}

async function makeSlot(options?: {
  agent?: RegisterResult;
  configError?: unknown;
  configErrorsThenSucceed?: { error: unknown; times: number };
  activeRuntimeChatIds?: string[];
  activeRuntimeChatIdsError?: unknown;
  runtimeType?: string;
  syncResult?: MockState["syncResult"];
  syncDelayMs?: number;
  omitReconcileInterval?: boolean;
}): Promise<{
  slot: import("../runtime/agent-slot.js").AgentSlot;
  connection: FakeClientConnection;
  sdk: FirstTreeHubSDK;
  state: MockState;
}> {
  const state = installMocks({ syncResult: options?.syncResult, syncDelayMs: options?.syncDelayMs });
  const sdk = makeSdk({
    agent: options?.agent,
    configError: options?.configError,
    configErrorsThenSucceed: options?.configErrorsThenSucceed,
    activeRuntimeChatIds: options?.activeRuntimeChatIds,
    activeRuntimeChatIdsError: options?.activeRuntimeChatIdsError,
  });
  const connection = new FakeClientConnection(sdk);
  const { AgentSlot } = await import("../runtime/agent-slot.js");
  const handlerFactory = vi.fn((config: HandlerConfig) => ({
    start: vi.fn(async () => "session-1"),
    resume: vi.fn(async () => "session-1"),
    inject: vi.fn(),
    suspend: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
    config,
  }));
  const config: AgentSlotConfig = {
    name: "agent-one",
    agentId: "agent-1",
    serverUrl: "https://first-tree.example",
    type: "claude-code",
    runtimeType: options?.runtimeType,
    runtimeVersion: "1.2.3",
    handlerFactory,
    session: {
      idle_timeout: 300,
      max_sessions: 3,
      working_grace_seconds: 60,
      // AgentSlot has a defensive default for older configs; the runtime schema normally supplies a number.
      reconcile_interval_seconds: (options?.omitReconcileInterval ? undefined : 1) as unknown as number,
    },
    concurrency: 2,
    // AgentSlot only calls the public connection methods mocked above.
    clientConnection: connection as unknown as ClientConnection,
  };
  return { slot: new AgentSlot(config), connection, sdk, state };
}

describe("AgentSlot", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.doUnmock("@first-tree/shared/config");
    vi.doUnmock("../observability/logger.js");
    vi.doUnmock("../runtime/bootstrap.js");
    vi.doUnmock("../runtime/session-manager.js");
    vi.resetModules();
  });

  it("exposes identity and stays idle before start", async () => {
    const { slot, connection } = await makeSlot();

    expect(slot.name).toBe("agent-one");
    expect(slot.agentId).toBe("agent-1");
    expect(slot.getQuietGateSnapshot()).toEqual({ activeCount: 0, lastActivityMs: 0 });

    const dispatch = Reflect.get(slot, "dispatchPushedFrame");
    const sync = Reflect.get(slot, "fullStateSync");
    const reconcile = Reflect.get(slot, "reconcileNow");
    if (typeof dispatch !== "function" || typeof sync !== "function" || typeof reconcile !== "function") {
      throw new Error("private methods missing");
    }

    await dispatch.call(slot, makeFrame());
    sync.call(slot);
    reconcile.call(slot);

    expect(connection.sendSessionReconcile).not.toHaveBeenCalled();
  });

  it("returns early for human agents and leaves message processing disabled", async () => {
    const { slot, connection, state } = await makeSlot({ agent: makeAgent({ type: "human" }) });

    await expect(slot.start()).resolves.toMatchObject({ type: "human" });

    expect(connection.bindAgent).toHaveBeenCalledWith("agent-1", "claude-code", "1.2.3");
    expect(state.sessions).toHaveLength(0);
    expect(state.logger.info).toHaveBeenCalledWith("server reports type=human — message processing disabled");
  });

  it("aborts the bind immediately on a permanent (4xx) config rejection — no retry", async () => {
    const { slot, connection, sdk, state } = await makeSlot({ configError: new SdkError(403, "forbidden") });

    await expect(slot.start()).rejects.toThrow(/rejected agent config \(config_unauthorized\)/);

    // A deterministic 4xx must not be retried — exactly one fetch, then abort.
    expect(vi.mocked(sdk.fetchAgentConfig)).toHaveBeenCalledTimes(1);
    expect(connection.unbindAgent).toHaveBeenCalledWith("agent-1");
    expect(state.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ reasonCode: "config_unauthorized" }),
      "agent config fetch rejected — bind aborted",
    );
  });

  it("cleans pre-bind listeners after a failed bind so the same slot can retry", async () => {
    const { slot, connection } = await makeSlot();
    connection.bindAgent.mockRejectedValueOnce(new Error("agent:bind rejected (agent_suspended)"));

    await expect(slot.start()).rejects.toThrow("agent_suspended");

    expect(connection.unbindAgent).not.toHaveBeenCalled();
    expect(connection.listenerCount("inbox:deliver")).toBe(0);
    expect(connection.listenerCount("agent:bound")).toBe(0);
    expect(connection.listenerCount("agent:unbound")).toBe(0);
    expect(connection.listenerCount("session:reconcile:result")).toBe(0);

    await expect(slot.start()).resolves.toMatchObject({ agentId: "agent-1" });

    expect(connection.bindAgent).toHaveBeenCalledTimes(2);
    expect(connection.listenerCount("inbox:deliver")).toBe(1);
    expect(connection.listenerCount("agent:bound")).toBe(1);
    expect(connection.listenerCount("agent:unbound")).toBe(1);
    expect(connection.listenerCount("session:reconcile:result")).toBe(1);
  });

  it("self-heals a transient config fetch failure: retries with backoff, then binds", async () => {
    vi.useFakeTimers();
    const { slot, connection, sdk, state } = await makeSlot({
      configErrorsThenSucceed: { error: new SdkError(503, "boom"), times: 1 },
    });

    const startPromise = slot.start();
    // Advance past the first backoff (~1s base + jitter) so the retry runs.
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(startPromise).resolves.toMatchObject({ agentId: "agent-1" });

    expect(vi.mocked(sdk.fetchAgentConfig)).toHaveBeenCalledTimes(2);
    expect(connection.unbindAgent).not.toHaveBeenCalled();
    // SessionManager built → the agent is genuinely online, not a dead slot.
    expect(state.sessions).toHaveLength(1);
  });

  it("aborts the bind after exhausting retries on a sustained transient failure", async () => {
    vi.useFakeTimers();
    const { slot, connection, sdk } = await makeSlot({ configError: new SdkError(503, "down") });

    const outcome = slot.start().then(
      () => ({ ok: true }) as const,
      (err: unknown) => ({ ok: false, err }) as const,
    );
    // Drain every backoff sleep; each is scheduled after the prior fetch rejects.
    await vi.advanceTimersByTimeAsync(200_000);
    await vi.advanceTimersByTimeAsync(200_000);
    const settled = await outcome;

    expect(settled.ok).toBe(false);
    if (!settled.ok) {
      expect((settled.err as Error).message).toMatch(/after \d+ attempts/);
    }
    // Bounded retry: far more than the SDK's ~1.5s transport budget, then give up.
    expect(vi.mocked(sdk.fetchAgentConfig)).toHaveBeenCalledTimes(8);
    expect(connection.unbindAgent).toHaveBeenCalledWith("agent-1");
  });

  it("does not build a session if stop() aborts while the config fetch is in flight", async () => {
    const { slot, sdk, state } = await makeSlot();
    // The server unbinds us (→ stop()) while the config fetch is in flight, and
    // the fetch then resolves successfully — the slot must NOT come online.
    vi.mocked(sdk.fetchAgentConfig).mockImplementationOnce(async () => {
      void slot.stop();
      return {
        agentId: "agent-1",
        version: 7,
        payload: {
          kind: "claude-code",
          prompt: { append: "" },
          model: "claude-sonnet",
          mcpServers: [],
          env: [],
          gitRepos: [],
          resourceSkills: [],
          reasoningEffort: "",
        },
        updatedAt: "2026-01-01T00:00:00.000Z",
        updatedBy: "user-1",
      };
    });

    await expect(slot.start()).rejects.toThrow(/aborted — slot stopping/);
    expect(state.sessions).toHaveLength(0);
  });

  it("starts processing, dispatches pushed frames, reconciles state, and stops cleanly", async () => {
    vi.useFakeTimers();
    const { slot, connection, sdk, state } = await makeSlot({ runtimeType: "codex" });

    await expect(slot.start()).resolves.toMatchObject({ agentId: "agent-1" });

    expect(connection.bindAgent).toHaveBeenCalledWith("agent-1", "codex", "1.2.3");
    expect(state.syncCalls).toEqual([{ sdk, messages: ["sync log"] }]);
    expect(state.sessions).toHaveLength(1);
    expect(slot.getQuietGateSnapshot()).toEqual({ activeCount: 2, lastActivityMs: 123 });

    const wrongFrame = makeFrame({ inboxId: "other-inbox" });
    connection.emit("inbox:deliver", "other-inbox", wrongFrame);
    connection.emit("inbox:deliver", "inbox-1", makeFrame());
    await Promise.resolve();
    await Promise.resolve();

    const session = state.sessions[0];
    if (!session) throw new Error("session missing");
    expect(session.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 42,
        inboxId: "inbox-1",
        messageId: "msg-1",
        chatId: "chat-1",
        status: "delivered",
        retryCount: 0,
        ackedAt: null,
      }),
    );
    expect(session.dispatch).toHaveBeenCalledTimes(1);

    connection.emit("agent:bound", { agentId: "other-agent" });
    connection.emit("agent:bound", { agentId: "agent-1" });
    await vi.advanceTimersByTimeAsync(5000);

    expect(connection.reportSessionState).toHaveBeenCalledWith("agent-1", "chat-1", "active");
    expect(connection.reportSessionState).toHaveBeenCalledWith("agent-1", "chat-evicted", "suspended");
    expect(connection.reportSessionRuntime).toHaveBeenCalledWith("agent-1", "chat-1", "working");
    expect(connection.reportRuntimeState).toHaveBeenCalledWith("agent-1", "working");
    expect(connection.sendSessionReconcile).toHaveBeenCalledWith("agent-1", ["chat-1", "chat-2"]);

    const sessionConfig = state.sessionConfigs[0];
    if (typeof sessionConfig !== "object" || sessionConfig === null) throw new Error("session config missing");
    const ackEntry = Reflect.get(sessionConfig, "ackEntry");
    const onStateChange = Reflect.get(sessionConfig, "onStateChange");
    const onRuntimeStateChange = Reflect.get(sessionConfig, "onRuntimeStateChange");
    const onSessionEvent = Reflect.get(sessionConfig, "onSessionEvent");
    const onSessionRuntimeChange = Reflect.get(sessionConfig, "onSessionRuntimeChange");
    if (
      typeof ackEntry !== "function" ||
      typeof onStateChange !== "function" ||
      typeof onRuntimeStateChange !== "function" ||
      typeof onSessionEvent !== "function" ||
      typeof onSessionRuntimeChange !== "function"
    ) {
      throw new Error("session callbacks missing");
    }
    await ackEntry(123);
    onStateChange("chat-callback", "suspended");
    onRuntimeStateChange("blocked");
    onSessionEvent("chat-callback", { type: "error", message: "oops" });
    onSessionRuntimeChange("chat-callback", "error");

    expect(connection.sendInboxAck).toHaveBeenCalledWith(123, "agent-1");
    expect(connection.reportSessionState).toHaveBeenCalledWith("agent-1", "chat-callback", "suspended");
    expect(connection.reportRuntimeState).toHaveBeenCalledWith("agent-1", "blocked");
    expect(connection.reportSessionEvent).toHaveBeenCalledWith("agent-1", "chat-callback", {
      type: "error",
      message: "oops",
    });
    expect(connection.reportSessionRuntime).toHaveBeenCalledWith("agent-1", "chat-callback", "error");

    connection.emit("session:reconcile:result", {
      agentId: "other-agent",
      staleChatIds: ["x"],
    } satisfies SessionReconcileResult);
    connection.emit("session:reconcile:result", {
      agentId: "agent-1",
      staleChatIds: ["chat-old"],
    } satisfies SessionReconcileResult);
    expect(session.applyStaleChatIds).toHaveBeenCalledWith(["chat-old"]);

    connection.emit("session:command", { agentId: "other-agent", chatId: "chat-1", type: "session:suspend" });
    connection.emit("session:command", { agentId: "agent-1", chatId: "chat-1", type: "session:suspend" });
    await Promise.resolve();
    expect(session.handleCommand).toHaveBeenCalledWith("chat-1", "session:suspend");

    await slot.stop();

    expect(connection.unbindAgent).toHaveBeenCalledWith("agent-1");
    expect(session.shutdown).toHaveBeenCalled();
    expect(state.logger.info).toHaveBeenCalledWith("stopped");

    connection.emit("inbox:deliver", "inbox-1", makeFrame({ entryId: 99 }));
    expect(session.dispatch).toHaveBeenCalledTimes(1);
  });

  it("uses the active runtime chat set for full-state sync and optimistic-adds delivered chats", async () => {
    const { slot, connection, sdk, state } = await makeSlot({ activeRuntimeChatIds: ["chat-1"] });

    await slot.start();
    const session = state.sessions[0];
    if (!session) throw new Error("session missing");

    expect(vi.mocked(sdk.listActiveRuntimeChatIds)).toHaveBeenCalledTimes(1);
    expect(connection.reportSessionState).toHaveBeenCalledWith("agent-1", "chat-1", "active");
    expect(connection.reportSessionState).not.toHaveBeenCalledWith("agent-1", "chat-evicted", "suspended");

    const reconcile = Reflect.get(slot, "reconcileNow");
    if (typeof reconcile !== "function") throw new Error("private method missing");

    connection.sendSessionReconcile.mockClear();
    session.heldChatIds = ["chat-1", "chat-2"];
    reconcile.call(slot);
    expect(connection.sendSessionReconcile).toHaveBeenCalledWith("agent-1", ["chat-1"]);

    connection.emit("inbox:deliver", "inbox-1", makeFrame({ chatId: "chat-2" }));
    await Promise.resolve();
    await Promise.resolve();

    connection.sendSessionReconcile.mockClear();
    reconcile.call(slot);
    expect(connection.sendSessionReconcile).toHaveBeenCalledWith("agent-1", ["chat-1", "chat-2"]);

    await slot.stop();
  });

  it("chunks reconcile frames so a large held set never exceeds the wire schema limit", async () => {
    const chatIds = Array.from({ length: 501 }, (_, i) => `chat-${i}`);
    const { slot, connection, state } = await makeSlot({ activeRuntimeChatIds: chatIds });

    await slot.start();
    const session = state.sessions[0];
    if (!session) throw new Error("session missing");
    session.heldChatIds = chatIds;

    const reconcile = Reflect.get(slot, "reconcileNow");
    if (typeof reconcile !== "function") throw new Error("private method missing");
    connection.sendSessionReconcile.mockClear();
    reconcile.call(slot);

    expect(connection.sendSessionReconcile).toHaveBeenCalledTimes(2);
    expect(connection.sendSessionReconcile).toHaveBeenNthCalledWith(1, "agent-1", chatIds.slice(0, 500));
    expect(connection.sendSessionReconcile).toHaveBeenNthCalledWith(2, "agent-1", chatIds.slice(500));

    await slot.stop();
  });

  it("starts the bind-time reconcile grace window after startup full state sync", async () => {
    vi.useFakeTimers();
    const { slot, connection, sdk } = await makeSlot({ syncDelayMs: 4_900, omitReconcileInterval: true });
    connection.bindAgent.mockImplementationOnce(async () => {
      connection.emit("agent:bound", { agentId: "agent-1" });
      return { sdk };
    });

    const startPromise = slot.start();
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(4_900);
    await expect(startPromise).resolves.toMatchObject({ agentId: "agent-1" });

    expect(connection.reportSessionState).toHaveBeenCalledWith("agent-1", "chat-evicted", "suspended");
    expect(connection.sendSessionReconcile).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100);
    expect(connection.sendSessionReconcile).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(4_900);
    expect(connection.sendSessionReconcile).toHaveBeenCalledWith("agent-1", ["chat-1", "chat-2"]);

    await slot.stop();
  });

  it("stops only the matching slot when the server force-unbounds an agent", async () => {
    const { slot, connection, state } = await makeSlot();
    await slot.start();
    const session = state.sessions[0];
    if (!session) throw new Error("session missing");

    connection.emit("agent:unbound", "other-agent", "agent_suspended");
    await Promise.resolve();
    expect(connection.unbindAgent).not.toHaveBeenCalled();
    expect(session.shutdown).not.toHaveBeenCalled();

    connection.emit("agent:unbound", "agent-1", "agent_suspended");
    await Promise.resolve();
    await Promise.resolve();

    expect(connection.unbindAgent).toHaveBeenCalledWith("agent-1");
    expect(session.shutdown).toHaveBeenCalled();
    connection.emit("inbox:deliver", "inbox-1", makeFrame({ entryId: 99 }));
    expect(session.dispatch).not.toHaveBeenCalled();
  });

  it("logs optional context-tree, push-dispatch, and session-command failures without crashing", async () => {
    const { slot, connection, state } = await makeSlot({ syncResult: null, omitReconcileInterval: true });
    await slot.start();
    const session = state.sessions[0];
    if (!session) throw new Error("session missing");
    session.dispatch.mockRejectedValueOnce(new Error("dispatch failed"));
    session.handleCommand.mockRejectedValueOnce(new Error("command failed"));
    session.aggregateRuntimeState = null;
    session.heldChatIds = [];

    connection.emit("inbox:deliver", "inbox-1", makeFrame({ entryId: 55 }));
    connection.emit("session:command", { agentId: "agent-1", chatId: "chat-2", type: "session:terminate" });
    await Promise.resolve();
    await Promise.resolve();

    const sync = Reflect.get(slot, "fullStateSync");
    const reconcile = Reflect.get(slot, "reconcileNow");
    if (typeof sync !== "function" || typeof reconcile !== "function") throw new Error("private methods missing");
    sync.call(slot);
    reconcile.call(slot);

    expect(state.logger.info).toHaveBeenCalledWith(
      "context tree not configured or binding unresolved — agent will start without organizational context",
    );
    expect(state.logger.warn).toHaveBeenCalledWith(
      { err: new Error("dispatch failed"), entryId: 55 },
      "inbox:deliver dispatch error",
    );
    expect(state.logger.error).toHaveBeenCalledWith(
      { err: new Error("command failed"), chatId: "chat-2", type: "session:terminate" },
      "session command error",
    );
    expect(connection.reportRuntimeState).toHaveBeenCalledWith("agent-1", "idle");
    expect(connection.sendSessionReconcile).not.toHaveBeenCalled();
  });
});
