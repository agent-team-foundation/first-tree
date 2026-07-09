import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatContext } from "../runtime/chat-context.js";
import type { SessionContext, SessionMessage } from "../runtime/handler.js";
import { mockCtxPlumbing } from "./test-helpers.js";

const state = vi.hoisted(() => ({
  chatContextPromise: null as Promise<ChatContext> | null,
  resolveChatContext: null as ((value: ChatContext) => void) | null,
  observedInputs: [] as string[],
  pendingResults: [] as unknown[],
  waiters: [] as Array<() => void>,
  coalesceFirstResultAfterInputs: null as number | null,
}));

function wakeQuery(): void {
  const waiters = state.waiters.splice(0);
  for (const waiter of waiters) waiter();
}

function flattenContent(content: unknown): string {
  return typeof content === "string" ? content : JSON.stringify(content);
}

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: { prompt: AsyncIterable<{ message: { content: unknown } }> }) => {
    let closed = false;

    void (async () => {
      for await (const sdkMsg of args.prompt) {
        state.observedInputs.push(flattenContent(sdkMsg.message.content));
        const turn = state.observedInputs.length;
        if (state.coalesceFirstResultAfterInputs !== null) {
          if (turn < state.coalesceFirstResultAfterInputs) continue;
          state.coalesceFirstResultAfterInputs = null;
        }
        state.pendingResults.push({
          type: "result",
          subtype: "success",
          result: `reply ${turn}`,
        });
        wakeQuery();
      }
      closed = true;
      wakeQuery();
    })();

    return {
      [Symbol.asyncIterator]() {
        return {
          next: async (): Promise<IteratorResult<unknown>> => {
            while (state.pendingResults.length === 0 && !closed) {
              await new Promise<void>((resolve) => state.waiters.push(resolve));
            }
            const value = state.pendingResults.shift();
            if (value) return { value, done: false };
            return { value: undefined, done: true };
          },
        };
      },
      close: () => {
        closed = true;
        wakeQuery();
      },
      setModel: async () => {},
    };
  },
}));

vi.mock("../runtime/agent-bootstrap.js", () => ({
  ensureAgentBootstrap: vi.fn(),
}));

vi.mock("../runtime/bootstrap.js", () => ({
  FIRST_TREE_RUNTIME_DIR: ".first-tree-workspace",
  FIRST_TREE_WORKSPACE_MARKER: ".first-tree-workspace",
  ensureWorkspaceRuntimeDir: vi.fn((workspacePath: string) => {
    const dir = join(workspacePath, ".first-tree-workspace");
    mkdirSync(dir, { recursive: true });
    return dir;
  }),
  writeAgentBriefing: vi.fn(),
}));

vi.mock("../runtime/agent-briefing.js", () => ({
  buildAgentBriefing: vi.fn(() => ""),
}));

vi.mock("../runtime/chat-context.js", () => ({
  fetchChatContext: vi.fn(async () => {
    if (!state.chatContextPromise) throw new Error("chat context gate was not initialised");
    return state.chatContextPromise;
  }),
}));

vi.mock("../runtime/source-repos.js", () => ({
  declaredSourceRepos: vi.fn(() => []),
  currentSourceRepoNamesFromPayload: vi.fn(() => null),
}));

import { createClaudeCodeHandler } from "../handlers/claude-code.js";

const AGENT_ID = "019e71d2-c9ec-7f11-86bf-5dfc9e873338";

let workspaceRoot: string;

function makeMessage(id: string, content: string): SessionMessage {
  return {
    id,
    chatId: "chat-claude-startup-race",
    senderId: "sender-1",
    format: "text",
    content,
    metadata: {},
  };
}

function makeFileMessage(
  id: string,
  content: Record<string, unknown>,
  chatId = "chat-claude-startup-race",
): SessionMessage {
  return {
    id,
    chatId,
    senderId: "sender-1",
    format: "file",
    content,
    metadata: {},
  };
}

