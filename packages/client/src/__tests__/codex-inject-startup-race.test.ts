import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@first-tree/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatContext } from "../runtime/chat-context.js";
import type { SessionContext, SessionMessage } from "../runtime/handler.js";
import { mockCtxPlumbing } from "./test-helpers.js";

const state = vi.hoisted(() => ({
  chatContextPromise: null as Promise<ChatContext> | null,
  resolveChatContext: null as ((value: ChatContext) => void) | null,
  runInputs: [] as unknown[],
  agentMessagesByTurn: new Map<number, string[]>(),
  failureByTurn: new Map<number, string>(),
  streamErrorByTurn: new Map<number, string>(),
  diagnosticAfterFirstMessageByTurn: new Map<number, string>(),
}));

vi.mock("@openai/codex-sdk", () => {
  const usage = {
    input_tokens: 1,
    cached_input_tokens: 0,
    output_tokens: 1,
    reasoning_output_tokens: 0,
  };

  const thread = {
    id: "thread-test",
    async runStreamed(input: unknown) {
      state.runInputs.push(input);
      const turn = state.runInputs.length;
      return {
        events: (async function* () {
          yield { type: "thread.started", thread_id: "thread-test" };
          const messages = state.agentMessagesByTurn.get(turn) ?? [`reply ${turn}`];
          const diagnosticAfterFirstMessage = state.diagnosticAfterFirstMessageByTurn.get(turn);
          for (const [index, text] of messages.entries()) {
            yield { type: "item.completed", item: { type: "agent_message", text } };
            if (index === 0 && diagnosticAfterFirstMessage) {
              yield { type: "error", message: diagnosticAfterFirstMessage };
            }
          }
          const failure = state.failureByTurn.get(turn);
          if (failure) {
            yield { type: "turn.failed", error: { message: failure } };
            return;
          }
          const streamError = state.streamErrorByTurn.get(turn);
          if (streamError) {
            yield { type: "error", message: streamError };
            return;
          }
          yield { type: "turn.completed", usage };
        })(),
      };
    },
  };

  return {
    Codex: class {
      startThread() {
        return thread;
      }
      resumeThread() {
        return thread;
      }
    },
  };
});

vi.mock("../runtime/bootstrap.js", () => ({
  FIRST_TREE_RUNTIME_DIR: ".first-tree-workspace",
  FIRST_TREE_WORKSPACE_MARKER: ".first-tree-workspace",
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
  fetchChatContext: vi.fn(async () => {
    if (!state.chatContextPromise) throw new Error("chat context gate was not initialised");
    return state.chatContextPromise;
  }),
}));

import { createCodexHandler } from "../handlers/codex.js";

const AGENT_ID = "019e71c9-88d2-70be-be67-fdb033b2ef0b";

let workspaceRoot: string;

function makeMessage(id: string, content: string): SessionMessage {
  return {
    id,
    chatId: "chat-startup-race",
    senderId: "sender-1",
    format: "text",
    content,
    metadata: {},
  };
}

type SendMessageMock = ReturnType<typeof vi.fn<(chatId: string, body: Record<string, unknown>) => Promise<unknown>>>;

function makeContext(
  onFinishTurn: (count?: number) => void,
  opts: {
    sendMessage?: SendMessageMock;
    emitEvent?: SessionContext["emitEvent"];
    formatInboundContent?: SessionContext["formatInboundContent"];
    retryTurn?: SessionContext["retryTurn"];
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
    chatId: "chat-startup-race",
    log: () => {},
    recordProviderActivity: () => {},
    emitEvent: opts.emitEvent ?? (() => {}),
    ...mockCtxPlumbing({ sendMessage }, "chat-startup-race"),
    ...(opts.formatInboundContent ? { formatInboundContent: opts.formatInboundContent } : {}),
    ...(opts.retryTurn ? { retryTurn: opts.retryTurn } : {}),
    finishTurn: async (messages) => {
      onFinishTurn(Array.isArray(messages) ? messages.length : 1);
    },
  };
}

async function waitFor(assertion: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!assertion()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for assertion");
    await new Promise((resolve) => setImmediate(resolve));
  }
}

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "ft-codex-startup-race-"));
  state.runInputs.length = 0;
  state.agentMessagesByTurn.clear();
  state.failureByTurn.clear();
  state.streamErrorByTurn.clear();
  state.diagnosticAfterFirstMessageByTurn.clear();
  state.chatContextPromise = new Promise((resolve) => {
    state.resolveChatContext = resolve;
  });
});

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
  state.chatContextPromise = null;
  state.resolveChatContext = null;
});

