import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@first-tree/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCodexAppServerHandler } from "../handlers/codex-app-server/index.js";
import { CodexAppServerRpcError, CodexAppServerTransportError } from "../runtime/codex-app-server-client.js";
import type { SessionContext, SessionMessage } from "../runtime/handler.js";
import { mockCtxPlumbing } from "./test-helpers.js";

vi.mock("../runtime/bootstrap.js", () => ({
  FIRST_TREE_RUNTIME_DIR: ".first-tree-workspace",
  FIRST_TREE_WORKSPACE_MARKER: ".first-tree-workspace",
  IDENTITY_JSON_REL: join(".first-tree-workspace", "identity.json"),
  bootstrapWorkspace: vi.fn(),
  deepEqualIdentity: vi.fn(() => true),
  ensureWorkspaceRuntimeDir: vi.fn((workspacePath: string) => {
    const dir = join(workspacePath, ".first-tree-workspace");
    mkdirSync(dir, { recursive: true });
    return dir;
  }),
  installCoreSkills: vi.fn(),
  installFirstTreeIntegration: vi.fn(() => true),
  isHubWorktreeMarker: vi.fn(() => false),
  readCachedBundledCliVersion: vi.fn(() => null),
  readCachedContextTreeHead: vi.fn(() => null),
  readContextTreeHead: vi.fn(() => null),
  resolveBundledCliVersion: vi.fn(() => "0.0.0-test"),
  writeAgentBriefing: vi.fn(),
  writeBundledCliVersion: vi.fn(),
  writeContextTreeHead: vi.fn(),
}));

vi.mock("../runtime/chat-context.js", () => ({
  fetchChatContext: vi.fn(async () => ({
    chatId: "chat-app-server",
    title: "app server",
    topic: null,
    description: null,
    participants: [],
  })),
}));

const AGENT_ID = "019e71c9-88d2-70be-be67-fdb033b2ef0b";

type FakeRequest = {
  method: string;
  params: unknown;
};

type NotificationHandler = (notification: { method: string; params?: unknown }) => void;
type CloseHandler = (error: CodexAppServerTransportError) => void;

class FakeAppServerClient {
  readonly requests: FakeRequest[] = [];
  stderr = "";
  isClosed = false;
  onNotification: NotificationHandler | null = null;
  onClose: CloseHandler | null = null;
  steerError: Error | null = null;
  turnStartError: Error | null = null;
  threadStartDeferred: { promise: Promise<unknown>; resolve: (value: unknown) => void } | null = null;
  turnCounter = 0;

  async request(method: string, params?: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    if (method === "thread/start") {
      if (this.threadStartDeferred) return this.threadStartDeferred.promise;
      return { thread: { id: "thread-app-server" } };
    }
    if (method === "thread/resume") {
      return { thread: { id: "thread-app-server" } };
    }
    if (method === "turn/start") {
      if (this.turnStartError) throw this.turnStartError;
      this.turnCounter += 1;
      return {
        turn: {
          id: `turn-${this.turnCounter}`,
          status: "inProgress",
          items: [],
          error: null,
        },
      };
    }
    if (method === "turn/steer") {
      if (this.steerError) throw this.steerError;
      return { turnId: "turn-1" };
    }
    if (method === "turn/interrupt") {
      return {};
    }
    return {};
  }

  notify(): void {}

  shutdown(): void {
    this.isClosed = true;
  }

  deferThreadStart(): void {
    let resolve: (value: unknown) => void = () => {};
    const promise = new Promise<unknown>((r) => {
      resolve = r;
    });
    this.threadStartDeferred = { promise, resolve };
  }

  resolveThreadStart(): void {
    this.threadStartDeferred?.resolve({ thread: { id: "thread-app-server" } });
    this.threadStartDeferred = null;
  }

  emit(method: string, params?: unknown): void {
    this.onNotification?.({ method, params });
  }

  close(message = "app-server died"): void {
    this.onClose?.(new CodexAppServerTransportError(message));
  }
}