function makeContext(
  onFinishTurn: (count?: number) => void,
  opts: { formatInboundContent?: SessionContext["formatInboundContent"] } = {},
): SessionContext {
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  return {
    agent: {
      agentId: AGENT_ID,
      inboxId: `inbox_${AGENT_ID}`,
      displayName: "codex-developer",
      type: "agent",
      visibility: "organization",
      delegateMention: null,
      metadata: {},
    },
    sdk: { serverUrl: "http://test", sendMessage } as unknown as SessionContext["sdk"],
    chatId: "chat-claude-startup-race",
    log: () => {},
    recordProviderActivity: () => {},
    emitEvent: () => {},
    ...mockCtxPlumbing({ sendMessage }, "chat-claude-startup-race"),
    ...(opts.formatInboundContent ? { formatInboundContent: opts.formatInboundContent } : {}),
    finishTurn: async () => {
      onFinishTurn();
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
  workspaceRoot = mkdtempSync(join(tmpdir(), "ft-claude-startup-race-"));
  state.observedInputs.length = 0;
  state.pendingResults.length = 0;
  state.waiters.length = 0;
  state.coalesceFirstResultAfterInputs = null;
  state.chatContextPromise = new Promise((resolve) => {
    state.resolveChatContext = resolve;
  });
});

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
  state.chatContextPromise = null;
  state.resolveChatContext = null;
  state.pendingResults.length = 0;
  state.coalesceFirstResultAfterInputs = null;
  wakeQuery();
});