describe("codex handler startup inject queue", () => {
  it("queues injects received before the Codex thread exists so their inbox entries stay aligned with acks", async () => {
    const completedCounts: Array<number | undefined> = [];
    const handler = createCodexHandler({ workspaceRoot });
    const ctx = makeContext((count) => {
      completedCounts.push(count);
    });

    const startPromise = handler.start(makeMessage("m1", "first"), ctx);
    await Promise.resolve();

    // The handler is active, but startup is still waiting on chat context;
    // `thread` and `currentTurnPromise` do not exist yet.
    handler.inject(makeMessage("m2", "second"));

    state.resolveChatContext?.({
      chatId: "chat-startup-race",
      title: "startup race",
      topic: null,
      description: null,
      participants: [],
    });

    await startPromise;
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(state.runInputs).toHaveLength(2);
    expect(String(state.runInputs[0])).toContain("first");
    expect(String(state.runInputs[1])).toContain("second");
    expect(completedCounts).toEqual([1, 1]);

    await handler.shutdown();
  });

  it("serializes ready-state injects through one drainer instead of starting parallel turns", async () => {
    const completedCounts: Array<number | undefined> = [];
    const handler = createCodexHandler({ workspaceRoot });
    const ctx = makeContext((count) => {
      completedCounts.push(count);
    });

    state.resolveChatContext?.({
      chatId: "chat-startup-race",
      title: "startup race",
      topic: null,
      description: null,
      participants: [],
    });

    await handler.start(makeMessage("m1", "first"), ctx);

    handler.inject(makeMessage("m2", "second"));
    handler.inject(makeMessage("m3", "third"));

    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(state.runInputs).toHaveLength(2);
    expect(String(state.runInputs[1])).toContain("second");
    expect(String(state.runInputs[1])).toContain("third");
    expect(completedCounts).toEqual([1, 2]);

    await handler.shutdown();
  });

  it("forwards only the latest Codex agent_message as the final response", async () => {
    const sendMessage = vi
      .fn<(chatId: string, body: Record<string, unknown>) => Promise<unknown>>()
      .mockResolvedValue(undefined);
    const emitEvent = vi.fn<(event: SessionEvent) => void>();
    const handler = createCodexHandler({ workspaceRoot });
    const ctx = makeContext(() => {}, { sendMessage, emitEvent });

    state.agentMessagesByTurn.set(1, ["working note", "final answer"]);
    state.resolveChatContext?.({
      chatId: "chat-startup-race",
      title: "startup race",
      topic: null,
      description: null,
      participants: [],
    });

    await handler.start(makeMessage("m1", "first"), ctx);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[1].content).toBe("final answer");
    expect(
      emitEvent.mock.calls
        .map(([event]) => (event.kind === "assistant_text" ? event.payload.text : null))
        .filter((text): text is string => typeof text === "string"),
    ).toEqual(["working note", "final answer"]);

    await handler.shutdown();
  });

  it("treats a stream error followed by final and turn.completed as success with diagnostics", async () => {
    const sendMessage = vi
      .fn<(chatId: string, body: Record<string, unknown>) => Promise<unknown>>()
      .mockResolvedValue(undefined);
    const emitEvent = vi.fn<(event: SessionEvent) => void>();
    const completedCounts: Array<number | undefined> = [];
    const handler = createCodexHandler({ workspaceRoot });
    const ctx = makeContext((count) => completedCounts.push(count), { sendMessage, emitEvent });

    state.agentMessagesByTurn.set(1, ["working note", "final answer"]);
    state.diagnosticAfterFirstMessageByTurn.set(1, "Reconnecting... 2/5 (request timed out)");
    state.resolveChatContext?.({
      chatId: "chat-startup-race",
      title: "startup race",
      topic: null,
      description: null,
      participants: [],
    });

    await handler.start(makeMessage("m1", "first"), ctx);

    const events = emitEvent.mock.calls.map(([event]) => event);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[1].content).toBe("final answer");
    expect(
      events.some(
        (event) =>
          event.kind === "error" &&
          event.payload.source === "sdk" &&
          event.payload.message.includes("Reconnecting... 2/5"),
      ),
    ).toBe(true);
    expect(events.some((event) => event.kind === "turn_end" && event.payload.status === "success")).toBe(true);
    expect(completedCounts).toEqual([1]);

    await handler.shutdown();
  });

  it("does not forward partial Codex text when the turn later fails", async () => {
    const sendMessage = vi
      .fn<(chatId: string, body: Record<string, unknown>) => Promise<unknown>>()
      .mockResolvedValue(undefined);
    const emitEvent = vi.fn<(event: SessionEvent) => void>();
    const completedCounts: Array<number | undefined> = [];
    const retryTurn = vi.fn<SessionContext["retryTurn"]>();
    const handler = createCodexHandler({ workspaceRoot });
    const ctx = makeContext((count) => completedCounts.push(count), { sendMessage, emitEvent, retryTurn });

    state.agentMessagesByTurn.set(1, ["working note"]);
    state.failureByTurn.set(1, "codex failed");
    state.resolveChatContext?.({
      chatId: "chat-startup-race",
      title: "startup race",
      topic: null,
      description: null,
      participants: [],
    });

    await handler.start(makeMessage("m1", "first"), ctx);

    const events = emitEvent.mock.calls.map(([event]) => event);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(
      events.some(
        (event) => event.kind === "error" && event.payload.source === "sdk" && event.payload.message === "codex failed",
      ),
    ).toBe(true);
    expect(events.some((event) => event.kind === "turn_end" && event.payload.status === "error")).toBe(true);
    expect(completedCounts).toEqual([]);
    expect(retryTurn).toHaveBeenCalledWith([makeMessage("m1", "first")], "codex_unknown_failure");

    await handler.shutdown();
  });

  it("does not forward partial Codex text when the stream emits a fatal error", async () => {
    const sendMessage = vi
      .fn<(chatId: string, body: Record<string, unknown>) => Promise<unknown>>()
      .mockResolvedValue(undefined);
    const emitEvent = vi.fn<(event: SessionEvent) => void>();
    const completedCounts: Array<number | undefined> = [];
    const retryTurn = vi.fn<SessionContext["retryTurn"]>();
    const handler = createCodexHandler({ workspaceRoot });
    const ctx = makeContext((count) => completedCounts.push(count), { sendMessage, emitEvent, retryTurn });

    state.agentMessagesByTurn.set(1, ["working note"]);
    state.streamErrorByTurn.set(1, "codex stream error");
    state.resolveChatContext?.({
      chatId: "chat-startup-race",
      title: "startup race",
      topic: null,
      description: null,
      participants: [],
    });

    await handler.start(makeMessage("m1", "first"), ctx);

    const events = emitEvent.mock.calls.map(([event]) => event);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(
      events.some(
        (event) =>
          event.kind === "error" && event.payload.source === "sdk" && event.payload.message === "codex stream error",
      ),
    ).toBe(true);
    expect(events.some((event) => event.kind === "turn_end" && event.payload.status === "error")).toBe(true);
    expect(completedCounts).toEqual([]);
    expect(retryTurn).toHaveBeenCalledWith([makeMessage("m1", "first")], "codex_stream_ended_after_diagnostic_error");

    await handler.shutdown();
  });

  it("retries queued injects when all inbound formatting fails before provider custody", async () => {
    const completedCounts: Array<number | undefined> = [];
    const retryTurn = vi.fn();
    const handler = createCodexHandler({ workspaceRoot });
    const ctx = makeContext(
      (count) => {
        completedCounts.push(count);
      },
      {
        formatInboundContent: async (message) => {
          if (message.id === "m2") throw new Error("format failed");
          const raw = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
          return `[From: ${message.senderId}]\n\n${raw}`;
        },
      },
    );
    ctx.retryTurn = retryTurn;

    state.resolveChatContext?.({
      chatId: "chat-startup-race",
      title: "startup race",
      topic: null,
      description: null,
      participants: [],
    });

    await handler.start(makeMessage("m1", "first"), ctx);
    handler.inject(makeMessage("m2", "bad"));

    await waitFor(() => retryTurn.mock.calls.length === 1);

    expect(state.runInputs).toHaveLength(1);
    expect(completedCounts).toEqual([1]);
    expect(retryTurn).toHaveBeenCalledWith(makeMessage("m2", "bad"), "codex_queued_turn_format_failed");

    await handler.shutdown();
  });

  it.each([
    {
      name: "first failed and second succeeded",
      failingIds: new Set(["m2"]),
      messages: [makeMessage("m2", "bad"), makeMessage("m3", "good")],
    },
    {
      name: "first succeeded and second failed",
      failingIds: new Set(["m3"]),
      messages: [makeMessage("m2", "good"), makeMessage("m3", "bad")],
    },
  ])("retries the whole queued batch when mixed formatting occurs: $name", async ({ failingIds, messages }) => {
    const completedCounts: Array<number | undefined> = [];
    const retryTurn = vi.fn();
    const handler = createCodexHandler({ workspaceRoot });
    const ctx = makeContext(
      (count) => {
        completedCounts.push(count);
      },
      {
        formatInboundContent: async (message) => {
          if (failingIds.has(message.id)) throw new Error(`format failed for ${message.id}`);
          const raw = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
          return `[From: ${message.senderId}]\n\n${raw}`;
        },
      },
    );
    ctx.retryTurn = retryTurn;

    state.resolveChatContext?.({
      chatId: "chat-startup-race",
      title: "startup race",
      topic: null,
      description: null,
      participants: [],
    });

    await handler.start(makeMessage("m1", "first"), ctx);
    for (const message of messages) handler.inject(message);

    await waitFor(() => retryTurn.mock.calls.length === messages.length);

    expect(state.runInputs).toHaveLength(1);
    expect(completedCounts).toEqual([1]);
    for (const message of messages) {
      expect(retryTurn).toHaveBeenCalledWith(message, "codex_queued_turn_format_failed");
    }

    await handler.shutdown();
  });
});