let workspaceRoot: string;

function makeMessage(id: string, content: string): SessionMessage {
  return {
    id,
    chatId: "chat-app-server",
    senderId: "sender-1",
    format: "text",
    content,
    metadata: {},
  };
}

function makeContext(
  opts: {
    finishTurn?: SessionContext["finishTurn"];
    retryTurn?: SessionContext["retryTurn"];
    failSessionForRecovery?: SessionContext["failSessionForRecovery"];
    emitEvent?: SessionContext["emitEvent"];
    formatInboundContent?: SessionContext["formatInboundContent"];
    sendMessage?: ReturnType<typeof vi.fn<(chatId: string, body: Record<string, unknown>) => Promise<unknown>>>;
  } = {},
): SessionContext {
  const sendMessage =
    opts.sendMessage ??
    vi.fn<(chatId: string, body: Record<string, unknown>) => Promise<unknown>>().mockResolvedValue(undefined);
  return {
    agent: {
      agentId: AGENT_ID,
      inboxId: `inbox_${AGENT_ID}`,
      displayName: "codex-assistant",
      type: "agent",
      visibility: "organization",
      delegateMention: null,
      metadata: {},
    },
    sdk: { serverUrl: "http://test", sendMessage } as unknown as SessionContext["sdk"],
    chatId: "chat-app-server",
    log: () => {},
    recordProviderActivity: () => {},
    emitEvent: opts.emitEvent ?? (() => {}),
    ...mockCtxPlumbing({ sendMessage }, "chat-app-server"),
    ...(opts.finishTurn ? { finishTurn: opts.finishTurn } : {}),
    ...(opts.retryTurn ? { retryTurn: opts.retryTurn } : {}),
    ...(opts.failSessionForRecovery ? { failSessionForRecovery: opts.failSessionForRecovery } : {}),
    ...(opts.formatInboundContent ? { formatInboundContent: opts.formatInboundContent } : {}),
  };
}

function makeHandler(fake: FakeAppServerClient) {
  return createCodexAppServerHandler({
    workspaceRoot,
    codexRuntimeBinaryResolver: async () => ({
      ok: true,
      binary: "/tmp/fake-codex",
      runtimeSource: "path",
      runtimePath: "/tmp/fake-codex",
      version: "0.0.0-test",
    }),
    codexAppServerClientFactory: async (options: { onNotification?: NotificationHandler; onClose?: CloseHandler }) => {
      fake.onNotification = options.onNotification ?? null;
      fake.onClose = options.onClose ?? null;
      return fake;
    },
  });
}

async function waitFor(assertion: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!assertion()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for assertion");
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function completeTurn(fake: FakeAppServerClient, turnId: string, text: string): void {
  fake.emit("thread/tokenUsage/updated", {
    threadId: "thread-app-server",
    turnId,
    tokenUsage: {
      last: {
        totalTokens: 3,
        inputTokens: 2,
        cachedInputTokens: 0,
        outputTokens: 1,
        reasoningOutputTokens: 0,
      },
      total: {
        totalTokens: 3,
        inputTokens: 2,
        cachedInputTokens: 0,
        outputTokens: 1,
        reasoningOutputTokens: 0,
      },
      modelContextWindow: null,
    },
  });
  fake.emit("item/completed", {
    threadId: "thread-app-server",
    turnId,
    item: { type: "agentMessage", id: `item-${turnId}`, text, phase: null, memoryCitation: null },
  });
  fake.emit("turn/completed", {
    threadId: "thread-app-server",
    turn: {
      id: turnId,
      status: "completed",
      items: [],
      error: null,
    },
  });
}

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "ft-codex-app-server-"));
});

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});

