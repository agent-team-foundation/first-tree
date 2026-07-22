import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentRuntimeConfig,
  InboxEntryWithMessage,
  ProviderRetryEventPayload,
  RuntimeState,
  SessionEvent,
  SessionState,
} from "@first-tree/shared";
import { parseProviderRetryEventMessage } from "@first-tree/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentHandler, HandlerFactory, SessionContext, SessionMessage } from "../runtime/handler.js";
import type { DeliveryDecision, DeliveryRouteOwnership, DeliveryWork } from "../runtime/inbox-delivery-coordinator.js";
import type { SubprocessProbe } from "../runtime/process-tree-probe.js";
import { SessionManager } from "../runtime/session-manager.js";
import type { FirstTreeHubSDK } from "../sdk.js";
import { recordingLogger, silentLogger } from "./_logger-helpers.js";
import { mockEntry } from "./test-helpers.js";

type SessionRecord = {
  chatId: string;
  claudeSessionId: string;
  handler: AgentHandler;
  status: SessionState;
  activeSlotHeld: boolean;
  lastActivity: number;
  suspending: Promise<void> | null;
  retryAttempt: number;
  retryNextAt: number | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  lastRetryReason: string | null;
  lastRetryCategory: string | null;
  lastRetryScope: "session_start" | "session_resume" | null;
  lastRetryRawError: string | null;
  retryHeadMessage: SessionMessage | null;
  deferredMessages: SessionMessage[];
  routeTransitionPending: boolean;
  pendingRuntimeFailureNotice: ProviderRetryEventPayload | null;
  retryFromEvicted: { claudeSessionId: string; lastActivity: number } | null;
};

type SessionManagerInternals = {
  sessions: Map<string, SessionRecord>;
  evictedMappings: Map<string, { claudeSessionId: string; lastActivity: number }>;
  pendingQueue: Array<{ message: SessionMessage | null; chatId: string; deliveryKind: string }>;
  sessionRuntimeStates: Map<string, RuntimeState>;
  currentTrigger: Map<string, { messageId: string; senderId: string }>;
  inboxDelivery: {
    receive(entry: InboxEntryWithMessage): DeliveryDecision;
    markOwned(work: DeliveryWork): DeliveryRouteOwnership;
    hasEntry(work: DeliveryWork): boolean;
    markProcessingStarted(chatId: string, messages: SessionMessage | readonly SessionMessage[]): void;
    prepareOperatorSuspend(chatId: string): Promise<void>;
    hasRecoveryDebt(chatId: string): boolean;
    hasUnsettledWork(chatId: string): boolean;
  };
  _activeCount: number;
  acquireActiveSlot(
    chatId: string,
    message: SessionMessage | null,
    deliveryKind?: string,
    opts?: { queueOnFailure?: boolean },
  ): boolean;
  routeMessage(chatId: string, message: SessionMessage): Promise<void>;
  resumeSession(entry: SessionRecord, message: SessionMessage | null | undefined): Promise<void>;
  runRetry(chatId: string): Promise<void>;
  abortUnownedRoute(entry: SessionRecord, reason: string): void;
  ensureContextTreeBinding(): Promise<void>;
  markRouteOwned(
    chatId: string,
    message: SessionMessage,
    receipt: { kind: "owned"; mode: "queued" },
  ): DeliveryRouteOwnership;
  triggerImmediateRetry(chatId: string): void;
  drainPendingQueue(): void;
  evictIfNeeded(): void;
  notifySessionState(chatId: string, state: SessionState): void;
  projectSessionRuntime(chatId: string, opts?: { drainPendingOnIdle?: boolean }): void;
  recomputeRuntimeState(): void;
  buildSessionContext(chatId: string): SessionContext;
  confirmSessionEventOrThrow(chatId: string, event: SessionEvent): Promise<void>;
  resolveSelfFence(
    log: (msg: string) => void,
    chatId: string,
  ): Promise<{ agentHome: string; singleRepoLocalPath?: string }>;
  resolveChatOrgId(log: (msg: string) => void, chatId: string): Promise<string | null>;
  reaffirmRuntimeStates(): void;
  persistRegistry(): void;
};

type TestRuntimeState = RuntimeState;

const sessionConfig = {
  idle_timeout: 300,
  max_sessions: 10,
  working_grace_seconds: 3600,
  reconcile_interval_seconds: 300,
};

function mockSdk(): FirstTreeHubSDK {
  return {
    serverUrl: "https://first-tree.example.test",
    register: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue({ id: "msg-reply" }),
    sendToAgent: vi.fn().mockResolvedValue({ id: "msg-dm" }),
    listChatParticipants: vi.fn().mockResolvedValue([
      { agentId: "sender-1", role: "member", mode: "full", name: "alice", displayName: "Alice", type: "human" },
      { agentId: "agent-1", role: "member", mode: "full", name: "helper", displayName: "Helper", type: "agent" },
    ]),
  } as unknown as FirstTreeHubSDK;
}

