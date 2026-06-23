import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@first-tree/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexAppServerRpcError, CodexAppServerTransportError } from "../handlers/codex/app-server/client.js";
import { createCodexAppServerHandler } from "../handlers/codex/app-server/index.js";
import type { DeliveryToken, SessionContext, SessionMessage } from "../runtime/handler.js";
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
  steerDeferred: {
    promise: Promise<unknown>;
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  } | null = null;
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
      if (this.steerDeferred) return this.steerDeferred.promise;
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

  deferNextSteer(): void {
    let resolve: (value: unknown) => void = () => {};
    let reject: (error: Error) => void = () => {};
    const promise = new Promise<unknown>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this.steerDeferred = { promise, resolve, reject };
  }

  resolveSteer(value: unknown = { turnId: "turn-1" }): void {
    this.steerDeferred?.resolve(value);
    this.steerDeferred = null;
  }

  rejectSteer(error: Error): void {
    this.steerDeferred?.reject(error);
    this.steerDeferred = null;
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

function messageIds(messages: SessionMessage | readonly SessionMessage[]): string[] {
  return (Array.isArray(messages) ? messages : [messages]).map((message) => message.id);
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

function makeDeliveryToken(): DeliveryToken {
  return {
    processingStarted: vi.fn<DeliveryToken["processingStarted"]>(),
    complete: vi.fn<DeliveryToken["complete"]>().mockResolvedValue(undefined),
    retry: vi.fn<DeliveryToken["retry"]>(),
    terminalRejected: vi.fn<DeliveryToken["terminalRejected"]>().mockResolvedValue(undefined),
  };
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

function completeEmptyTurn(fake: FakeAppServerClient, turnId: string): void {
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

function failTurn(
  fake: FakeAppServerClient,
  turnId: string,
  error: { message: string; codexErrorInfo?: unknown; additionalDetails?: string | null },
): void {
  fake.emit("turn/completed", {
    threadId: "thread-app-server",
    turn: {
      id: turnId,
      status: "failed",
      items: [],
      error: {
        message: error.message,
        codexErrorInfo: error.codexErrorInfo ?? null,
        additionalDetails: error.additionalDetails ?? null,
      },
    },
  });
}

function activeTurnNotSteerableError(): CodexAppServerRpcError {
  return new CodexAppServerRpcError("turn/steer", {
    code: -32602,
    message: "activeTurnNotSteerable",
    data: { activeTurnNotSteerable: { turnKind: "compact" } },
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
    fake.steerError = activeTurnNotSteerableError();
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

  it("keeps newer injects behind an older no-custody steer until the next turn", async () => {
    const fake = new FakeAppServerClient();
    fake.deferNextSteer();
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

    handler.inject(makeMessage("m3", "third"));
    await flushAsync();

    expect(fake.requests.filter((request) => request.method === "turn/steer")).toHaveLength(1);

    fake.rejectSteer(activeTurnNotSteerableError());
    await flushAsync();

    expect(fake.requests.filter((request) => request.method === "turn/steer")).toHaveLength(1);

    completeTurn(fake, "turn-1", "first done");
    await startPromise;
    await waitFor(() => fake.requests.filter((request) => request.method === "turn/start").length === 2);

    const secondStart = fake.requests.filter((request) => request.method === "turn/start")[1];
    expect(JSON.stringify(secondStart?.params)).toContain("second");
    expect(JSON.stringify(secondStart?.params)).toContain("third");

    completeTurn(fake, "turn-2", "second batch done");
    await waitFor(() => finished.length === 2);

    expect(finished.map((messages) => messages.map((message) => message.id))).toEqual([["m1"], ["m2", "m3"]]);

    await handler.shutdown();
  });

  it("waits for an in-flight steer success before settling a completed turn", async () => {
    const fake = new FakeAppServerClient();
    fake.deferNextSteer();
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

    completeTurn(fake, "turn-1", "final answer");
    await flushAsync();

    expect(finished).toHaveLength(0);

    fake.resolveSteer();
    await startPromise;

    expect(finished.map((messages) => messages.map((message) => message.id))).toEqual([["m1", "m2"]]);

    await handler.shutdown();
  });

  it("keeps in-flight steer no-custody input pending when completion wins the race", async () => {
    const fake = new FakeAppServerClient();
    fake.deferNextSteer();
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
    await flushAsync();

    expect(finished).toHaveLength(0);

    fake.rejectSteer(activeTurnNotSteerableError());
    await startPromise;

    expect(finished.map((messages) => messages.map((message) => message.id))).toEqual([["m1"]]);
    await waitFor(() => fake.requests.filter((request) => request.method === "turn/start").length === 2);

    completeTurn(fake, "turn-2", "second done");
    await waitFor(() => finished.length === 2);

    expect(finished.map((messages) => messages.map((message) => message.id))).toEqual([["m1"], ["m2"]]);

    await handler.shutdown();
  });

  it("fences pending tail when the accepted turn prefix must retry", async () => {
    const fake = new FakeAppServerClient();
    fake.steerError = activeTurnNotSteerableError();
    const retried: Array<{ ids: string[]; reason: string }> = [];
    const failSessionForRecovery = vi.fn<(reason: string, sessionId?: string) => void>();
    const finishTurn = vi.fn<SessionContext["finishTurn"]>();
    const handler = makeHandler(fake);
    const ctx = makeContext({
      finishTurn,
      retryTurn: (messages, reason) => {
        retried.push({ ids: messageIds(messages), reason });
      },
      failSessionForRecovery,
    });

    const startPromise = handler.start(makeMessage("m1", "first"), ctx);
    await waitFor(() => fake.requests.some((request) => request.method === "turn/start"));
    handler.inject(makeMessage("m2", "second"));
    await waitFor(() => fake.requests.some((request) => request.method === "turn/steer"));

    failTurn(fake, "turn-1", { message: "provider failed" });
    await startPromise;
    await flushAsync();

    expect(fake.requests.filter((request) => request.method === "turn/start")).toHaveLength(1);
    expect(finishTurn).not.toHaveBeenCalled();
    expect(retried).toEqual([
      { ids: ["m1"], reason: "codex_unknown_failure" },
      { ids: ["m2"], reason: "codex_unknown_failure" },
    ]);
    expect(failSessionForRecovery).toHaveBeenCalledWith("codex_unknown_failure", "thread-app-server");
    expect(fake.isClosed).toBe(true);

    await handler.shutdown();
  });

  it("terminal-rejects deterministic context-window turn failures instead of retrying delivery", async () => {
    const fake = new FakeAppServerClient();
    const retryTurn = vi.fn<SessionContext["retryTurn"]>();
    const finishTurn = vi.fn<SessionContext["finishTurn"]>();
    const emitEvent = vi.fn<(event: SessionEvent) => void>();
    const token = makeDeliveryToken();
    const handler = makeHandler(fake);
    const ctx = makeContext({ retryTurn, finishTurn, emitEvent });
    const message = makeMessage("m1", "first");

    const startPromise = handler.start(message, ctx, token);
    await waitFor(() => fake.requests.some((request) => request.method === "turn/start"));

    failTurn(fake, "turn-1", {
      message:
        "Error running remote compact task: Codex ran out of room in the model's context window. Start a new thread.",
      codexErrorInfo: "contextWindowExceeded",
    });
    await startPromise;

    expect(token.terminalRejected).toHaveBeenCalledWith([message], "codex_context_window_exceeded", {
      kind: "server_terminal_record",
      recordId: "turn-1",
    });
    expect(token.retry).not.toHaveBeenCalled();
    expect(token.complete).not.toHaveBeenCalled();
    expect(retryTurn).not.toHaveBeenCalled();
    expect(finishTurn).not.toHaveBeenCalled();
    expect(
      emitEvent.mock.calls.some(
        ([event]) =>
          event.kind === "error" &&
          event.payload.source === "sdk" &&
          event.payload.message.includes("Codex ran out of room"),
      ),
    ).toBe(true);
    expect(emitEvent).toHaveBeenCalledWith({ kind: "turn_end", payload: { status: "error" } });

    await handler.shutdown();
  });

  it("terminal-rejects stderr-only remote compact context-window failures", async () => {
    const fake = new FakeAppServerClient();
    const retryTurn = vi.fn<SessionContext["retryTurn"]>();
    const token = makeDeliveryToken();
    const handler = makeHandler(fake);
    const ctx = makeContext({ retryTurn });
    const message = makeMessage("m1", "first");

    const startPromise = handler.start(message, ctx, token);
    await waitFor(() => fake.requests.some((request) => request.method === "turn/start"));

    fake.close(
      "codex app-server exited signal SIGTERM. stderr: Failed to run pre-sampling compact\n" +
        "Error running remote compact task: Codex ran out of room in the model's context window.",
    );
    await startPromise;

    expect(token.terminalRejected).toHaveBeenCalledWith([message], "codex_context_window_exceeded", {
      kind: "server_terminal_record",
      recordId: "turn-1",
    });
    expect(token.retry).not.toHaveBeenCalled();
    expect(retryTurn).not.toHaveBeenCalled();

    await handler.shutdown();
  });

  it("uses prior sdk compact errors to classify a later compact transport close", async () => {
    const fake = new FakeAppServerClient();
    const retryTurn = vi.fn<SessionContext["retryTurn"]>();
    const token = makeDeliveryToken();
    const handler = makeHandler(fake);
    const ctx = makeContext({ retryTurn });
    const message = makeMessage("m1", "first");

    const startPromise = handler.start(message, ctx, token);
    await waitFor(() => fake.requests.some((request) => request.method === "turn/start"));

    fake.emit("error", {
      threadId: "thread-app-server",
      turnId: "turn-1",
      error: {
        message:
          "Error running remote compact task: Codex ran out of room in the model's context window. Start a new thread.",
        codexErrorInfo: null,
        additionalDetails: null,
      },
    });
    fake.close("codex app-server exited signal SIGTERM. stderr: Failed to run pre-sampling compact");
    await startPromise;

    expect(token.terminalRejected).toHaveBeenCalledWith([message], "codex_context_window_exceeded", {
      kind: "server_terminal_record",
      recordId: "turn-1",
    });
    expect(token.retry).not.toHaveBeenCalled();
    expect(retryTurn).not.toHaveBeenCalled();

    await handler.shutdown();
  });

  it("terminal-rejects completed empty turns when stderr reports pre-sampling compact failure", async () => {
    const fake = new FakeAppServerClient();
    fake.stderr = "2026-06-22T03:02:58Z ERROR codex_core::session::turn: Failed to run pre-sampling compact";
    const retryTurn = vi.fn<SessionContext["retryTurn"]>();
    const finishTurn = vi.fn<SessionContext["finishTurn"]>();
    const emitEvent = vi.fn<(event: SessionEvent) => void>();
    const token = makeDeliveryToken();
    const handler = makeHandler(fake);
    const ctx = makeContext({ retryTurn, finishTurn, emitEvent });
    const message = makeMessage("m1", "first");

    const startPromise = handler.start(message, ctx, token);
    await waitFor(() => fake.requests.some((request) => request.method === "turn/start"));

    completeEmptyTurn(fake, "turn-1");
    await startPromise;

    expect(token.terminalRejected).toHaveBeenCalledWith([message], "codex_compact_failure", {
      kind: "server_terminal_record",
      recordId: "turn-1",
    });
    expect(token.retry).not.toHaveBeenCalled();
    expect(token.complete).not.toHaveBeenCalled();
    expect(retryTurn).not.toHaveBeenCalled();
    expect(finishTurn).not.toHaveBeenCalled();
    expect(
      emitEvent.mock.calls.some(
        ([event]) =>
          event.kind === "error" &&
          event.payload.source === "sdk" &&
          event.payload.message.includes("failed to compact this thread"),
      ),
    ).toBe(true);

    await handler.shutdown();
  });

  it("keeps completed empty turns without compact diagnostics as successful silence", async () => {
    const fake = new FakeAppServerClient();
    const token = makeDeliveryToken();
    const handler = makeHandler(fake);
    const ctx = makeContext();
    const message = makeMessage("m1", "first");

    const startPromise = handler.start(message, ctx, token);
    await waitFor(() => fake.requests.some((request) => request.method === "turn/start"));

    completeEmptyTurn(fake, "turn-1");
    await startPromise;

    expect(token.complete).toHaveBeenCalledWith([message], { status: "success", terminal: true });
    expect(token.terminalRejected).not.toHaveBeenCalled();
    expect(token.retry).not.toHaveBeenCalled();

    await handler.shutdown();
  });

  it("keeps transient app-server turn failures retryable", async () => {
    const fake = new FakeAppServerClient();
    const token = makeDeliveryToken();
    const handler = makeHandler(fake);
    const ctx = makeContext();
    const message = makeMessage("m1", "first");

    const startPromise = handler.start(message, ctx, token);
    await waitFor(() => fake.requests.some((request) => request.method === "turn/start"));

    failTurn(fake, "turn-1", {
      message: "server overloaded",
      codexErrorInfo: "serverOverloaded",
    });
    await startPromise;

    expect(token.retry).toHaveBeenCalledWith([message], "codex_transient_failure");
    expect(token.terminalRejected).not.toHaveBeenCalled();
    expect(token.complete).not.toHaveBeenCalled();

    await handler.shutdown();
  });

  it("does not classify ordinary transport close text as deterministic", async () => {
    const fake = new FakeAppServerClient();
    const token = makeDeliveryToken();
    const handler = makeHandler(fake);
    const ctx = makeContext();
    const message = makeMessage("m1", "first");

    const startPromise = handler.start(message, ctx, token);
    await waitFor(() => fake.requests.some((request) => request.method === "turn/start"));

    fake.close("transport is closed");
    await startPromise;

    expect(token.retry).toHaveBeenCalledWith([message], "codex_unknown_failure");
    expect(token.terminalRejected).not.toHaveBeenCalled();
    expect(token.complete).not.toHaveBeenCalled();

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

describe("codex app-server briefing-update notice", () => {
  it("prepends a re-read notice on resume when the session has no recorded briefing baseline", async () => {
    const fake = new FakeAppServerClient();
    const handler = makeHandler(fake);
    const ctx = makeContext({ finishTurn: async () => {} });

    const resumePromise = handler.resume(makeMessage("m1", "hello"), "thread-app-server", ctx);
    await waitFor(() => fake.requests.some((request) => request.method === "turn/start"));

    const start = fake.requests.find((request) => request.method === "turn/start");
    const input = JSON.stringify(start?.params ?? {});
    expect(input).toContain("<system-reminder>");
    expect(input).toContain("re-read");

    completeTurn(fake, "turn-1", "ok");
    await resumePromise;
    await handler.shutdown();
  });

  it("adds no notice when the briefing is unchanged since the session last ran a turn", async () => {
    // First session start seeds the briefing baseline for this thread id at the
    // shared agent home (keyed off `workspaceRoot`).
    const startFake = new FakeAppServerClient();
    const startHandler = makeHandler(startFake);
    const startCtx = makeContext({ finishTurn: async () => {} });
    const startPromise = startHandler.start(makeMessage("m1", "first"), startCtx);
    await waitFor(() => startFake.requests.some((request) => request.method === "turn/start"));
    completeTurn(startFake, "turn-1", "first answer");
    await startPromise;
    await startHandler.shutdown();

    // A later resume of the same thread, same config (briefing unchanged) →
    // baseline matches → no re-read notice.
    const resumeFake = new FakeAppServerClient();
    const resumeHandler = makeHandler(resumeFake);
    const resumeCtx = makeContext({ finishTurn: async () => {} });
    const resumePromise = resumeHandler.resume(makeMessage("m2", "again"), "thread-app-server", resumeCtx);
    await waitFor(() => resumeFake.requests.some((request) => request.method === "turn/start"));

    const start = resumeFake.requests.find((request) => request.method === "turn/start");
    expect(JSON.stringify(start?.params ?? {})).not.toContain("<system-reminder>");

    completeTurn(resumeFake, "turn-1", "second answer");
    await resumePromise;
    await resumeHandler.shutdown();
  });

  it("keeps the notice for the next resume when the turn fails before reaching the provider", async () => {
    // First resume hits a pre-provider turn/start failure: the notice was
    // consumed for that attempt but the model never saw it, so the baseline
    // must NOT advance.
    const failFake = new FakeAppServerClient();
    failFake.turnStartError = new CodexAppServerTransportError("codex app-server request timed out: turn/start");
    const failHandler = makeHandler(failFake);
    const failCtx = makeContext({ failSessionForRecovery: vi.fn(), finishTurn: async () => {} });
    await failHandler.resume(makeMessage("m1", "hello"), "thread-app-server", failCtx);
    expect(failFake.requests.some((request) => request.method === "turn/start")).toBe(true);
    await failHandler.shutdown();

    // Second resume of the same thread: baseline was never recorded, so the
    // briefing still reads as changed and the re-read notice reappears.
    const okFake = new FakeAppServerClient();
    const okHandler = makeHandler(okFake);
    const okCtx = makeContext({ finishTurn: async () => {} });
    const resumePromise = okHandler.resume(makeMessage("m2", "again"), "thread-app-server", okCtx);
    await waitFor(() => okFake.requests.some((request) => request.method === "turn/start"));
    const start = okFake.requests.find((request) => request.method === "turn/start");
    expect(JSON.stringify(start?.params ?? {})).toContain("<system-reminder>");

    completeTurn(okFake, "turn-1", "ok");
    await resumePromise;
    await okHandler.shutdown();
  });
});