describe("codex app-server handler", () => {
  it("steers active-turn injects and acks the injected message with the current turn", async () => {
    const fake = new FakeAppServerClient();
    const finished: SessionMessage[][] = [];
    const emitEvent = vi.fn<(event: SessionEvent) => void>();
    const handler = makeHandler(fake);
    const ctx = makeContext({
      emitEvent,
      finishTurn: async (messages) => {
        finished.push(Array.isArray(messages) ? [...messages] : [messages]);
      },
    });

    const startPromise = handler.start(makeMessage("m1", "first"), ctx);
    await waitFor(() => fake.requests.some((request) => request.method === "turn/start"));

    handler.inject(makeMessage("m2", "second"));
    await waitFor(() => fake.requests.some((request) => request.method === "turn/steer"));

    const steer = fake.requests.find((request) => request.method === "turn/steer");
    expect(steer?.params).toMatchObject({ threadId: "thread-app-server", expectedTurnId: "turn-1" });

    completeTurn(fake, "turn-1", "final answer");
    await startPromise;

    expect(finished.map((messages) => messages.map((message) => message.id))).toEqual([["m1", "m2"]]);
    expect(emitEvent.mock.calls.some(([event]) => event.kind === "token_usage")).toBe(true);

    await handler.shutdown();
  });

  it("keeps startup injects queued until the first turn can steer them", async () => {
    const fake = new FakeAppServerClient();
    fake.deferThreadStart();
    const finished: SessionMessage[][] = [];
    const retryTurn = vi.fn<SessionContext["retryTurn"]>();
    const handler = makeHandler(fake);
    const ctx = makeContext({
      retryTurn,
      finishTurn: async (messages) => {
        finished.push(Array.isArray(messages) ? [...messages] : [messages]);
      },
    });

    const startPromise = handler.start(makeMessage("m1", "first"), ctx);
    await waitFor(() => fake.requests.some((request) => request.method === "thread/start"));

    handler.inject(makeMessage("m2", "second"));
    await flushAsync();

    expect(retryTurn).not.toHaveBeenCalled();
    expect(fake.requests.some((request) => request.method === "turn/start")).toBe(false);
    expect(fake.requests.some((request) => request.method === "turn/steer")).toBe(false);

    fake.resolveThreadStart();
    await waitFor(() => fake.requests.some((request) => request.method === "turn/start"));
    await waitFor(() => fake.requests.some((request) => request.method === "turn/steer"));

    completeTurn(fake, "turn-1", "final answer");
    await startPromise;

    expect(retryTurn).not.toHaveBeenCalled();
    expect(finished.map((messages) => messages.map((message) => message.id))).toEqual([["m1", "m2"]]);

    await handler.shutdown();
  });

  it("falls stale/non-steerable injects back to the next turn", async () => {
    const fake = new FakeAppServerClient();
    fake.steerError = new CodexAppServerRpcError("turn/steer", {
      code: -32602,
      message: "activeTurnNotSteerable",
      data: { activeTurnNotSteerable: { turnKind: "compact" } },
    });
    const finished: SessionMessage[][] = [];
    const handler = makeHandler(fake);
    const ctx = makeContext({
      finishTurn: async (messages) => {
        finished.push(Array.isArray(messages) ? [...messages] : [messages]);
      },
    });

    const startPromise = handler.start(makeMessage("m1", "first"), ctx);
    await waitFor(() => fake.requests.some((request) => request.method === "turn/start"));
    handler.inject(makeMessage("m2", "second"));
    await waitFor(() => fake.requests.some((request) => request.method === "turn/steer"));

    completeTurn(fake, "turn-1", "first done");
    await waitFor(() => fake.requests.filter((request) => request.method === "turn/start").length === 2);
    completeTurn(fake, "turn-2", "second done");
    await startPromise;
    await waitFor(() => finished.length === 2);

    expect(finished.map((messages) => messages.map((message) => message.id))).toEqual([["m1"], ["m2"]]);

    await handler.shutdown();
  });

  it("retries accepted messages when app-server crashes before turn terminal", async () => {
    const fake = new FakeAppServerClient();
    const retryTurn = vi.fn<SessionContext["retryTurn"]>();
    const finishTurn = vi.fn<SessionContext["finishTurn"]>();
    const handler = makeHandler(fake);
    const ctx = makeContext({ retryTurn, finishTurn });

    const startPromise = handler.start(makeMessage("m1", "first"), ctx);
    await waitFor(() => fake.requests.some((request) => request.method === "turn/start"));
    handler.inject(makeMessage("m2", "second"));
    await waitFor(() => fake.requests.some((request) => request.method === "turn/steer"));

    fake.close();
    await startPromise;

    expect(finishTurn).not.toHaveBeenCalled();
    expect(retryTurn).toHaveBeenCalledWith(
      [makeMessage("m1", "first"), makeMessage("m2", "second")],
      "codex_unknown_failure",
    );

    await handler.shutdown();
  });

  it("closes app-server and retries the batch when turn/start times out after sending input", async () => {
    const fake = new FakeAppServerClient();
    fake.turnStartError = new CodexAppServerTransportError("codex app-server request timed out: turn/start");
    const retryTurn = vi.fn<SessionContext["retryTurn"]>();
    const failSessionForRecovery = vi.fn<(reason: string, sessionId?: string) => void>();
    const finishTurn = vi.fn<SessionContext["finishTurn"]>();
    const sendMessage = vi
      .fn<(chatId: string, body: Record<string, unknown>) => Promise<unknown>>()
      .mockResolvedValue(undefined);
    const handler = makeHandler(fake);
    const ctx = makeContext({ retryTurn, finishTurn, failSessionForRecovery, sendMessage });

    await handler.start(makeMessage("m1", "first"), ctx);

    expect(fake.isClosed).toBe(true);
    expect(retryTurn).toHaveBeenCalledWith(
      [makeMessage("m1", "first")],
      "codex_app_server_turn_start_unknown_custody_transient",
    );
    expect(failSessionForRecovery).toHaveBeenCalledWith(
      "codex_app_server_turn_start_unknown_custody_transient",
      "thread-app-server",
    );
    expect(finishTurn).not.toHaveBeenCalled();

    completeTurn(fake, "turn-1", "late final");
    await flushAsync();

    expect(sendMessage).not.toHaveBeenCalled();
    expect(finishTurn).not.toHaveBeenCalled();

    await handler.shutdown();
  });

  it("closes app-server and retries accepted plus injected messages when turn/steer times out", async () => {
    const fake = new FakeAppServerClient();
    fake.steerError = new CodexAppServerTransportError("codex app-server request timed out: turn/steer");
    const retryTurn = vi.fn<SessionContext["retryTurn"]>();
    const failSessionForRecovery = vi.fn<(reason: string, sessionId?: string) => void>();
    const finishTurn = vi.fn<SessionContext["finishTurn"]>();
    const sendMessage = vi
      .fn<(chatId: string, body: Record<string, unknown>) => Promise<unknown>>()
      .mockResolvedValue(undefined);
    const handler = makeHandler(fake);
    const ctx = makeContext({ retryTurn, finishTurn, failSessionForRecovery, sendMessage });

    const startPromise = handler.start(makeMessage("m1", "first"), ctx);
    await waitFor(() => fake.requests.some((request) => request.method === "turn/start"));
    handler.inject(makeMessage("m2", "second"));
    await waitFor(() => fake.requests.some((request) => request.method === "turn/steer"));
    await startPromise;

    expect(fake.isClosed).toBe(true);
    expect(retryTurn).toHaveBeenCalledWith(
      [makeMessage("m1", "first"), makeMessage("m2", "second")],
      "codex_app_server_steer_unknown_custody_transient",
    );
    expect(failSessionForRecovery).toHaveBeenCalledWith(
      "codex_app_server_steer_unknown_custody_transient",
      "thread-app-server",
    );
    expect(finishTurn).not.toHaveBeenCalled();

    completeTurn(fake, "turn-1", "late final");
    await flushAsync();

    expect(sendMessage).not.toHaveBeenCalled();
    expect(finishTurn).not.toHaveBeenCalled();

    await handler.shutdown();
  });
});