function handler(overrides: Partial<AgentHandler> = {}): AgentHandler {
  return {
    start: vi.fn().mockResolvedValue("session-id"),
    resume: vi.fn().mockResolvedValue("session-id"),
    inject: vi.fn().mockReturnValue({ kind: "owned", mode: "queued" }),
    suspend: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function runtimeConfig(overrides: Partial<AgentRuntimeConfig> = {}): AgentRuntimeConfig {
  return {
    agentId: "agent-1",
    version: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
    updatedBy: "tester",
    payload: {
      kind: "claude-code",
      prompt: { append: "" },
      model: "opus",
      mcpServers: [],
      env: [],
      gitRepos: [],
      resourceSkills: [],
      reasoningEffort: "",
    },
    ...overrides,
  };
}

function makeCache(
  opts: {
    config?: AgentRuntimeConfig;
    refreshIfNewer?: (agentId: string, version: number) => Promise<AgentRuntimeConfig>;
  } = {},
) {
  const current = opts.config;
  return {
    get: vi.fn((agentId: string) => (agentId === "agent-1" ? current : undefined)),
    refreshIfNewer: vi.fn(
      opts.refreshIfNewer ??
        (async (agentId: string) => {
          if (current && current.agentId === agentId) return current;
          return runtimeConfig({ agentId });
        }),
    ),
    refresh: vi.fn(),
    updateSdk: vi.fn(),
    updateUrls: vi.fn(),
    allReferencedUrls: vi.fn(() => new Set<string>()),
    forget: vi.fn(),
  };
}

function makeManager(
  opts: {
    handlers?: AgentHandler[];
    handlerFactory?: HandlerFactory;
    ackEntry?: (entryId: number) => Promise<void>;
    recoverChat?: (chatId: string) => Promise<void>;
    registryPath?: string;
    concurrency?: number;
    maxSessions?: number;
    sdk?: FirstTreeHubSDK;
    agentConfigCache?: ReturnType<typeof makeCache>;
    log?: ReturnType<typeof silentLogger>;
    subprocessProbe?: SubprocessProbe;
    onStateChange?: (chatId: string, state: SessionState) => void;
    onRuntimeStateChange?: (state: TestRuntimeState) => void;
    onSessionRuntimeChange?: (chatId: string, state: TestRuntimeState) => void;
    onSessionEvent?: (chatId: string, event: SessionEvent) => void;
    confirmSessionEvent?: (chatId: string, event: SessionEvent) => Promise<void>;
    workspaceRoot?: string;
    runtimeSessionTokenFile?: string;
  } = {},
): SessionManager {
  const handlers = [...(opts.handlers ?? [handler()])];
  const handlerFactory =
    opts.handlerFactory ??
    (() => {
      const next = handlers.shift();
      if (!next) throw new Error("handler factory exhausted");
      return next;
    });

  return new SessionManager({
    session: { ...sessionConfig, max_sessions: opts.maxSessions ?? sessionConfig.max_sessions },
    concurrency: opts.concurrency ?? 5,
    subprocessProbe: opts.subprocessProbe,
    handlerFactory,
    handlerConfig: { workspaceRoot: opts.workspaceRoot ?? "/tmp/test-edge/agent-a" },
    agentIdentity: {
      agentId: "agent-1",
      inboxId: "inbox-agent-1",
      displayName: "Agent",
      type: "agent",
      visibility: "organization",
      delegateMention: null,
      metadata: {},
    },
    sdk: opts.sdk ?? mockSdk(),
    log: opts.log ?? silentLogger(),
    registryPath: opts.registryPath,
    agentConfigCache: opts.agentConfigCache,
    runtimeSessionTokenFile: opts.runtimeSessionTokenFile,
    ackEntry: opts.ackEntry ?? vi.fn<(entryId: number) => Promise<void>>().mockResolvedValue(undefined),
    recoverChat: opts.recoverChat,
    onStateChange: opts.onStateChange,
    onRuntimeStateChange: opts.onRuntimeStateChange,
    onSessionRuntimeChange: opts.onSessionRuntimeChange,
    onSessionEvent: opts.onSessionEvent,
    confirmSessionEvent: opts.confirmSessionEvent,
  });
}

function internals(sm: SessionManager): SessionManagerInternals {
  return sm as unknown as SessionManagerInternals;
}

function makeMessage(chatId: string): SessionMessage {
  return {
    id: `msg-${chatId}`,
    chatId,
    senderId: "sender-1",
    format: "text",
    content: "hello",
    metadata: {},
    precedingMessages: [],
  };
}

function messageFromEntry(entry: InboxEntryWithMessage): SessionMessage {
  return {
    inboxEntryId: entry.id,
    id: entry.message.id,
    chatId: entry.chatId ?? entry.message.chatId,
    senderId: entry.message.senderId,
    format: entry.message.format,
    content: entry.message.content as string,
    metadata: entry.message.metadata,
    precedingMessages: entry.message.precedingMessages ?? [],
  };
}

function makeSessionRecord(chatId: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  const status = overrides.status ?? "suspended";
  return {
    chatId,
    claudeSessionId: `session-${chatId}`,
    handler: handler(),
    status,
    activeSlotHeld: status === "active",
    lastActivity: Date.now(),
    suspending: null,
    retryAttempt: 0,
    retryNextAt: null,
    retryTimer: null,
    lastRetryReason: null,
    lastRetryCategory: null,
    lastRetryScope: null,
    lastRetryRawError: null,
    retryHeadMessage: null,
    deferredMessages: [],
    routeTransitionPending: false,
    pendingRuntimeFailureNotice: null,
    retryFromEvicted: null,
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("SessionManager edge coverage", () => {
  it("filters runtime sync by active set while force-keeping queued work", async () => {
    const sm = makeManager();
    const i = internals(sm);
    i.sessions.set("chat-active", makeSessionRecord("chat-active"));
    i.sessions.set("chat-archived", makeSessionRecord("chat-archived"));
    i.sessions.set("chat-pending", makeSessionRecord("chat-pending"));
    i.evictedMappings.set("chat-evicted-active", { claudeSessionId: "evicted-active", lastActivity: 1 });
    i.evictedMappings.set("chat-evicted-archived", { claudeSessionId: "evicted-archived", lastActivity: 2 });
    i.pendingQueue.push({ chatId: "chat-pending", message: makeMessage("chat-pending"), deliveryKind: "fresh" });

    const activeSet = new Set(["chat-active", "chat-evicted-active"]);

    expect(sm.getHeldChatIds(activeSet)).toEqual(["chat-active", "chat-pending", "chat-evicted-active"]);
    expect(sm.getSessionStates(activeSet)).toEqual([
      { chatId: "chat-active", state: "suspended" },
      { chatId: "chat-pending", state: "suspended" },
    ]);
    expect(sm.getEvictedChatIds(activeSet)).toEqual(["chat-evicted-active"]);

    await sm.shutdown();
  });

  it("refreshes newer config before dispatch and logs refresh failures without blocking delivery", async () => {
    const okCache = makeCache();
    const okHandler = handler();
    const ok = makeManager({ handlers: [okHandler], agentConfigCache: okCache });

    await ok.dispatch(mockEntry({ id: 1, chatId: "chat-config-ok" }));

    expect(okCache.refreshIfNewer).toHaveBeenCalledWith("agent-1", 1);
    expect(okHandler.start).toHaveBeenCalledTimes(1);
    await ok.shutdown();

    const failingCache = makeCache({
      refreshIfNewer: async () => {
        throw new Error("server unavailable");
      },
    });
    const failHandler = handler();
    const fail = makeManager({ handlers: [failHandler], agentConfigCache: failingCache });

    await fail.dispatch(mockEntry({ id: 2, chatId: "chat-config-fail" }));

    expect(failingCache.refreshIfNewer).toHaveBeenCalledWith("agent-1", 1);
    expect(failHandler.start).toHaveBeenCalledTimes(1);
    await fail.shutdown();
  });

  it("handles suspend, terminate, pending-queue cleanup, ack failures, and quiet-gate snapshots", async () => {
    const first = handler({
      async start() {
        return "idle-log-session";
      },
    });
    const ackEntry = vi
      .fn<(entryId: number) => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("ack offline"))
      .mockResolvedValue(undefined);
    const recoverChat = vi.fn<(chatId: string) => Promise<void>>().mockResolvedValue(undefined);
    const states: Array<{ chatId: string; state: SessionState }> = [];
    const sm = makeManager({
      handlers: [first, handler()],
      ackEntry,
      recoverChat,
      concurrency: 1,
      onStateChange: (chatId, state) => states.push({ chatId, state }),
    });

    const firstEntry = mockEntry({ id: 1, chatId: "chat-active" });
    await sm.dispatch(firstEntry);
    await sm.dispatch(firstEntry);
    expect(sm.activeCount).toBe(1);
    expect(sm.getQuietGateSnapshot().activeCount).toBe(1);
    expect(sm.getQuietGateSnapshot().lastActivityMs).toBeGreaterThan(0);

    await sm.handleCommand("missing", "session:terminate");
    await sm.handleCommand("chat-active", "session:suspend");
    await sm.dispatch(mockEntry({ id: 2, chatId: "chat-active" }));
    // Same-socket recovery fail-closed: suspending clears unfinished local
    // entries and newer same-chat input asks the server to reset/redeliver
    // before the handler resumes.
    expect(recoverChat).toHaveBeenCalledTimes(1);
    expect(ackEntry).not.toHaveBeenCalledWith(2);

    internals(sm).pendingQueue.push({
      chatId: "chat-queued",
      message: makeMessage("chat-queued"),
      deliveryKind: "fresh",
    });
    internals(sm).evictedMappings.set("chat-queued", { claudeSessionId: "queued-session", lastActivity: 1 });
    expect(internals(sm).pendingQueue.some((item) => item.chatId === "chat-queued")).toBe(true);

    await sm.handleCommand("chat-queued", "session:terminate");
    expect(internals(sm).pendingQueue.some((item) => item.chatId === "chat-queued")).toBe(false);
    expect(states.some((item) => item.chatId === "chat-active" && item.state === "suspended")).toBe(true);

    await sm.shutdown();
  });

  it("terminates retrying sessions by clearing retry timers and evicted mappings", async () => {
    const sm = makeManager();
    const retryTimer = setTimeout(() => undefined, 60_000);
    internals(sm).sessions.set(
      "chat-retry",
      makeSessionRecord("chat-retry", {
        retryTimer,
        status: "suspended",
        retryAttempt: 1,
      }),
    );
    internals(sm).evictedMappings.set("chat-retry", { claudeSessionId: "old-session", lastActivity: 1 });

    await sm.handleCommand("chat-retry", "session:terminate");

    expect(internals(sm).sessions.has("chat-retry")).toBe(false);
    expect(internals(sm).evictedMappings.has("chat-retry")).toBe(false);
    await sm.shutdown();
  });

  it("loads persisted registry mappings, prunes the oldest, resumes from disk, and persists live plus evicted rows", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ft-session-registry-"));
    const registryPath = join(dir, "sessions.json");
    const entries: Record<string, { claudeSessionId: string; lastActivity: string; status: SessionState }> = {};
    for (let i = 0; i < 501; i++) {
      entries[`chat-${i}`] = {
        claudeSessionId: `persisted-${i}`,
        lastActivity: new Date(1_000 + i).toISOString(),
        status: "suspended",
      };
    }
    writeFileSync(registryPath, JSON.stringify({ version: 1, entries }), "utf-8");

    const resumed = handler({ resume: vi.fn().mockResolvedValue("resumed-from-registry") });
    const sm = makeManager({ handlers: [resumed], registryPath, maxSessions: 501 });

    expect(sm.getEvictedChatIds()).not.toContain("chat-0");
    expect(sm.getEvictedChatIds()).toContain("chat-500");

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-500" }));
    expect(resumed.resume).toHaveBeenCalledWith(
      expect.anything(),
      "persisted-500",
      expect.anything(),
      expect.anything(),
    );

    internals(sm).evictedMappings.set("chat-extra", { claudeSessionId: "evicted-extra", lastActivity: 2_000 });
    internals(sm).persistRegistry();
    await sm.shutdown();

    rmSync(dir, { recursive: true, force: true });
  });

  it("clears persisted mappings on destructive runtime-switch shutdown", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ft-session-registry-switch-"));
    const registryPath = join(dir, "sessions.json");
    writeFileSync(
      registryPath,
      JSON.stringify({
        version: 1,
        entries: {
          "chat-persisted": {
            claudeSessionId: "persisted-session",
            lastActivity: new Date(1_000).toISOString(),
            status: "evicted",
          },
        },
      }),
      "utf-8",
    );

    const onStateChange = vi.fn();
    const activeHandler = handler();
    const sm = makeManager({ handlers: [activeHandler], registryPath, onStateChange });
    expect(sm.getEvictedChatIds()).toContain("chat-persisted");

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-active" }));
    expect(activeHandler.start).toHaveBeenCalled();
    onStateChange.mockClear();
    internals(sm).evictedMappings.set("chat-extra", { claudeSessionId: "extra-session", lastActivity: 2_000 });
    internals(sm).persistRegistry();

    await sm.shutdown("runtime switched by server", {
      clearPersistedRegistry: true,
      reportSuspendedSessions: false,
    });

    const data = JSON.parse(readFileSync(registryPath, "utf-8")) as { entries: Record<string, unknown> };
    expect(data.entries).toEqual({});
    expect(onStateChange).not.toHaveBeenCalledWith("chat-active", "suspended");

    const reloaded = makeManager({ registryPath });
    expect(reloaded.getEvictedChatIds()).toEqual([]);
    await reloaded.shutdown();

    rmSync(dir, { recursive: true, force: true });
  });

  it("builds session context plumbing from cached config and falls back when self-fence refresh fails", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "ft-session-context-"));
    const sdk = mockSdk();
    const sendMessage = vi.mocked(sdk.sendMessage);
    const config = runtimeConfig({
      payload: {
        kind: "claude-code",
        prompt: { append: "" },
        model: "opus",
        mcpServers: [],
        env: [],
        gitRepos: [{ url: "https://github.com/acme/project.git", localPath: "project" }],
        resourceSkills: [],
        reasoningEffort: "",
      },
    });
    const cache = makeCache({
      config,
      refreshIfNewer: async () => {
        throw new Error("refresh failed");
      },
    });
    let captured: SessionContext | undefined;
    const first = handler({
      async start(_message, ctx) {
        captured = ctx;
        ctx.log("started");
        ctx.recordProviderActivity();
        return "session-context";
      },
    });
    const sm = makeManager({
      handlers: [first],
      sdk,
      workspaceRoot,
      agentConfigCache: cache,
      runtimeSessionTokenFile: "/tmp/runtime-session-token",
    });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-context" }));
    expect(captured).toBeDefined();
    const ctx = captured;
    if (!ctx) throw new Error("context was not captured");

    const env = ctx.buildAgentEnv({ PATH: "/usr/bin" });
    // Single source repo "project" → its clone lives under the `source-repos/`
    // layer, so the narrow doc base and the agentHome-relative repo path both
    // carry the `source-repos/` prefix.
    expect(env.FIRST_TREE_DOC_BASE).toBe(join(workspaceRoot, "source-repos", "project"));
    expect(env.FIRST_TREE_DOC_AGENT_HOME).toBe(workspaceRoot);
    expect(env.FIRST_TREE_DOC_REPO_LOCAL_PATH).toBe("source-repos/project");
    expect(env.FIRST_TREE_WORKSPACES_ROOT).toBe(tmpdir());
    expect(env.FIRST_TREE_AGENT_SLUG).toBe(workspaceRoot.split("/").at(-1));
    expect(env.FIRST_TREE_RUNTIME_SESSION_TOKEN_FILE).toBe("/tmp/runtime-session-token");

    const formatted = await ctx.formatInboundContent({
      id: "msg-format",
      chatId: "chat-context",
      senderId: "sender-1",
      format: "text",
      content: { text: "structured" },
      metadata: {},
      precedingMessages: [
        {
          id: "prior",
          senderId: "agent-1",
          format: "text",
          content: "prior text",
          metadata: {},
          createdAt: new Date().toISOString(),
        },
      ],
    });
    expect(formatted).toContain("[Earlier in chat");
    // Header now carries name + optional type/sent annotations; assert the
    // attribution prefix and the body rather than the exact bracket close.
    expect(formatted).toContain("[From: helper");
    expect(formatted).toContain("prior text");
    expect(formatted).toContain("[From: alice");
    expect(await ctx.resolveSenderLabel("sender-1")).toBe("alice");

    // Final-text delivery is retired: forwardResult writes nothing to chat.
    await ctx.forwardResult("final answer");
    expect(sendMessage).not.toHaveBeenCalled();

    await sm.shutdown();
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("builds context defaults when config cache has no payload", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "ft-session-context-empty-"));
    const cache = makeCache();
    let captured: SessionContext | undefined;
    const sm = makeManager({
      handlers: [
        handler({
          async start(_message, ctx) {
            captured = ctx;
            return "session-empty-cache";
          },
        }),
      ],
      workspaceRoot,
      agentConfigCache: cache,
    });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-empty-cache" }));
    if (!captured) throw new Error("context was not captured");

    const env = captured.buildAgentEnv({});
    expect(env.FIRST_TREE_DOC_BASE).toBe(workspaceRoot);
    expect(env.FIRST_TREE_DOC_AGENT_HOME).toBe(workspaceRoot);
    expect(env.FIRST_TREE_DOC_REPO_LOCAL_PATH).toBeUndefined();

    await sm.shutdown();
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("routes entries whose inbox chatId is absent through the message chatId and defaults missing preceding history", async () => {
    let seen: SessionMessage | undefined;
    const first = handler({
      async start(message) {
        seen = message;
        return "session-no-entry-chat";
      },
    });
    const sm = makeManager({ handlers: [first] });
    const base = mockEntry({ id: 1, chatId: "message-chat" });
    const entry = {
      ...base,
      chatId: null,
      message: {
        ...base.message,
        precedingMessages: undefined,
      },
    } as unknown as InboxEntryWithMessage;

    await sm.dispatch(entry);

    expect(seen?.chatId).toBe("message-chat");
    expect(seen?.precedingMessages).toEqual([]);
    await sm.shutdown();
  });

  it("waits for in-flight suspension and supports admin resume without a message", async () => {
    const resume = vi.fn().mockResolvedValue("resumed-admin");
    const record = makeSessionRecord("chat-admin-resume", {
      status: "suspended",
      claudeSessionId: "old-session",
      handler: handler({ resume }),
      suspending: Promise.resolve(),
    });
    const sm = makeManager();
    internals(sm).sessions.set("chat-admin-resume", record);

    await internals(sm).resumeSession(record, null);

    expect(resume).toHaveBeenCalledWith(undefined, "old-session", expect.anything());
    expect(sm.activeCount).toBe(1);
    await sm.shutdown();
  });

  it("queues admin resume as a control item when no active slot can be acquired", async () => {
    const record = makeSessionRecord("chat-queued-resume", { status: "suspended" });
    const sm = makeManager({ concurrency: 1 });
    internals(sm).sessions.set("chat-queued-resume", record);
    internals(sm)._activeCount = 1;

    await internals(sm).resumeSession(record, null);

    expect(
      internals(sm).pendingQueue.some(
        (item) => item.chatId === "chat-queued-resume" && item.message === null && item.deliveryKind === "control",
      ),
    ).toBe(true);
    await sm.shutdown();
  });

  it("does not let message-less resume preempt an unrelated working session", async () => {
    const workingSuspend = vi.fn().mockResolvedValue(undefined);
    const working = makeSessionRecord("chat-working", {
      status: "active",
      lastActivity: 1,
      handler: handler({ suspend: workingSuspend }),
    });
    const pausedResume = vi.fn().mockResolvedValue("resumed-paused");
    const paused = makeSessionRecord("chat-paused", {
      status: "suspended",
      handler: handler({ resume: pausedResume }),
    });
    const sm = makeManager({ concurrency: 1 });
    internals(sm).sessions.set("chat-working", working);
    internals(sm).sessions.set("chat-paused", paused);
    internals(sm)._activeCount = 1;

    const workingEntry = mockEntry({ id: 99, chatId: "chat-working" });
    const decision = internals(sm).inboxDelivery.receive(workingEntry);
    expect(decision.kind).toBe("deliver");
    if (decision.kind === "deliver") {
      internals(sm).inboxDelivery.markOwned(decision.work);
      internals(sm).inboxDelivery.markProcessingStarted("chat-working", messageFromEntry(workingEntry));
    }

    await sm.handleCommand("chat-paused", "session:resume");

    expect(workingSuspend).not.toHaveBeenCalled();
    expect(pausedResume).not.toHaveBeenCalled();
    expect(
      internals(sm).pendingQueue.some(
        (item) => item.chatId === "chat-paused" && item.message === null && item.deliveryKind === "control",
      ),
    ).toBe(true);
    await sm.shutdown();
  });

  it("routes same-chat delivery after manual suspend without explicit resume", async () => {
    const resume = vi.fn().mockResolvedValue("resumed-paused");
    const paused = makeSessionRecord("chat-paused", {
      status: "suspended",
      claudeSessionId: "old-paused-session",
      handler: handler({ resume }),
    });
    const sm = makeManager({ concurrency: 1 });
    internals(sm).sessions.set("chat-paused", paused);

    await sm.handleCommand("chat-paused", "session:suspend");

    const entry = mockEntry({ id: 101, chatId: "chat-paused" });
    await sm.dispatch(entry);

    expect(resume).toHaveBeenCalledWith(
      expect.objectContaining({ inboxEntryId: 101, chatId: "chat-paused" }),
      "old-paused-session",
      expect.anything(),
      expect.anything(),
    );
    expect(internals(sm).pendingQueue.some((item) => item.chatId === "chat-paused")).toBe(false);
    expect(sm.activeCount).toBe(1);
    await sm.shutdown();
  });

  it("queues recovery redelivery instead of preempting a working session", async () => {
    const working = handler({
      async start(message, ctx) {
        ctx.markMessagesConsumed(message);
        return "working-session";
      },
    });
    const recovered = handler();
    const recoverChat = vi.fn<(chatId: string) => Promise<void>>().mockResolvedValue(undefined);
    const sm = makeManager({
      concurrency: 1,
      handlers: [working, recovered],
      recoverChat,
    });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-working", messageId: "msg-working" }));
    internals(sm).evictedMappings.set("chat-recovery", { claudeSessionId: "old-recovery", lastActivity: 1 });

    await sm.dispatch(mockEntry({ id: 2, chatId: "chat-recovery", messageId: "msg-recovery" }));
    expect(recoverChat).toHaveBeenCalledWith("chat-recovery");

    await sm.dispatch(mockEntry({ id: 2, chatId: "chat-recovery", messageId: "msg-recovery" }));

    expect(working.suspend).not.toHaveBeenCalled();
    expect(recovered.start).not.toHaveBeenCalled();
    expect(internals(sm).pendingQueue.some((item) => item.chatId === "chat-recovery")).toBe(true);

    await sm.shutdown();
  });

  it("keeps the recovery window open across multiple queued recovered frames", async () => {
    const working = handler({
      async start(message, ctx) {
        ctx.markMessagesConsumed(message);
        return "working-session";
      },
    });
    const recovered = handler();
    const recoverChat = vi.fn<(chatId: string) => Promise<void>>().mockResolvedValue(undefined);
    const sm = makeManager({
      concurrency: 1,
      handlers: [working, recovered],
      recoverChat,
    });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-working", messageId: "msg-working" }));
    internals(sm).evictedMappings.set("chat-recovery", { claudeSessionId: "old-recovery", lastActivity: 1 });

    await sm.dispatch(mockEntry({ id: 2, chatId: "chat-recovery", messageId: "msg-recovery-1" }));
    expect(recoverChat).toHaveBeenCalledTimes(1);

    await sm.dispatch(mockEntry({ id: 2, chatId: "chat-recovery", messageId: "msg-recovery-1" }));
    await sm.dispatch(mockEntry({ id: 3, chatId: "chat-recovery", messageId: "msg-recovery-2" }));

    expect(recoverChat).toHaveBeenCalledTimes(1);
    expect(recovered.start).not.toHaveBeenCalled();
    expect(internals(sm).pendingQueue.filter((item) => item.chatId === "chat-recovery")).toHaveLength(2);

    await sm.shutdown();
  });

  it("does not let a queued recovery steal a slot released for fresh preemption", async () => {
    const lifecycles: Array<{ chatId: string; phase: "start" | "resume" }> = [];
    const makeTrackedHandler = () =>
      handler({
        async start(message, ctx) {
          lifecycles.push({ chatId: message.chatId, phase: "start" });
          if (message.chatId === "chat-working") ctx.markMessagesConsumed(message);
          return `session-${message.chatId}`;
        },
        async resume(message) {
          lifecycles.push({ chatId: message?.chatId ?? "", phase: "resume" });
          return `session-${message?.chatId ?? "unknown"}`;
        },
      });
    const recoverChat = vi.fn<(chatId: string) => Promise<void>>().mockResolvedValue(undefined);
    const sm = makeManager({
      concurrency: 1,
      handlers: [makeTrackedHandler(), makeTrackedHandler(), makeTrackedHandler()],
      recoverChat,
    });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-working", messageId: "msg-working" }));
    internals(sm).evictedMappings.set("chat-recovery", { claudeSessionId: "old-recovery", lastActivity: 1 });
    await sm.dispatch(mockEntry({ id: 2, chatId: "chat-recovery", messageId: "msg-recovery" }));
    await sm.dispatch(mockEntry({ id: 2, chatId: "chat-recovery", messageId: "msg-recovery" }));
    expect(internals(sm).pendingQueue.some((item) => item.chatId === "chat-recovery")).toBe(true);

    await sm.dispatch(mockEntry({ id: 3, chatId: "chat-fresh", messageId: "msg-fresh" }));

    expect(sm.activeCount).toBe(1);
    expect(lifecycles).toEqual([
      { chatId: "chat-working", phase: "start" },
      { chatId: "chat-fresh", phase: "start" },
    ]);
    expect(internals(sm).pendingQueue.some((item) => item.chatId === "chat-recovery")).toBe(true);

    await sm.shutdown();
  });

  it("marks queued inbox work for recovery when pending drain routing fails", async () => {
    const ackEntry = vi.fn<(entryId: number) => Promise<void>>().mockResolvedValue(undefined);
    const recoverChat = vi.fn<(chatId: string) => Promise<void>>().mockResolvedValue(undefined);
    let firstContext: SessionContext | undefined;
    let firstMessage: SessionMessage | undefined;
    let factoryCalls = 0;
    const sm = makeManager({
      ackEntry,
      recoverChat,
      concurrency: 1,
      maxSessions: 1,
      handlerFactory: () => {
        factoryCalls++;
        if (factoryCalls > 1) throw new Error("handler factory unavailable");
        return handler({
          async start(message, ctx) {
            firstMessage = message;
            firstContext = ctx;
            ctx.markMessagesConsumed(message);
            return "session-chat-working";
          },
        });
      },
    });

    await sm.dispatch(mockEntry({ id: 10, chatId: "chat-working", messageId: "msg-working" }));
    await sm.dispatch(mockEntry({ id: 11, chatId: "chat-queued", messageId: "msg-queued" }));
    expect(internals(sm).pendingQueue.some((item) => item.chatId === "chat-queued")).toBe(true);
    if (!firstContext || !firstMessage) throw new Error("first context missing");

    await firstContext.finishTurn(firstMessage, { status: "success", terminal: true });

    await vi.waitFor(() => expect(recoverChat).toHaveBeenCalledWith("chat-queued"));
    expect(ackEntry).toHaveBeenCalledWith(10);
    expect(internals(sm).pendingQueue.some((item) => item.chatId === "chat-queued")).toBe(false);

    await sm.shutdown();
  });

  it("covers retry early returns, retry re-queue, start, resume fallback, and emit failures", async () => {
    const events: SessionEvent[] = [];
    const sm = makeManager({
      concurrency: 1,
      handlers: [
        handler({ start: vi.fn().mockResolvedValue("retry-empty-start") }),
        handler({ resume: vi.fn().mockResolvedValue("retry-from-evicted") }),
      ],
      onSessionEvent: (_chatId, event) => events.push(event),
    });

    await internals(sm).runRetry("missing-chat");
    internals(sm).sessions.set("chat-active", makeSessionRecord("chat-active", { status: "active", retryAttempt: 1 }));
    await internals(sm).runRetry("chat-active");

    const queued = makeSessionRecord("chat-retry-queue", {
      retryAttempt: 1,
      status: "suspended",
      claudeSessionId: "",
      retryHeadMessage: makeMessage("chat-retry-queue"),
      lastRetryReason: "rate_limit",
    });
    internals(sm).sessions.set("chat-retry-queue", queued);
    const activeRecord = internals(sm).sessions.get("chat-active");
    if (!activeRecord) throw new Error("active retry guard record missing");
    activeRecord.status = "suspended";
    internals(sm)._activeCount = 1;
    await internals(sm).runRetry("chat-retry-queue");
    expect(queued.retryTimer).not.toBeNull();
    if (queued.retryTimer) {
      clearTimeout(queued.retryTimer);
      queued.retryTimer = null;
    }

    internals(sm)._activeCount = 0;
    await internals(sm).runRetry("chat-retry-queue");
    expect(queued.claudeSessionId).toBe("retry-empty-start");

    const fromEvicted = makeSessionRecord("chat-retry-evicted", {
      retryAttempt: 1,
      status: "suspended",
      claudeSessionId: "",
      retryFromEvicted: { claudeSessionId: "evicted-session", lastActivity: 1 },
      retryHeadMessage: makeMessage("chat-retry-evicted"),
      lastRetryReason: "network_error",
    });
    internals(sm).sessions.set("chat-retry-evicted", fromEvicted);
    await internals(sm).runRetry("chat-retry-evicted");
    expect(fromEvicted.claudeSessionId).toBe("retry-from-evicted");

    expect(events.some((event) => event.kind === "error")).toBe(true);

    internals(sm).triggerImmediateRetry("missing");
    internals(sm).sessions.set("chat-no-retry", makeSessionRecord("chat-no-retry", { retryAttempt: 0 }));
    internals(sm).triggerImmediateRetry("chat-no-retry");
    await sm.shutdown();
  });

  it("does not let runRetry bypass existing recovery debt", async () => {
    const recoverChat = vi.fn<(chatId: string) => Promise<void>>().mockResolvedValue(undefined);
    const recovered = handler({ start: vi.fn().mockResolvedValue("should-not-start") });
    const sm = makeManager({ handlers: [recovered], recoverChat });
    const chatId = "chat-retry-debt";
    const inbox = internals(sm).inboxDelivery;

    inbox.receive(mockEntry({ id: 77, chatId, messageId: "msg-retry-debt" }));
    await inbox.prepareOperatorSuspend(chatId);
    expect(inbox.hasRecoveryDebt(chatId)).toBe(true);

    const retrying = makeSessionRecord(chatId, {
      retryAttempt: 1,
      status: "suspended",
      retryHeadMessage: makeMessage(chatId),
      lastRetryReason: "rate_limit",
    });
    internals(sm).sessions.set(chatId, retrying);

    await internals(sm).runRetry(chatId);

    expect(recoverChat).toHaveBeenCalledWith(chatId);
    expect(recovered.start).not.toHaveBeenCalled();
    expect(retrying.retryAttempt).toBe(0);
    await sm.shutdown();
  });

  it("keeps a message retry head out of the pending queue while a provider slot is busy", async () => {
    vi.useFakeTimers();
    const recovered = handler({ resume: vi.fn().mockResolvedValue("resumed-once") });
    const sm = makeManager({ handlers: [recovered], concurrency: 1 });
    const i = internals(sm);
    const chatId = "chat-retry-slot-message";
    const head = makeMessage(chatId);
    const retrying = makeSessionRecord(chatId, {
      retryAttempt: 1,
      status: "suspended",
      claudeSessionId: "previous-session",
      retryHeadMessage: head,
      lastRetryReason: "network_error",
    });
    const blocker = makeSessionRecord("chat-retry-slot-blocker", { status: "active" });
    i.sessions.set(chatId, retrying);
    i.sessions.set(blocker.chatId, blocker);
    i._activeCount = 1;

    const blockerEntry = mockEntry({ id: 901, chatId: blocker.chatId, messageId: "msg-slot-blocker" });
    const blockerMessage = messageFromEntry(blockerEntry);
    i.inboxDelivery.receive(blockerEntry);
    i.inboxDelivery.markOwned({ chatId: blocker.chatId, entryId: blockerEntry.id, messageId: blockerMessage.id });
    i.inboxDelivery.markProcessingStarted(blocker.chatId, blockerMessage);

    await i.runRetry(chatId);

    expect(recovered.resume).not.toHaveBeenCalled();
    expect(i.pendingQueue.some((queued) => queued.chatId === chatId)).toBe(false);
    expect(retrying.retryTimer).not.toBeNull();

    blocker.status = "suspended";
    i._activeCount = 0;
    await vi.advanceTimersByTimeAsync(5_000);

    expect(recovered.resume).toHaveBeenCalledTimes(1);
    expect(recovered.resume).toHaveBeenCalledWith(head, "previous-session", expect.anything(), expect.anything());
    expect(recovered.inject).not.toHaveBeenCalled();
    expect(retrying.retryAttempt).toBe(0);
    expect(retrying.retryTimer).toBeNull();

    await sm.shutdown();
  });

  it("keeps a control resume retry out of the pending queue while a provider slot is busy", async () => {
    vi.useFakeTimers();
    const recovered = handler({ resume: vi.fn().mockResolvedValue("control-resumed-once") });
    const sm = makeManager({ handlers: [recovered], concurrency: 1 });
    const i = internals(sm);
    const chatId = "chat-retry-slot-control";
    const retrying = makeSessionRecord(chatId, {
      retryAttempt: 1,
      status: "suspended",
      claudeSessionId: "previous-control-session",
      retryHeadMessage: null,
      lastRetryReason: "network_error",
    });
    const blocker = makeSessionRecord("chat-control-slot-blocker", { status: "active" });
    i.sessions.set(chatId, retrying);
    i.sessions.set(blocker.chatId, blocker);
    i._activeCount = 1;

    const blockerEntry = mockEntry({ id: 902, chatId: blocker.chatId, messageId: "msg-control-blocker" });
    const blockerMessage = messageFromEntry(blockerEntry);
    i.inboxDelivery.receive(blockerEntry);
    i.inboxDelivery.markOwned({ chatId: blocker.chatId, entryId: blockerEntry.id, messageId: blockerMessage.id });
    i.inboxDelivery.markProcessingStarted(blocker.chatId, blockerMessage);

    await i.runRetry(chatId);

    expect(recovered.resume).not.toHaveBeenCalled();
    expect(i.pendingQueue.some((queued) => queued.chatId === chatId)).toBe(false);
    expect(retrying.retryTimer).not.toBeNull();

    blocker.status = "suspended";
    i._activeCount = 0;
    await vi.advanceTimersByTimeAsync(5_000);

    expect(recovered.resume).toHaveBeenCalledTimes(1);
    expect(recovered.resume).toHaveBeenCalledWith(undefined, "previous-control-session", expect.anything());
    expect(retrying.retryAttempt).toBe(0);
    expect(retrying.retryTimer).toBeNull();

    await sm.shutdown();
  });

  it("recovers a retry head whose inbox custody is missing before creating a handler", async () => {
    const recoverChat = vi.fn<(chatId: string) => Promise<void>>().mockResolvedValue(undefined);
    const blockedHandler = handler();
    const factory = vi.fn<HandlerFactory>(() => blockedHandler);
    const events: SessionEvent[] = [];
    const sm = makeManager({
      handlerFactory: factory,
      recoverChat,
      onSessionEvent: (_chatId, event) => events.push(event),
    });
    const chatId = "chat-retry-missing-custody";
    const retrying = makeSessionRecord(chatId, {
      retryAttempt: 1,
      status: "suspended",
      claudeSessionId: "previous-session",
      retryHeadMessage: {
        ...makeMessage(chatId),
        id: "settled-message",
        inboxEntryId: 404,
      },
      lastRetryReason: "network_error",
    });
    internals(sm).sessions.set(chatId, retrying);

    await internals(sm).runRetry(chatId);

    expect(factory).not.toHaveBeenCalled();
    expect(blockedHandler.start).not.toHaveBeenCalled();
    expect(blockedHandler.resume).not.toHaveBeenCalled();
    expect(recoverChat).toHaveBeenCalledWith(chatId);
    expect(internals(sm).sessions.has(chatId)).toBe(false);
    expect(
      events.some(
        (event) =>
          event.kind === "error" &&
          parseProviderRetryEventMessage(event.payload.message)?.event === "provider_retry_succeeded",
      ),
    ).toBe(false);

    await sm.shutdown();
  });

  it("recovers an unconsumed queued tail after a retry head fails terminally", async () => {
    const ackEntry = vi.fn<(entryId: number) => Promise<void>>().mockResolvedValue(undefined);
    const recoverChat = vi.fn<(chatId: string) => Promise<void>>().mockResolvedValue(undefined);
    const terminal = handler({
      resume: vi.fn().mockRejectedValue({ name: "ClientUserMismatchError", message: "runtime authorization changed" }),
    });
    const sm = makeManager({
      handlers: [terminal],
      ackEntry,
      recoverChat,
      confirmSessionEvent: vi.fn().mockResolvedValue(undefined),
    });
    const i = internals(sm);
    const chatId = "chat-retry-terminal-tail";
    const headEntry = mockEntry({ id: 2, chatId, messageId: "msg-terminal-head" });
    const tailEntry = mockEntry({ id: 3, chatId, messageId: "msg-terminal-tail" });
    const head = messageFromEntry(headEntry);
    const tail = messageFromEntry(tailEntry);
    i.inboxDelivery.receive(headEntry);
    i.inboxDelivery.receive(tailEntry);
    i.sessions.set(
      chatId,
      makeSessionRecord(chatId, {
        retryAttempt: 1,
        status: "suspended",
        claudeSessionId: "previous-session",
        retryHeadMessage: head,
        deferredMessages: [tail],
      }),
    );

    await i.runRetry(chatId);

    expect(ackEntry).toHaveBeenCalledWith(2);
    expect(recoverChat).toHaveBeenCalledWith(chatId);
    expect(i.inboxDelivery.hasEntry({ chatId, entryId: tailEntry.id, messageId: tail.id })).toBe(false);
    expect(i.inboxDelivery.hasUnsettledWork(chatId)).toBe(false);
    expect(i.sessions.has(chatId)).toBe(false);

    await sm.shutdown();
  });

  it("recovers deferred work when operator suspend races a late terminal resume failure", async () => {
    let signalResumeStarted: (() => void) | undefined;
    let rejectResume: ((reason?: unknown) => void) | undefined;
    const resumeStarted = new Promise<void>((resolve) => {
      signalResumeStarted = resolve;
    });
    const pendingResume = new Promise<string>((_resolve, reject) => {
      rejectResume = reject;
    });
    const existingHandler = handler({
      resume: vi.fn().mockImplementation(() => {
        signalResumeStarted?.();
        return pendingResume;
      }),
    });
    const ackEntry = vi.fn<(entryId: number) => Promise<void>>().mockResolvedValue(undefined);
    const recoverChat = vi.fn<(chatId: string) => Promise<void>>().mockResolvedValue(undefined);
    const sm = makeManager({
      ackEntry,
      recoverChat,
      confirmSessionEvent: vi.fn().mockResolvedValue(undefined),
    });
    const i = internals(sm);
    const chatId = "chat-suspend-late-terminal-resume";
    const headEntry = mockEntry({ id: 2, chatId, messageId: "msg-late-terminal-head" });
    const tailEntry = mockEntry({ id: 3, chatId, messageId: "msg-late-terminal-tail" });
    i.sessions.set(
      chatId,
      makeSessionRecord(chatId, {
        handler: existingHandler,
        status: "suspended",
        claudeSessionId: "previous-session",
      }),
    );
    const blocker = makeSessionRecord("chat-suspend-race-blocker", { status: "active" });
    i.sessions.set(blocker.chatId, blocker);
    i._activeCount = 1;

    const headDispatch = sm.dispatch(headEntry);
    await resumeStarted;
    expect(sm.activeCount).toBe(2);
    await sm.dispatch(tailEntry);
    expect(i.sessions.get(chatId)?.deferredMessages).toHaveLength(1);

    await sm.handleCommand(chatId, "session:suspend");
    await vi.waitFor(() => expect(i.inboxDelivery.hasRecoveryDebt(chatId)).toBe(true));
    expect(sm.activeCount).toBe(1);

    rejectResume?.({ name: "ClientUserMismatchError", message: "runtime authorization changed" });
    await headDispatch;

    expect(recoverChat).toHaveBeenCalledWith(chatId);
    expect(ackEntry).not.toHaveBeenCalledWith(2);
    expect(ackEntry).not.toHaveBeenCalledWith(3);
    expect(i.inboxDelivery.hasUnsettledWork(chatId)).toBe(false);
    expect(i.sessions.has(chatId)).toBe(false);
    expect(i.sessions.has(blocker.chatId)).toBe(true);
    expect(sm.activeCount).toBe(1);

    await sm.shutdown();
  });

  it("does not release a blocker slot twice when suspended resume fails transiently", async () => {
    let signalResumeStarted: (() => void) | undefined;
    let rejectResume: ((reason?: unknown) => void) | undefined;
    const resumeStarted = new Promise<void>((resolve) => {
      signalResumeStarted = resolve;
    });
    const pendingResume = new Promise<string>((_resolve, reject) => {
      rejectResume = reject;
    });
    const existingHandler = handler({
      resume: vi.fn().mockImplementation(() => {
        signalResumeStarted?.();
        return pendingResume;
      }),
    });
    const recoverChat = vi.fn<(chatId: string) => Promise<void>>().mockResolvedValue(undefined);
    const sm = makeManager({ recoverChat });
    const i = internals(sm);
    const chatId = "chat-suspend-late-transient-resume";
    const headEntry = mockEntry({ id: 2, chatId, messageId: "msg-late-transient-head" });
    const tailEntry = mockEntry({ id: 3, chatId, messageId: "msg-late-transient-tail" });
    i.sessions.set(
      chatId,
      makeSessionRecord(chatId, {
        handler: existingHandler,
        status: "suspended",
        claudeSessionId: "previous-session",
      }),
    );
    const blocker = makeSessionRecord("chat-transient-race-blocker", { status: "active" });
    i.sessions.set(blocker.chatId, blocker);
    i._activeCount = 1;

    const headDispatch = sm.dispatch(headEntry);
    await resumeStarted;
    expect(sm.activeCount).toBe(2);
    await sm.dispatch(tailEntry);

    await sm.handleCommand(chatId, "session:suspend");
    await vi.waitFor(() => expect(i.inboxDelivery.hasRecoveryDebt(chatId)).toBe(true));
    expect(sm.activeCount).toBe(1);

    rejectResume?.({ status: 429, message: "provider still limited" });
    await headDispatch;

    expect(i.sessions.get(chatId)?.retryAttempt).toBeGreaterThan(0);
    expect(sm.activeCount).toBe(1);

    await i.runRetry(chatId);

    expect(recoverChat).toHaveBeenCalledWith(chatId);
    expect(i.inboxDelivery.hasUnsettledWork(chatId)).toBe(false);
    expect(i.sessions.has(blocker.chatId)).toBe(true);
    expect(sm.activeCount).toBe(1);

    await sm.shutdown();
  });

  it("releases an errored transition slot when terminate wins before failure event confirmation", async () => {
    let signalConfirmStarted: (() => void) | undefined;
    let resolveConfirm: (() => void) | undefined;
    const confirmStarted = new Promise<void>((resolve) => {
      signalConfirmStarted = resolve;
    });
    const pendingConfirm = new Promise<void>((resolve) => {
      resolveConfirm = resolve;
    });
    const targetHandler = handler({
      resume: vi.fn().mockRejectedValue({ name: "ClientUserMismatchError", message: "wrong client" }),
    });
    const recoverChat = vi.fn<(chatId: string) => Promise<void>>().mockResolvedValue(undefined);
    const sm = makeManager({
      recoverChat,
      confirmSessionEvent: vi.fn().mockImplementation(() => {
        signalConfirmStarted?.();
        return pendingConfirm;
      }),
    });
    const i = internals(sm);
    const chatId = "chat-terminal-confirm-terminate";
    i.sessions.set(
      chatId,
      makeSessionRecord(chatId, {
        handler: targetHandler,
        status: "suspended",
        claudeSessionId: "previous-session",
      }),
    );
    const blocker = makeSessionRecord("chat-terminal-confirm-terminate-blocker", { status: "active" });
    i.sessions.set(blocker.chatId, blocker);
    i._activeCount = 1;

    const headDispatch = sm.dispatch(mockEntry({ id: 2, chatId, messageId: "msg-terminal-confirm-terminate" }));
    await confirmStarted;

    expect(i.sessions.get(chatId)?.status).toBe("errored");
    expect(i.sessions.get(chatId)?.activeSlotHeld).toBe(true);
    expect(sm.activeCount).toBe(2);

    await sm.handleCommand(chatId, "session:terminate");

    expect(i.sessions.has(chatId)).toBe(false);
    expect(targetHandler.shutdown).toHaveBeenCalledTimes(1);
    expect(sm.activeCount).toBe(1);

    resolveConfirm?.();
    await headDispatch;

    expect(i.sessions.has(blocker.chatId)).toBe(true);
    expect(sm.activeCount).toBe(1);
    await sm.shutdown();
  });

  it("releases an errored transition slot when LRU eviction wins before failure event confirmation", async () => {
    let signalConfirmStarted: (() => void) | undefined;
    let resolveConfirm: (() => void) | undefined;
    const confirmStarted = new Promise<void>((resolve) => {
      signalConfirmStarted = resolve;
    });
    const pendingConfirm = new Promise<void>((resolve) => {
      resolveConfirm = resolve;
    });
    const targetHandler = handler({
      resume: vi.fn().mockRejectedValue({ name: "ClientUserMismatchError", message: "wrong client" }),
    });
    const sm = makeManager({
      maxSessions: 2,
      confirmSessionEvent: vi.fn().mockImplementation(() => {
        signalConfirmStarted?.();
        return pendingConfirm;
      }),
    });
    const i = internals(sm);
    const chatId = "chat-terminal-confirm-evict";
    i.sessions.set(
      chatId,
      makeSessionRecord(chatId, {
        handler: targetHandler,
        status: "suspended",
        claudeSessionId: "previous-session",
      }),
    );
    const blocker = makeSessionRecord("chat-terminal-confirm-evict-blocker", { status: "active" });
    i.sessions.set(blocker.chatId, blocker);
    i._activeCount = 1;

    const headDispatch = sm.dispatch(mockEntry({ id: 2, chatId, messageId: "msg-terminal-confirm-evict" }));
    await confirmStarted;

    expect(i.sessions.get(chatId)?.status).toBe("errored");
    expect(i.sessions.get(chatId)?.activeSlotHeld).toBe(true);
    expect(sm.activeCount).toBe(2);

    i.evictIfNeeded();

    expect(i.sessions.has(chatId)).toBe(false);
    expect(targetHandler.shutdown).toHaveBeenCalledTimes(1);
    expect(sm.activeCount).toBe(1);

    resolveConfirm?.();
    await headDispatch;

    expect(i.sessions.has(blocker.chatId)).toBe(true);
    expect(sm.activeCount).toBe(1);
    await sm.shutdown();
  });

  it("blocks retry, tail, and control resume re-entry while terminal retry confirmation is pending", async () => {
    let signalConfirmStarted: (() => void) | undefined;
    let resolveConfirm: (() => void) | undefined;
    const confirmStarted = new Promise<void>((resolve) => {
      signalConfirmStarted = resolve;
    });
    const pendingConfirm = new Promise<void>((resolve) => {
      resolveConfirm = resolve;
    });
    const terminalRetry = handler({
      resume: vi.fn().mockRejectedValue({ name: "ClientUserMismatchError", message: "wrong client" }),
    });
    const replacement = handler({ start: vi.fn().mockResolvedValue("tail-session") });
    const sm = makeManager({
      handlers: [terminalRetry, replacement],
      confirmSessionEvent: vi.fn().mockImplementation(() => {
        signalConfirmStarted?.();
        return pendingConfirm;
      }),
    });
    const i = internals(sm);
    const chatId = "chat-terminal-confirm-admission";
    const headEntry = mockEntry({ id: 2, chatId, messageId: "msg-terminal-confirm-head" });
    const tailEntry = mockEntry({ id: 3, chatId, messageId: "msg-terminal-confirm-tail" });
    const head = messageFromEntry(headEntry);
    i.inboxDelivery.receive(headEntry);
    i.sessions.set(
      chatId,
      makeSessionRecord(chatId, {
        retryAttempt: 1,
        status: "suspended",
        claudeSessionId: "previous-session",
        retryHeadMessage: head,
        lastRetryReason: "network_error",
      }),
    );
    const blocker = makeSessionRecord("chat-terminal-confirm-admission-blocker", { status: "active" });
    i.sessions.set(blocker.chatId, blocker);
    i._activeCount = 1;

    const retryPromise = i.runRetry(chatId);
    await confirmStarted;

    expect(i.sessions.get(chatId)?.status).toBe("errored");
    expect(i.sessions.get(chatId)?.activeSlotHeld).toBe(true);
    expect(i.sessions.get(chatId)?.retryAttempt).toBe(0);
    expect(sm.activeCount).toBe(2);

    await sm.dispatch(tailEntry);
    await sm.handleCommand(chatId, "session:resume");
    await i.runRetry(chatId);

    expect(terminalRetry.resume).toHaveBeenCalledTimes(1);
    expect(replacement.start).not.toHaveBeenCalled();
    expect(replacement.resume).not.toHaveBeenCalled();
    expect(i.pendingQueue.some((queued) => queued.message?.id === tailEntry.message.id)).toBe(true);
    expect(sm.activeCount).toBe(2);

    resolveConfirm?.();
    await retryPromise;
    await vi.waitFor(() => expect(replacement.start).toHaveBeenCalledTimes(1));

    expect(replacement.start).toHaveBeenCalledWith(
      expect.objectContaining({ id: tailEntry.message.id }),
      expect.anything(),
      expect.anything(),
    );
    expect(terminalRetry.resume).toHaveBeenCalledTimes(1);
    expect(i.sessions.has(blocker.chatId)).toBe(true);
    expect(sm.activeCount).toBe(2);
    await sm.shutdown();
  });

  it("keeps retry failures in retry mode and tears down permanent retry failures with non-Error previews", async () => {
    const transient = handler({
      start: vi.fn().mockRejectedValue({ status: 429, message: "still limited" }),
    });
    const permanent = handler({
      start: vi.fn().mockRejectedValue({ name: "ClientUserMismatchError", message: "plain failure" }),
    });
    const states: SessionState[] = [];
    const sm = makeManager({
      handlers: [transient, permanent],
      onStateChange: (_chatId, state) => states.push(state),
      onSessionEvent: () => {
        throw new Error("event channel closed");
      },
    });

    const retrying = makeSessionRecord("chat-retry-transient", {
      retryAttempt: 1,
      status: "suspended",
      claudeSessionId: "",
      retryHeadMessage: makeMessage("chat-retry-transient"),
      lastRetryReason: "rate_limit",
    });
    internals(sm).sessions.set("chat-retry-transient", retrying);
    await internals(sm).runRetry("chat-retry-transient");
    expect(retrying.retryAttempt).toBeGreaterThan(1);

    const failing = makeSessionRecord("chat-retry-permanent", {
      retryAttempt: 1,
      status: "suspended",
      claudeSessionId: "",
      retryHeadMessage: makeMessage("chat-retry-permanent"),
    });
    internals(sm).sessions.set("chat-retry-permanent", failing);
    await internals(sm).runRetry("chat-retry-permanent");

    expect(internals(sm).sessions.has("chat-retry-permanent")).toBe(false);
    expect(states).toContain("errored");
    await sm.shutdown();
  });

  it("runs scheduled retry timers and catches retry timer failures", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const limited = handler({
      start: vi.fn().mockRejectedValue({ status: 429, message: "rate limited" }),
    });
    const sm = makeManager({ handlers: [limited] });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-timer" }));
    await vi.advanceTimersByTimeAsync(1_000);

    await sm.shutdown();
  });

  it("runs re-armed retry timers and catches rearm failures", async () => {
    vi.useFakeTimers();
    const sm = makeManager({
      concurrency: 1,
      handlerFactory: () => {
        throw new Error("rearm factory failed");
      },
    });
    const retrying = makeSessionRecord("chat-rearm", {
      retryAttempt: 1,
      status: "suspended",
      claudeSessionId: "",
      retryHeadMessage: makeMessage("chat-rearm"),
      lastRetryReason: "rate_limit",
    });
    internals(sm).sessions.set("chat-rearm", retrying);
    internals(sm)._activeCount = 1;

    await internals(sm).runRetry("chat-rearm");
    internals(sm)._activeCount = 0;
    await vi.advanceTimersByTimeAsync(5_000);

    await sm.shutdown();
  });

  it("uses retry-time config cache, clears existing retry timers, and catches retry-success emit failures", async () => {
    const cache = makeCache();
    const existingTimer = setTimeout(() => undefined, 60_000);
    const successfulResume = handler({ resume: vi.fn().mockResolvedValue("retry-resumed") });
    const transientResume = handler({
      resume: vi.fn().mockRejectedValue({ status: 429, message: "still limited" }),
    });
    const sm = makeManager({
      handlers: [successfulResume, transientResume],
      agentConfigCache: cache,
      onSessionEvent: () => {
        throw new Error("event channel closed");
      },
    });

    const succeeds = makeSessionRecord("chat-retry-success", {
      retryAttempt: 1,
      status: "suspended",
      claudeSessionId: "previous-session",
      retryHeadMessage: null,
      lastRetryReason: "rate_limit",
    });
    internals(sm).sessions.set("chat-retry-success", succeeds);
    await internals(sm).runRetry("chat-retry-success");
    expect(successfulResume.resume).toHaveBeenCalledWith(undefined, "previous-session", expect.anything());

    const retriesAgain = makeSessionRecord("chat-retry-again", {
      retryAttempt: 1,
      status: "suspended",
      claudeSessionId: "previous-session-again",
      retryTimer: existingTimer,
      retryHeadMessage: makeMessage("chat-retry-again"),
      lastRetryReason: "rate_limit",
    });
    internals(sm).sessions.set("chat-retry-again", retriesAgain);
    await internals(sm).runRetry("chat-retry-again");
    expect(retriesAgain.retryAttempt).toBeGreaterThan(1);

    await sm.shutdown();
  });

  it("classifies retry failures with only retryFromEvicted as resume failures", async () => {
    const resumeFails = handler({
      resume: vi.fn().mockRejectedValue({ status: 429, message: "still limited" }),
    });
    const sm = makeManager({ handlers: [resumeFails] });
    const retrying = makeSessionRecord("chat-retry-from-evicted", {
      retryAttempt: 1,
      status: "suspended",
      claudeSessionId: "",
      retryFromEvicted: { claudeSessionId: "evicted-session", lastActivity: 1 },
      retryHeadMessage: makeMessage("chat-retry-from-evicted"),
      lastRetryReason: "rate_limit",
    });
    internals(sm).sessions.set("chat-retry-from-evicted", retrying);

    await internals(sm).runRetry("chat-retry-from-evicted");

    expect(resumeFails.resume).toHaveBeenCalledWith(
      expect.anything(),
      "evicted-session",
      expect.anything(),
      expect.anything(),
    );
    expect(retrying.retryAttempt).toBeGreaterThan(1);
    await sm.shutdown();
  });

  it("classifies evicted resume failures as resume-phase failures", async () => {
    const states: SessionState[] = [];
    const resumeFails = handler({
      resume: vi.fn().mockRejectedValue({ name: "ClientUserMismatchError", message: "wrong client" }),
    });
    const sm = makeManager({
      handlers: [resumeFails],
      onStateChange: (_chatId, state) => states.push(state),
    });
    internals(sm).evictedMappings.set("chat-evicted-fail", { claudeSessionId: "evicted-session", lastActivity: 1 });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-evicted-fail" }));

    expect(states).toContain("errored");
    await sm.shutdown();
  });

  it("evicts non-active sessions before active ones and prefers the least recently active session", async () => {
    const sm = makeManager({ maxSessions: 2 });
    const activeOld = makeSessionRecord("chat-active-old", { status: "active", lastActivity: 10 });
    const activeNew = makeSessionRecord("chat-active-new", { status: "active", lastActivity: 20 });
    internals(sm).sessions.set("chat-active-new", activeNew);
    internals(sm).sessions.set("chat-active-old", activeOld);
    internals(sm).evictIfNeeded();
    expect(internals(sm).evictedMappings.has("chat-active-old")).toBe(true);

    internals(sm).sessions.clear();
    internals(sm).evictedMappings.clear();
    internals(sm)._activeCount = 1;
    const active = makeSessionRecord("chat-active", { status: "active", lastActivity: 10 });
    const suspended = makeSessionRecord("chat-suspended", { status: "suspended", lastActivity: 20 });
    internals(sm).sessions.set("chat-active", active);
    internals(sm).sessions.set("chat-suspended", suspended);
    internals(sm).evictIfNeeded();
    expect(internals(sm).evictedMappings.has("chat-suspended")).toBe(true);

    await sm.shutdown();
  });

  it("queues from start-new-session and from same-chat active-slot acquisition", async () => {
    const sm = makeManager({ concurrency: 1 });

    internals(sm)._activeCount = 1;
    await internals(sm).routeMessage("chat-start-queued", makeMessage("chat-start-queued"));
    expect(internals(sm).pendingQueue.some((item) => item.chatId === "chat-start-queued")).toBe(true);

    internals(sm).pendingQueue.length = 0;
    const active = makeSessionRecord("chat-same", { status: "active" });
    internals(sm).sessions.set("chat-same", active);
    internals(sm)._activeCount = 1;
    expect(internals(sm).acquireActiveSlot("chat-same", makeMessage("chat-same"))).toBe(false);
    expect(internals(sm).pendingQueue.some((item) => item.chatId === "chat-same")).toBe(true);

    await sm.shutdown();
  });

  it("covers drainPendingQueue return and edge branches", async () => {
    const sm = makeManager({ concurrency: 1, handlers: [handler()] });

    internals(sm).pendingQueue.push({ chatId: "chat-held", message: makeMessage("chat-held"), deliveryKind: "fresh" });
    internals(sm)._activeCount = 1;
    internals(sm).drainPendingQueue();
    expect(internals(sm).pendingQueue.some((item) => item.chatId === "chat-held")).toBe(true);

    internals(sm)._activeCount = 0;
    internals(sm).drainPendingQueue();
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(internals(sm).sessions.has("chat-held")).toBe(true);

    const emptyShift = internals(makeManager());
    emptyShift.pendingQueue.push({
      chatId: "chat-empty-shift",
      message: makeMessage("chat-empty-shift"),
      deliveryKind: "fresh",
    });
    emptyShift.pendingQueue.shift = () => undefined;
    emptyShift.drainPendingQueue();
    await (emptyShift as unknown as SessionManager).shutdown();

    await sm.shutdown();
  });

  it("drains pending queue without an entry id and logs asynchronous drain failures", async () => {
    const sm = makeManager({
      handlerFactory: () => {
        throw new Error("factory failed during drain");
      },
    });
    internals(sm).pendingQueue.push({
      chatId: "chat-drain",
      message: makeMessage("chat-drain"),
      deliveryKind: "fresh",
    });
    internals(sm).drainPendingQueue();
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(sm.totalCount).toBe(0);
    await sm.shutdown();
  });

  it("logs rejected suspends without breaking suspension cleanup", async () => {
    const badSuspend = handler({ suspend: vi.fn().mockRejectedValue(new Error("suspend failed")) });
    const sm = makeManager({ handlers: [badSuspend] });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-bad-suspend" }));
    await sm.handleCommand("chat-bad-suspend", "session:suspend");
    const suspended = internals(sm).sessions.get("chat-bad-suspend")?.suspending;
    if (suspended) await suspended;

    expect(badSuspend.suspend).toHaveBeenCalledTimes(1);
    await sm.shutdown();
  });

  it("deduplicates explicit state notifications and skips reaffirm when no callback exists", async () => {
    const states: SessionState[] = [];
    const withCallback = makeManager({ onStateChange: (_chatId, state) => states.push(state) });
    internals(withCallback).notifySessionState("chat-state", "active");
    internals(withCallback).notifySessionState("chat-state", "active");
    expect(states).toEqual(["active"]);
    await withCallback.shutdown();

    const withoutRuntimeCallback = makeManager();
    internals(withoutRuntimeCallback).reaffirmRuntimeStates();
    internals(withoutRuntimeCallback).sessions.set(
      "chat-suspended-snapshot",
      makeSessionRecord("chat-suspended-snapshot", { status: "suspended" }),
    );
    expect(withoutRuntimeCallback.getSessionRuntimeStates()).toEqual([]);
    await withoutRuntimeCallback.shutdown();
  });

  it("reports runtime snapshots only for active sessions and ignores inactive provider activity", async () => {
    const runtimeChanges: RuntimeState[] = [];
    let captured: SessionContext | undefined;
    const sm = makeManager({
      handlers: [
        handler({
          async start(message, ctx) {
            captured = ctx;
            ctx.markMessagesConsumed(message);
            return "runtime-session";
          },
        }),
      ],
      onRuntimeStateChange: (state) => runtimeChanges.push(state),
      onSessionRuntimeChange: vi.fn(),
    });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-runtime" }));
    expect(sm.getSessionRuntimeStates()).toEqual([{ chatId: "chat-runtime", runtimeState: "working" }]);
    if (!captured) throw new Error("context was not captured");
    runtimeChanges.length = 0;
    await sm.handleCommand("chat-runtime", "session:suspend");
    captured.recordProviderActivity();
    expect(runtimeChanges).not.toContain("working");

    internals(sm).reaffirmRuntimeStates();
    await sm.shutdown();
  });

  it("covers session context transport updates and confirmed event channels", async () => {
    const events: SessionEvent[] = [];
    const sm = makeManager({
      onSessionEvent: (_chatId, event) => events.push(event),
    });
    const nextSdk = mockSdk();
    const nextCache = makeCache();

    sm.updateTransport(nextSdk, nextCache);
    sm.noteBindRecoveryComplete();

    const ctx = internals(sm).buildSessionContext("chat-context");
    expect(ctx.sdk).toBe(nextSdk);
    await expect(ctx.formatFromHeader(makeMessage("chat-context"))).resolves.toContain("alice");

    const event: SessionEvent = { kind: "error", payload: { source: "runtime", message: "boom" } };
    if (!ctx.emitEventConfirmed) throw new Error("confirmed event callback missing");
    await expect(ctx.emitEventConfirmed(event)).rejects.toThrow("confirmed session event channel unavailable");
    expect(events).toEqual([event]);
    await sm.shutdown();

    const confirmSessionEvent = vi.fn<(chatId: string, event: SessionEvent) => Promise<void>>().mockResolvedValue();
    const confirmed = makeManager({ confirmSessionEvent });
    const confirmedCtx = internals(confirmed).buildSessionContext("chat-confirmed");
    if (!confirmedCtx.emitEventConfirmed) throw new Error("confirmed event callback missing");
    await confirmedCtx.emitEventConfirmed(event);
    expect(confirmSessionEvent).toHaveBeenCalledWith("chat-confirmed", event);
    await confirmed.shutdown();
  });

  it("resolves document self fences from runtime config and falls back on refresh failure", async () => {
    const workspaceRoot = "/tmp/test-edge/fence-agent";
    const config = runtimeConfig({
      payload: {
        ...runtimeConfig().payload,
        gitRepos: [{ url: "https://github.com/acme/repo.git", localPath: "repo" }],
      },
    });
    const sm = makeManager({ workspaceRoot, agentConfigCache: makeCache({ config }) });
    const logs: string[] = [];

    await expect(internals(sm).resolveSelfFence((msg) => logs.push(msg), "chat-fence")).resolves.toEqual({
      agentHome: workspaceRoot,
      singleRepoLocalPath: "source-repos/repo",
    });
    expect(logs).toEqual([]);
    await sm.shutdown();

    const failing = makeManager({
      workspaceRoot,
      agentConfigCache: makeCache({
        refreshIfNewer: async () => {
          throw new Error("config unavailable");
        },
      }),
    });
    await expect(internals(failing).resolveSelfFence((msg) => logs.push(msg), "chat-fence-fallback")).resolves.toEqual({
      agentHome: workspaceRoot,
    });
    expect(logs.some((msg) => msg.includes("config unavailable"))).toBe(true);
    await failing.shutdown();
  });

  it("resolves chat org ids with caching and degrades lookup failures to null", async () => {
    const getChatDetail = vi.fn(async (chatId: string) => {
      if (chatId === "chat-org") return { organizationId: "org-1" };
      if (chatId === "chat-empty-org") return { organizationId: "" };
      throw new Error("lookup failed");
    });
    const sdk = { ...mockSdk(), getChatDetail } as unknown as FirstTreeHubSDK;
    const sm = makeManager({ sdk });
    const logs: string[] = [];
    const log = (msg: string): void => {
      logs.push(msg);
    };

    await expect(internals(sm).resolveChatOrgId(log, "chat-org")).resolves.toBe("org-1");
    await expect(internals(sm).resolveChatOrgId(log, "chat-org")).resolves.toBe("org-1");
    expect(getChatDetail).toHaveBeenCalledTimes(1);

    await expect(internals(sm).resolveChatOrgId(log, "chat-empty-org")).resolves.toBeNull();
    await expect(internals(sm).resolveChatOrgId(log, "chat-fail")).resolves.toBeNull();
    expect(logs.some((msg) => msg.includes("lookup failed"))).toBe(true);
    await sm.shutdown();
  });

  it("uses idle fallback in evictIdle logging when no runtime state was recorded", async () => {
    vi.useFakeTimers({ now: 100_000 });
    const log = recordingLogger();
    let captured: SessionContext | undefined;
    let capturedMessage: SessionMessage | undefined;
    const first = handler({
      async start(message, ctx) {
        capturedMessage = message;
        captured = ctx;
        return "idle-log-session";
      },
    });
    const sm = new SessionManager({
      session: { idle_timeout: 1, max_sessions: 10, working_grace_seconds: 1, reconcile_interval_seconds: 300 },
      concurrency: 5,
      handlerFactory: () => first,
      handlerConfig: { workspaceRoot: "/tmp/test-edge/idle-log" },
      agentIdentity: {
        agentId: "agent-1",
        inboxId: "inbox-agent-1",
        displayName: "Agent",
        type: "agent",
        visibility: "organization",
        delegateMention: null,
        metadata: {},
      },
      sdk: mockSdk(),
      log: log.logger,
      ackEntry: vi.fn<(entryId: number) => Promise<void>>().mockResolvedValue(undefined),
    });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-idle-log" }));
    if (!capturedMessage) throw new Error("message was not captured");
    await captured?.finishTurn(capturedMessage, { status: "success", terminal: true });
    vi.advanceTimersByTime(2_000);

    vi.advanceTimersByTime(10_000);

    expect(log.records.some((entry) => entry.msg === "session idle, suspending" && entry.runtimeState === "idle")).toBe(
      true,
    );
    await sm.shutdown();
  });

  it("reaffirms active runtime states on the jittered timer and recomputes blocked/error aggregates", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const sessionRuntimeChanges: Array<{ chatId: string; state: RuntimeState }> = [];
    const aggregateChanges: RuntimeState[] = [];
    const sm = makeManager({
      onSessionRuntimeChange: (chatId, state) => sessionRuntimeChanges.push({ chatId, state }),
      onRuntimeStateChange: (state) => aggregateChanges.push(state),
    });
    const i = internals(sm);
    i.sessions.set("chat-working", makeSessionRecord("chat-working", { status: "active" }));
    i.sessions.set("chat-error", makeSessionRecord("chat-error", { status: "errored" }));
    i.sessions.set("chat-idle", makeSessionRecord("chat-idle", { status: "active" }));
    i.sessionRuntimeStates.set("chat-working", "working");
    i.sessionRuntimeStates.set("chat-error", "error");
    i.sessionRuntimeStates.set("chat-idle", "idle");

    await vi.advanceTimersByTimeAsync(20_000);

    expect(sessionRuntimeChanges).toEqual([
      { chatId: "chat-working", state: "working" },
      { chatId: "chat-error", state: "error" },
    ]);

    i.sessionRuntimeStates.clear();
    i.sessionRuntimeStates.set("chat-working", "working");
    i.sessionRuntimeStates.set("chat-blocked", "blocked");
    i.recomputeRuntimeState();
    i.sessionRuntimeStates.set("chat-error", "error");
    i.recomputeRuntimeState();

    expect(aggregateChanges).toContain("blocked");
    expect(aggregateChanges).toContain("error");
    await sm.shutdown();
  });

  it("eagerly fetches valid image batches and logs failed attachment downloads", async () => {
    const home = mkdtempSync(join(tmpdir(), "ft-session-images-"));
    vi.stubEnv("FIRST_TREE_HOME", home);
    const fetchAttachment = vi
      .fn<(params: { id: string }) => Promise<{ bytes: Buffer }>>()
      .mockResolvedValueOnce({ bytes: Buffer.from("png bytes") })
      .mockRejectedValueOnce(new Error("blob missing"));
    const sdk = { ...mockSdk(), fetchAttachment } as unknown as FirstTreeHubSDK;
    const started = handler();
    const sm = makeManager({ handlers: [started], sdk });
    const base = mockEntry({ id: 501, chatId: "chat-images", messageId: "msg-images" });
    const entry = {
      ...base,
      message: {
        ...base.message,
        format: "file",
        content: {
          caption: "two images",
          attachments: [
            {
              imageId: "11111111-1111-4111-8111-111111111111",
              mimeType: "image/png",
              filename: "first.png",
            },
            {
              imageId: "22222222-2222-4222-8222-222222222222",
              mimeType: "image/jpeg",
              filename: "second.jpg",
            },
          ],
        },
      },
    } as InboxEntryWithMessage;

    await sm.dispatch(entry);

    expect(fetchAttachment).toHaveBeenCalledTimes(2);
    expect(fetchAttachment).toHaveBeenNthCalledWith(1, { id: "11111111-1111-4111-8111-111111111111" });
    expect(
      readFileSync(
        join(home, "data", "chats", "chat-images", "images", "11111111-1111-4111-8111-111111111111.png"),
        "utf8",
      ),
    ).toBe("png bytes");
    expect(started.start).toHaveBeenCalledTimes(1);

    const singleBase = mockEntry({ id: 502, chatId: "chat-images", messageId: "msg-image-existing" });
    await sm.dispatch({
      ...singleBase,
      message: {
        ...singleBase.message,
        format: "file",
        content: {
          imageId: "11111111-1111-4111-8111-111111111111",
          mimeType: "image/png",
          filename: "first.png",
        },
      },
    } as InboxEntryWithMessage);

    expect(fetchAttachment).toHaveBeenCalledTimes(2);
    expect(started.inject).toHaveBeenCalledTimes(1);
    await sm.shutdown();
    rmSync(home, { recursive: true, force: true });
  });

  it("retries consumed error completions when runtime notice delivery and failure-event emit both fail", async () => {
    const ackEntry = vi.fn<(entryId: number) => Promise<void>>().mockResolvedValue(undefined);
    const recoverChat = vi.fn<(chatId: string) => Promise<void>>().mockResolvedValue(undefined);
    const sendMessage = vi.fn().mockRejectedValue(new Error("notice store offline"));
    const sdk = { ...mockSdk(), sendMessage } as unknown as FirstTreeHubSDK;
    let capturedToken: Parameters<AgentHandler["start"]>[2] | undefined;
    let capturedMessage: SessionMessage | undefined;
    const started = handler({
      async start(message, _ctx, token) {
        capturedMessage = message;
        capturedToken = token;
        return "runtime-notice-session";
      },
    });
    const sm = makeManager({
      handlers: [started],
      ackEntry,
      recoverChat,
      sdk,
      onSessionEvent: () => {
        throw new Error("event stream closed");
      },
    });

    await sm.dispatch(mockEntry({ id: 502, chatId: "chat-notice-emit-fail", messageId: "msg-notice-emit-fail" }));
    const entry = internals(sm).sessions.get("chat-notice-emit-fail");
    if (!entry || !capturedMessage || !capturedToken) throw new Error("delivery was not captured");
    entry.pendingRuntimeFailureNotice = {
      event: "provider_failure_terminal",
      provider: "claude-code",
      scope: "provider_turn",
      category: "credential",
      reasonCode: "provider_credential_required",
      replaySafety: "provider_entered",
      userSeverity: "error",
      messagePreview: "auth expired",
    };

    await capturedToken.complete(capturedMessage, {
      status: "error",
      terminal: true,
      completion: "consumed",
      reason: "provider_failed",
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(ackEntry).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(recoverChat).toHaveBeenCalledWith("chat-notice-emit-fail"));
    await sm.shutdown();
  });

  it("retries and rethrows admission failures after local custody is still open", async () => {
    const sm = makeManager();
    internals(sm).ensureContextTreeBinding = vi.fn().mockRejectedValue(new Error("tree resolver failed"));

    await expect(
      sm.dispatch(mockEntry({ id: 504, chatId: "chat-admission-fail", messageId: "msg-admission-fail" })),
    ).rejects.toThrow("tree resolver failed");

    expect(internals(sm).inboxDelivery.hasRecoveryDebt("chat-admission-fail")).toBe(true);
    await sm.shutdown();
  });

  it("logs resilience emit failures when slot queuing cannot notify listeners", async () => {
    const sm = makeManager({
      concurrency: 1,
      onSessionEvent: () => {
        throw new Error("event sink unavailable");
      },
    });
    internals(sm)._activeCount = 1;

    await internals(sm).routeMessage("chat-queue-emit-fail", makeMessage("chat-queue-emit-fail"));

    expect(internals(sm).pendingQueue.some((item) => item.chatId === "chat-queue-emit-fail")).toBe(true);
    await sm.shutdown();
  });

  it("logs second-stage suspend cleanup failures when the suspend warning path itself throws", async () => {
    const log = silentLogger();
    const warn = vi
      .spyOn(log, "warn")
      .mockImplementationOnce(() => {
        throw new Error("warn transport failed");
      })
      .mockImplementation(() => undefined);
    const sm = makeManager({
      handlers: [handler({ suspend: vi.fn().mockRejectedValue(new Error("suspend failed")) })],
      log,
    });

    await sm.dispatch(mockEntry({ id: 505, chatId: "chat-suspend-log-fail", messageId: "msg-suspend-log-fail" }));
    await sm.handleCommand("chat-suspend-log-fail", "session:suspend");
    const suspending = internals(sm).sessions.get("chat-suspend-log-fail")?.suspending;
    if (suspending) await suspending;

    expect(warn).toHaveBeenCalledTimes(2);
    await sm.shutdown();
  });

  it("cleans up unowned routes and logs asynchronous unowned shutdown failures", async () => {
    const badShutdown = vi.fn().mockRejectedValue(new Error("shutdown failed"));
    const sm = makeManager();
    const i = internals(sm);
    const record = makeSessionRecord("chat-unowned", {
      status: "active",
      handler: handler({ shutdown: badShutdown }),
    });
    i.sessions.set("chat-unowned", record);
    i._activeCount = 1;

    i.abortUnownedRoute(record, "test_unowned_route");

    expect(i.sessions.has("chat-unowned")).toBe(false);
    expect(sm.activeCount).toBe(0);
    await vi.waitFor(() => expect(badShutdown).toHaveBeenCalledWith("test_unowned_route"));
    await sm.shutdown();
  });

  it("aborts lost ownership receipts from start, resume, and retry routing branches", async () => {
    const makeOwnedReceipt = (sessionId: string) => ({ sessionId, route: { kind: "owned", mode: "queued" } as const });
    const loseOwnership: SessionManagerInternals["markRouteOwned"] = () => "lost";

    const startHandler = handler({ start: vi.fn().mockResolvedValue(makeOwnedReceipt("start-lost")) });
    const startManager = makeManager({ handlers: [startHandler] });
    internals(startManager).markRouteOwned = loseOwnership;
    await internals(startManager).routeMessage("chat-start-lost", makeMessage("chat-start-lost"));
    expect(internals(startManager).sessions.has("chat-start-lost")).toBe(false);
    await startManager.shutdown();

    const evictedHandler = handler({ resume: vi.fn().mockResolvedValue(makeOwnedReceipt("evicted-lost")) });
    const evictedManager = makeManager({ handlers: [evictedHandler] });
    internals(evictedManager).evictedMappings.set("chat-evicted-lost", {
      claudeSessionId: "old-evicted",
      lastActivity: 1,
    });
    internals(evictedManager).markRouteOwned = loseOwnership;
    await internals(evictedManager).routeMessage("chat-evicted-lost", makeMessage("chat-evicted-lost"));
    expect(internals(evictedManager).sessions.has("chat-evicted-lost")).toBe(false);
    await evictedManager.shutdown();

    const suspendedRecord = makeSessionRecord("chat-resume-lost", {
      status: "suspended",
      handler: handler({ resume: vi.fn().mockResolvedValue(makeOwnedReceipt("resume-lost")) }),
    });
    const resumeManager = makeManager();
    internals(resumeManager).sessions.set("chat-resume-lost", suspendedRecord);
    internals(resumeManager).markRouteOwned = loseOwnership;
    await internals(resumeManager).resumeSession(suspendedRecord, makeMessage("chat-resume-lost"));
    expect(internals(resumeManager).sessions.has("chat-resume-lost")).toBe(false);
    await resumeManager.shutdown();

    const retryResumeHandler = handler({ resume: vi.fn().mockResolvedValue(makeOwnedReceipt("retry-resume-lost")) });
    const retryResumeManager = makeManager({ handlers: [retryResumeHandler] });
    internals(retryResumeManager).sessions.set(
      "chat-retry-resume-lost",
      makeSessionRecord("chat-retry-resume-lost", {
        retryAttempt: 1,
        status: "suspended",
        claudeSessionId: "previous-retry",
        retryHeadMessage: makeMessage("chat-retry-resume-lost"),
      }),
    );
    internals(retryResumeManager).markRouteOwned = loseOwnership;
    await internals(retryResumeManager).runRetry("chat-retry-resume-lost");
    expect(internals(retryResumeManager).sessions.has("chat-retry-resume-lost")).toBe(false);
    await retryResumeManager.shutdown();

    const retryStartHandler = handler({ start: vi.fn().mockResolvedValue(makeOwnedReceipt("retry-start-lost")) });
    const retryStartManager = makeManager({ handlers: [retryStartHandler] });
    internals(retryStartManager).sessions.set(
      "chat-retry-start-lost",
      makeSessionRecord("chat-retry-start-lost", {
        retryAttempt: 1,
        status: "suspended",
        claudeSessionId: "",
        retryHeadMessage: makeMessage("chat-retry-start-lost"),
      }),
    );
    internals(retryStartManager).markRouteOwned = loseOwnership;
    await internals(retryStartManager).runRetry("chat-retry-start-lost");
    expect(internals(retryStartManager).sessions.has("chat-retry-start-lost")).toBe(false);
    await retryStartManager.shutdown();
  });

  it("drains active and control pending queue branches, including asynchronous requeue failures", async () => {
    const activeManager = makeManager();
    const activeInternals = internals(activeManager);
    activeInternals.sessions.set("chat-active-drain", makeSessionRecord("chat-active-drain", { status: "active" }));
    activeInternals.pendingQueue.push({
      chatId: "chat-active-drain",
      message: null,
      deliveryKind: "control",
    });
    activeInternals.pendingQueue.push({
      chatId: "chat-active-drain",
      message: makeMessage("chat-active-drain"),
      deliveryKind: "fresh",
    });
    activeInternals.routeMessage = vi.fn().mockRejectedValue(new Error("active drain failed"));

    activeInternals.drainPendingQueue();
    await vi.waitFor(() => expect(activeInternals.routeMessage).toHaveBeenCalledTimes(1));
    expect(activeInternals.pendingQueue.some((item) => item.chatId === "chat-active-drain")).toBe(true);
    await activeManager.shutdown();

    const activeInboxManager = makeManager();
    const activeInboxInternals = internals(activeInboxManager);
    activeInboxInternals.sessions.set(
      "chat-active-inbox-drain",
      makeSessionRecord("chat-active-inbox-drain", { status: "active" }),
    );
    const activeInboxEntry = mockEntry({
      id: 999,
      chatId: "chat-active-inbox-drain",
      messageId: "msg-chat-active-inbox-drain",
    });
    activeInboxInternals.inboxDelivery.receive(activeInboxEntry);
    activeInboxInternals.pendingQueue.push({
      chatId: "chat-active-inbox-drain",
      message: { ...makeMessage("chat-active-inbox-drain"), inboxEntryId: 999 },
      deliveryKind: "fresh",
    });
    activeInboxInternals.routeMessage = vi.fn().mockRejectedValue(new Error("active inbox drain failed"));

    activeInboxInternals.drainPendingQueue();
    await vi.waitFor(() => expect(activeInboxInternals.routeMessage).toHaveBeenCalledTimes(1));
    expect(activeInboxInternals.pendingQueue.some((item) => item.chatId === "chat-active-inbox-drain")).toBe(false);
    await activeInboxManager.shutdown();

    const controlManager = makeManager();
    const controlInternals = internals(controlManager);
    const suspended = makeSessionRecord("chat-control-drain", { status: "suspended" });
    controlInternals.sessions.set("chat-control-drain", suspended);
    controlInternals.pendingQueue.push({
      chatId: "chat-control-drain",
      message: null,
      deliveryKind: "control",
    });
    controlInternals.resumeSession = vi.fn().mockRejectedValue(new Error("control resume failed"));

    controlInternals.drainPendingQueue();
    await vi.waitFor(() =>
      expect(controlInternals.resumeSession).toHaveBeenCalledWith(suspended, undefined, "control"),
    );
    expect(controlInternals.pendingQueue.some((item) => item.chatId === "chat-control-drain")).toBe(true);
    await controlManager.shutdown();
  });

  it("logs retry queued inject failures after a transient retry succeeds", async () => {
    const retryHandler = handler({
      resume: vi.fn().mockResolvedValue("retry-resumed"),
      inject: vi.fn(() => {
        throw new Error("queued inject failed");
      }),
    });
    const sm = makeManager({ handlers: [retryHandler] });
    const retrying = makeSessionRecord("chat-retry-inject-fail", {
      retryAttempt: 1,
      status: "suspended",
      claudeSessionId: "previous-session",
    });
    retrying.deferredMessages.push(makeMessage("chat-retry-inject-fail"));
    internals(sm).sessions.set("chat-retry-inject-fail", retrying);

    await internals(sm).runRetry("chat-retry-inject-fail");

    expect(retryHandler.inject).toHaveBeenCalledTimes(1);
    await sm.shutdown();
  });

  it("evicts idle active sessions with live subprocesses only after no better candidate exists", async () => {
    const subprocessProbe: SubprocessProbe = {
      hasLiveSubprocess: vi.fn((chatId: string) => chatId === "chat-live-subprocess"),
      stop: vi.fn(),
    };
    const sm = makeManager({ maxSessions: 1, subprocessProbe });
    const i = internals(sm);
    i.sessions.set(
      "chat-live-subprocess",
      makeSessionRecord("chat-live-subprocess", {
        status: "active",
        lastActivity: 1,
      }),
    );

    i.evictIfNeeded();

    expect(i.evictedMappings.has("chat-live-subprocess")).toBe(true);
    await sm.shutdown();

    const noCandidate = makeManager({ maxSessions: 1 });
    const noCandidateInternals = internals(noCandidate);
    noCandidateInternals.sessions.set(
      "chat-working-only",
      makeSessionRecord("chat-working-only", {
        status: "active",
        lastActivity: 1,
      }),
    );
    const entry = mockEntry({ id: 503, chatId: "chat-working-only", messageId: "msg-working-only" });
    const decision = noCandidateInternals.inboxDelivery.receive(entry);
    if (decision.kind !== "deliver") throw new Error("expected working delivery");
    noCandidateInternals.inboxDelivery.markOwned(decision.work);
    noCandidateInternals.inboxDelivery.markProcessingStarted("chat-working-only", messageFromEntry(entry));

    noCandidateInternals.evictIfNeeded();

    expect(noCandidateInternals.sessions.has("chat-working-only")).toBe(true);
    await noCandidate.shutdown();
  });
});