describe("claude-code handler startup inject queue", () => {
  it("materializes legacy inline images and describes unavailable image batches", async () => {
    const completedCounts: Array<number | undefined> = [];
    const handler = createClaudeCodeHandler({ workspaceRoot });
    const ctx = makeContext((count) => {
      completedCounts.push(count);
    });
    state.resolveChatContext?.({
      chatId: "chat-claude-startup-race",
      title: "startup race",
      topic: null,
      description: null,
      participants: [],
    });

    await handler.start(
      makeFileMessage(
        "legacy-image",
        {
          data: Buffer.from("fake image bytes").toString("base64"),
          mimeType: "image/png",
          filename: "legacy.png",
        },
        "../unsafe/chat",
      ),
      ctx,
    );

    handler.inject(
      makeFileMessage("batch-images", {
        caption: "Compare these screenshots",
        attachments: [
          {
            imageId: "00000000-0000-4000-8000-000000000001",
            mimeType: "image/png",
            filename: "one.png",
            size: 12,
          },
          {
            imageId: "00000000-0000-4000-8000-000000000002",
            mimeType: "image/jpeg",
            filename: "two.jpg",
            size: 34,
          },
        ],
      }),
    );

    await waitFor(() => state.observedInputs.length === 2);
    expect(state.observedInputs[0]).toContain("Filename: legacy.png");
    expect(state.observedInputs[0]).toContain(join("first-tree", "images", "unknown"));
    expect(state.observedInputs[0]).toContain(".png");
    expect(state.observedInputs[1]).toContain("Compare these screenshots");
    expect(state.observedInputs[1]).toContain(
      "2 images were shared in this chat. Please use the Read tool to read each one",
    );
    expect(state.observedInputs[1]).toContain('[Image "one.png" not available on this device]');
    expect(state.observedInputs[1]).toContain('[Image "two.jpg" not available on this device]');
    expect(completedCounts).toEqual([undefined, undefined]);

    await handler.shutdown();
  });

  it("queues injects received before the InputController exists so their inbox entries stay aligned with acks", async () => {
    const completedCounts: Array<number | undefined> = [];
    const handler = createClaudeCodeHandler({ workspaceRoot });
    const ctx = makeContext((count) => {
      completedCounts.push(count);
    });

    const startPromise = handler.start(makeMessage("m1", "first"), ctx);
    await Promise.resolve();

    // The handler has a session id, but startup is still waiting on chat
    // context; `spawnQuery` has not created the InputController yet.
    handler.inject(makeMessage("m2", "second"));

    state.resolveChatContext?.({
      chatId: "chat-claude-startup-race",
      title: "startup race",
      topic: null,
      description: null,
      participants: [],
    });

    await startPromise;
    await waitFor(() => state.observedInputs.length === 2);
    await waitFor(() => completedCounts.length === 1);

    expect(state.observedInputs[0]).toContain("first");
    expect(state.observedInputs[1]).toContain("second");
    expect(completedCounts).toEqual([undefined]);

    await handler.shutdown();
  });

  it("keeps startup-queued injects ahead of ready-state injects after start returns", async () => {
    const completedCounts: Array<number | undefined> = [];
    const releaseSecond: { current: (() => void) | null } = { current: null };
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond.current = resolve;
    });
    const handler = createClaudeCodeHandler({ workspaceRoot });
    const ctx = makeContext(
      (count) => {
        completedCounts.push(count);
      },
      {
        formatInboundContent: async (message) => {
          if (message.id === "m2") await secondGate;
          const raw = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
          return `[From: ${message.senderId}]\n\n${raw}`;
        },
      },
    );

    const startPromise = handler.start(makeMessage("m1", "first"), ctx);
    await Promise.resolve();
    handler.inject(makeMessage("m2", "second"));

    state.resolveChatContext?.({
      chatId: "chat-claude-startup-race",
      title: "startup race",
      topic: null,
      description: null,
      participants: [],
    });

    await startPromise;
    handler.inject(makeMessage("m3", "third"));
    await new Promise((resolve) => setImmediate(resolve));
    releaseSecond.current?.();

    await waitFor(() => state.observedInputs.length === 3);
    await waitFor(() => completedCounts.length === 3);

    expect(state.observedInputs[0]).toContain("first");
    expect(state.observedInputs[1]).toContain("second");
    expect(state.observedInputs[2]).toContain("third");
    expect(completedCounts).toEqual([undefined, undefined, undefined]);

    await handler.shutdown();
  });

  it("settles coalesced SDK inputs as one provider turn", async () => {
    state.coalesceFirstResultAfterInputs = 2;
    const finishedBatches: string[][] = [];
    const processingStarted: string[] = [];
    const handler = createClaudeCodeHandler({ workspaceRoot });
    const ctx = makeContext(() => {});
    ctx.markMessagesConsumed = (messages) => {
      const batch = Array.isArray(messages) ? messages : [messages];
      processingStarted.push(...batch.map((message) => message.id));
    };
    ctx.finishTurn = async (messages) => {
      const batch = Array.isArray(messages) ? messages : [messages];
      finishedBatches.push(batch.map((message) => message.id));
    };

    state.resolveChatContext?.({
      chatId: "chat-claude-startup-race",
      title: "startup race",
      topic: null,
      description: null,
      participants: [],
    });

    await handler.start(makeMessage("m1", "first"), ctx);
    handler.inject(makeMessage("m2", "second"));

    await waitFor(() => state.observedInputs.length === 2);
    await waitFor(() => finishedBatches.length === 1);

    expect(state.observedInputs[0]).toContain("first");
    expect(state.observedInputs[1]).toContain("second");
    expect(processingStarted).toEqual(["m1", "m2"]);
    expect(finishedBatches).toEqual([["m1", "m2"]]);

    await handler.shutdown();
  });

  it("retries active injects whose SDK message conversion fails before provider custody", async () => {
    const completedCounts: Array<number | undefined> = [];
    const retryTurn = vi.fn();
    const handler = createClaudeCodeHandler({ workspaceRoot });
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
      chatId: "chat-claude-startup-race",
      title: "startup race",
      topic: null,
      description: null,
      participants: [],
    });

    await handler.start(makeMessage("m1", "first"), ctx);
    handler.inject(makeMessage("m2", "bad"));

    await waitFor(() => retryTurn.mock.calls.length === 1);

    expect(state.observedInputs).toHaveLength(1);
    expect(completedCounts).toEqual([undefined]);
    expect(retryTurn).toHaveBeenCalledWith(makeMessage("m2", "bad"), "claude_inject_format_failed");

    await handler.shutdown();
  });
});
