import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentRuntimeConfig,
  InboxEntryWithMessage,
  RuntimeState,
  SessionEvent,
  SessionState,
} from "@first-tree/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentHandler, HandlerFactory, SessionContext, SessionMessage } from "../runtime/handler.js";
import { SessionManager } from "../runtime/session-manager.js";
import type { FirstTreeHubSDK } from "../sdk.js";
import { recordingLogger, silentLogger } from "./_logger-helpers.js";
import { mockEntry } from "./test-helpers.js";

type SessionRecord = {
  chatId: string;
  claudeSessionId: string;
  handler: AgentHandler;
  status: SessionState;
  lastActivity: number;
  suspending: Promise<void> | null;
  retryAttempt: number;
  retryNextAt: number | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  lastRetryReason: string | null;
  startMessage: SessionMessage | null;
  retryFromEvicted: { claudeSessionId: string; lastActivity: number } | null;
};

type SessionManagerInternals = {
  sessions: Map<string, SessionRecord>;
  evictedMappings: Map<string, { claudeSessionId: string; lastActivity: number }>;
  // entryId tracking moved out of PendingMessage and into a per-chat
  // FIFO (`inFlightEntries`) per the in-flight message recovery PR.
  pendingQueue: Array<{ message: SessionMessage; chatId: string }>;
  inFlightEntries: Map<string, number[]>;
  _activeCount: number;
  acquireActiveSlot(chatId: string, message: SessionMessage): boolean;
  routeMessage(chatId: string, message: SessionMessage): Promise<void>;
  resumeSession(entry: SessionRecord, message: SessionMessage | null | undefined): Promise<void>;
  runRetry(chatId: string): Promise<void>;
  triggerImmediateRetry(chatId: string): void;
  drainPendingQueue(): void;
  evictIfNeeded(): void;
  notifySessionState(chatId: string, state: SessionState): void;
  reaffirmRuntimeStates(): void;
  persistRegistry(): void;
  ackInFlightEntries(chatId: string, count: number): void;
  drainAllInFlightEntries(chatId: string): void;
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
    serverUrl: "https://hub.example.test",
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
    inject: vi.fn(),
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
    registryPath?: string;
    concurrency?: number;
    maxSessions?: number;
    sdk?: FirstTreeHubSDK;
    agentConfigCache?: ReturnType<typeof makeCache>;
    onStateChange?: (chatId: string, state: SessionState) => void;
    onRuntimeStateChange?: (state: TestRuntimeState) => void;
    onSessionRuntimeChange?: (chatId: string, state: TestRuntimeState) => void;
    onSessionEvent?: (chatId: string, event: SessionEvent) => void;
    workspaceRoot?: string;
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
    log: silentLogger(),
    registryPath: opts.registryPath,
    agentConfigCache: opts.agentConfigCache,
    ackEntry: opts.ackEntry ?? vi.fn<(entryId: number) => Promise<void>>().mockResolvedValue(undefined),
    onStateChange: opts.onStateChange,
    onRuntimeStateChange: opts.onRuntimeStateChange,
    onSessionRuntimeChange: opts.onSessionRuntimeChange,
    onSessionEvent: opts.onSessionEvent,
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

function makeSessionRecord(chatId: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    chatId,
    claudeSessionId: `session-${chatId}`,
    handler: handler(),
    status: "suspended",
    lastActivity: Date.now(),
    suspending: null,
    retryAttempt: 0,
    retryNextAt: null,
    retryTimer: null,
    lastRetryReason: null,
    startMessage: makeMessage(chatId),
    retryFromEvicted: null,
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("SessionManager edge coverage", () => {
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
        throw new Error("hub unavailable");
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
    const first = handler();
    const ackEntry = vi
      .fn<(entryId: number) => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("ack offline"))
      .mockResolvedValue(undefined);
    const states: Array<{ chatId: string; state: SessionState }> = [];
    const sm = makeManager({
      handlers: [first, handler()],
      ackEntry,
      concurrency: 1,
      onStateChange: (chatId, state) => states.push({ chatId, state }),
    });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-active" }));
    expect(sm.activeCount).toBe(1);
    expect(sm.getQuietGateSnapshot().activeCount).toBe(1);
    expect(sm.getQuietGateSnapshot().lastActivityMs).toBeGreaterThan(0);

    await sm.handleCommand("missing", "session:terminate");
    await sm.handleCommand("chat-active", "session:suspend");
    await sm.dispatch(mockEntry({ id: 2, chatId: "chat-active" }));
    // Post inflight-message-recovery: dispatch defers ack until the
    // handler calls `ctx.markCompleted()` (or session-manager drains on
    // terminate / permanent failure). The entry sits in the per-chat
    // FIFO `inFlightEntries`. Verify that's where it lands.
    expect(internals(sm).inFlightEntries.get("chat-active")).toContain(2);
    expect(ackEntry).not.toHaveBeenCalledWith(2);

    internals(sm).pendingQueue.push({ chatId: "chat-queued", message: makeMessage("chat-queued") });
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
    expect(resumed.resume).toHaveBeenCalledWith(expect.anything(), "persisted-500", expect.anything());

    internals(sm).evictedMappings.set("chat-extra", { claudeSessionId: "evicted-extra", lastActivity: 2_000 });
    internals(sm).persistRegistry();
    await sm.shutdown();

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
        gitRepos: [{ url: "https://github.com/acme/project.git", localPath: "src/project" }],
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
        ctx.touch();
        return "session-context";
      },
    });
    const sm = makeManager({
      handlers: [first],
      sdk,
      workspaceRoot,
      agentConfigCache: cache,
    });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-context" }));
    expect(captured).toBeDefined();
    const ctx = captured;
    if (!ctx) throw new Error("context was not captured");

    const env = ctx.buildAgentEnv({ PATH: "/usr/bin" });
    expect(env.FIRST_TREE_DOC_BASE).toBe(join(workspaceRoot, "src/project"));
    expect(env.FIRST_TREE_DOC_AGENT_HOME).toBe(workspaceRoot);
    expect(env.FIRST_TREE_DOC_REPO_LOCAL_PATH).toBe("src/project");
    expect(env.FIRST_TREE_WORKSPACES_ROOT).toBe(tmpdir());
    expect(env.FIRST_TREE_AGENT_SLUG).toBe(workspaceRoot.split("/").at(-1));

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
    expect(formatted).toContain("[From: helper] prior text");
    expect(formatted).toContain("[From: alice]");
    expect(await ctx.resolveSenderLabel("sender-1")).toBe("alice");

    await ctx.forwardResult("final answer");
    expect(sendMessage).toHaveBeenCalledWith(
      "chat-context",
      expect.objectContaining({ content: "final answer", inReplyTo: "msg-1" }),
    );

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

  it("queues admin resume when no active slot can be acquired", async () => {
    const record = makeSessionRecord("chat-queued-resume", { status: "suspended" });
    const sm = makeManager({ concurrency: 1 });
    internals(sm).sessions.set("chat-queued-resume", record);
    internals(sm)._activeCount = 1;

    await internals(sm).resumeSession(record, null);

    expect(internals(sm).pendingQueue.some((item) => item.chatId === "chat-queued-resume")).toBe(true);
    await sm.shutdown();
  });

  it("covers retry early returns, retry re-queue, empty-message start, resume fallback, and emit failures", async () => {
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
      startMessage: null,
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
      startMessage: makeMessage("chat-retry-transient"),
      lastRetryReason: "rate_limit",
    });
    internals(sm).sessions.set("chat-retry-transient", retrying);
    await internals(sm).runRetry("chat-retry-transient");
    expect(retrying.retryAttempt).toBeGreaterThan(1);

    const failing = makeSessionRecord("chat-retry-permanent", {
      retryAttempt: 1,
      status: "suspended",
      claudeSessionId: "",
      startMessage: makeMessage("chat-retry-permanent"),
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
      startMessage: makeMessage("chat-rearm"),
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
      startMessage: null,
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
      startMessage: makeMessage("chat-retry-again"),
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
      startMessage: makeMessage("chat-retry-from-evicted"),
      lastRetryReason: "rate_limit",
    });
    internals(sm).sessions.set("chat-retry-from-evicted", retrying);

    await internals(sm).runRetry("chat-retry-from-evicted");

    expect(resumeFails.resume).toHaveBeenCalledWith(expect.anything(), "evicted-session", expect.anything());
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

    internals(sm).pendingQueue.push({ chatId: "chat-held", message: makeMessage("chat-held") });
    internals(sm)._activeCount = 1;
    internals(sm).drainPendingQueue();
    expect(internals(sm).pendingQueue.some((item) => item.chatId === "chat-held")).toBe(true);

    internals(sm)._activeCount = 0;
    internals(sm).drainPendingQueue();
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(internals(sm).sessions.has("chat-held")).toBe(true);

    const emptyShift = internals(makeManager());
    emptyShift.pendingQueue.push({ chatId: "chat-empty-shift", message: makeMessage("chat-empty-shift") });
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
    internals(sm).pendingQueue.push({ chatId: "chat-drain", message: makeMessage("chat-drain") });
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

  it("resolves self-fence through forwardResult for success, no-cache, null-trigger, and non-Error failure cases", async () => {
    const cache = makeCache({
      config: runtimeConfig({
        payload: {
          kind: "claude-code",
          prompt: { append: "" },
          model: "opus",
          mcpServers: [],
          env: [],
          gitRepos: [{ url: "https://github.com/acme/project.git", localPath: "project" }],
          reasoningEffort: "",
        },
      }),
    });
    const sdk = mockSdk();
    const sendMessage = vi.mocked(sdk.sendMessage);
    let cachedCtx: SessionContext | undefined;
    const cached = makeManager({
      handlers: [
        handler({
          async start(_message, ctx) {
            cachedCtx = ctx;
            return "cached-context";
          },
        }),
      ],
      sdk,
      agentConfigCache: cache,
    });

    await cached.dispatch(mockEntry({ id: 1, chatId: "chat-cached-fence" }));
    if (!cachedCtx) throw new Error("cached context missing");
    await cachedCtx.forwardResult("first result");
    await cachedCtx.forwardResult("second result");
    expect(sendMessage).toHaveBeenLastCalledWith(
      "chat-cached-fence",
      expect.not.objectContaining({ inReplyTo: expect.any(String) }),
    );
    await cached.shutdown();

    let noCacheCtx: SessionContext | undefined;
    const noCache = makeManager({
      handlers: [
        handler({
          async start(_message, ctx) {
            noCacheCtx = ctx;
            return "no-cache-context";
          },
        }),
      ],
    });
    await noCache.dispatch(mockEntry({ id: 2, chatId: "chat-no-cache-fence" }));
    if (!noCacheCtx) throw new Error("no-cache context missing");
    await noCacheCtx.forwardResult("no cache result");
    await noCache.shutdown();

    let stringFailureCtx: SessionContext | undefined;
    const stringFailure = makeManager({
      handlers: [
        handler({
          async start(_message, ctx) {
            stringFailureCtx = ctx;
            return "string-failure-context";
          },
        }),
      ],
      agentConfigCache: makeCache({
        refreshIfNewer: () => Promise.reject("config missing"),
      }),
    });
    await stringFailure.dispatch(mockEntry({ id: 3, chatId: "chat-string-fence" }));
    if (!stringFailureCtx) throw new Error("string-failure context missing");
    await stringFailureCtx.forwardResult("string failure result");
    await stringFailure.shutdown();
  });

  it("reports runtime snapshots only for active sessions and ignores inactive runtime writes", async () => {
    const runtimeChanges: RuntimeState[] = [];
    let captured: SessionContext | undefined;
    const sm = makeManager({
      handlers: [
        handler({
          async start(_message, ctx) {
            captured = ctx;
            return "runtime-session";
          },
        }),
      ],
      onRuntimeStateChange: (state) => runtimeChanges.push(state),
      onSessionRuntimeChange: vi.fn(),
    });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-runtime" }));
    expect(sm.getSessionRuntimeStates()).toEqual([{ chatId: "chat-runtime", runtimeState: "idle" }]);
    if (!captured) throw new Error("context was not captured");
    await sm.handleCommand("chat-runtime", "session:suspend");
    captured.setRuntimeState("working");
    expect(runtimeChanges).not.toContain("working");

    internals(sm).reaffirmRuntimeStates();
    await sm.shutdown();
  });

  it("uses idle fallback in evictIdle logging when no runtime state was recorded", async () => {
    vi.useFakeTimers({ now: 100_000 });
    const log = recordingLogger();
    const first = handler();
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
    vi.advanceTimersByTime(2_000);

    vi.advanceTimersByTime(10_000);

    expect(log.records.some((entry) => entry.msg === "session idle, suspending" && entry.runtimeState === "idle")).toBe(
      true,
    );
    await sm.shutdown();
  });
});
