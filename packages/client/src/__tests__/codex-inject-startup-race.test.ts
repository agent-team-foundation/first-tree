import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatContext } from "../runtime/chat-context.js";
import type { SessionContext, SessionMessage } from "../runtime/handler.js";
import { mockCtxPlumbing } from "./test-helpers.js";

const state = vi.hoisted(() => ({
  chatContextPromise: null as Promise<ChatContext> | null,
  resolveChatContext: null as ((value: ChatContext) => void) | null,
  runInputs: [] as unknown[],
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
          yield { type: "item.completed", item: { type: "agent_message", text: `reply ${turn}` } };
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
  FIRST_TREE_WORKSPACE_MARKER: ".first-tree-workspace",
  bootstrapWorkspace: vi.fn(),
  buildChatSystemPrompt: vi.fn(() => ""),
  deepEqualIdentity: vi.fn(() => true),
  installCoreSkills: vi.fn(),
  installFirstTreeIntegration: vi.fn(() => true),
  isHubWorktreeMarker: vi.fn(() => false),
  readCachedBundledCliVersion: vi.fn(() => null),
  readCachedContextTreeHead: vi.fn(() => null),
  readContextTreeHead: vi.fn(() => null),
  resolveBundledCliVersion: vi.fn(() => "0.0.0-test"),
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

function makeContext(markCompleted: (count?: number) => void): SessionContext {
  const sendMessage = vi.fn().mockResolvedValue(undefined);
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
    touch: () => {},
    setRuntimeState: () => {},
    emitEvent: () => {},
    ...mockCtxPlumbing({ sendMessage }, "chat-startup-race"),
    markCompleted,
  };
}

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "ft-codex-startup-race-"));
  state.runInputs.length = 0;
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
});
