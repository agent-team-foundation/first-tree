import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@first-tree/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatContext } from "../runtime/chat-context.js";
import type { SessionContext, SessionMessage } from "../runtime/handler.js";
import { mockCtxPlumbing } from "./test-helpers.js";

/**
 * Issue #971 — codex usage-limit silent failure.
 *
 * When the codex account usage limit is exhausted the SDK emits
 * `turn.completed` almost instantly with NO agent_message and ZERO token
 * consumption (the model is never invoked). Before the fix that looked
 * identical to the legitimate "silent turn" protocol, so the runtime acked
 * the message as a phantom success: no chat reply, no error, no log.
 *
 * The handler now discriminates on the per-turn token delta:
 *   - zero delta + empty reply + turn.completed  => usage-limit empty turn
 *     => emit an `error` event, log a warn line, and post a chat notice.
 *   - non-zero delta + empty reply               => a chosen silence (the
 *     model ran), left untouched (no false positive).
 *
 * These drive the real `runTurn` state machine through a mock Codex SDK whose
 * per-turn event script is set by each test.
 */

type MockState = {
  runInputs: unknown[];
  turns: unknown[][];
};

const state = vi.hoisted<MockState>(() => ({
  runInputs: [],
  turns: [],
}));

vi.mock("@openai/codex-sdk", () => {
  const thread = {
    id: "thread-usage-limit",
    async runStreamed(input: unknown) {
      state.runInputs.push(input);
      const idx = state.runInputs.length - 1;
      const events = state.turns[idx] ?? [];
      return {
        events: (async function* () {
          yield { type: "thread.started", thread_id: "thread-usage-limit" };
          for (const event of events) yield event;
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
  fetchChatContext: vi.fn(async (): Promise<ChatContext> => {
    return {
      chatId: "chat-usage-limit",
      title: "usage limit",
      topic: null,
      description: null,
      participants: [],
    };
  }),
}));

import { createCodexHandler } from "../handlers/codex/index.js";

const AGENT_ID = "019e71c9-88d2-70be-be67-fdb033b2ef0b";

let workspaceRoot: string;

type SendMessageMock = ReturnType<typeof vi.fn<(chatId: string, body: Record<string, unknown>) => Promise<unknown>>>;

function makeMessage(id: string, content: string): SessionMessage {
  return {
    id,
    chatId: "chat-usage-limit",
    senderId: "sender-1",
    format: "text",
    content,
    metadata: {},
  };
}

function makeContext(
  onFinishTurn: (count?: number) => void,
  opts: {
    sendMessage?: SendMessageMock;
    emitEvent?: SessionContext["emitEvent"];
    log?: SessionContext["log"];
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
    chatId: "chat-usage-limit",
    log: opts.log ?? (() => {}),
    recordProviderActivity: () => {},
    emitEvent: opts.emitEvent ?? (() => {}),
    ...mockCtxPlumbing({ sendMessage }, "chat-usage-limit"),
    finishTurn: async (messages) => {
      onFinishTurn(Array.isArray(messages) ? messages.length : 1);
    },
  };
}

const zeroUsage = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 };

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "ft-codex-usage-limit-"));
  state.runInputs.length = 0;
  state.turns = [];
});

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});

describe("codex usage-limit empty-turn (issue #971)", () => {
  it("surfaces a chat notice + error event when the turn completes with no reply and zero token delta", async () => {
    // turn.completed with zero usage and NO agent_message — the model was
    // never invoked (account usage limit exhausted).
    state.turns = [[{ type: "turn.completed", usage: zeroUsage }]];

    const completedCounts: Array<number | undefined> = [];
    const logs: string[] = [];
    const sendMessage = vi
      .fn<(chatId: string, body: Record<string, unknown>) => Promise<unknown>>()
      .mockResolvedValue(undefined);
    const emitEvent = vi.fn<(event: SessionEvent) => void>();
    const handler = createCodexHandler({ workspaceRoot });
    const ctx = makeContext((count) => completedCounts.push(count), {
      sendMessage,
      emitEvent,
      log: (message) => logs.push(message),
    });

    await handler.start(makeMessage("m1", "hello"), ctx);

    const events = emitEvent.mock.calls.map(([event]) => event);

    // Layer 1-A: a chat-visible notice is posted (via the forwardResult /
    // agent-final-text path → sendMessage in this harness).
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(String(sendMessage.mock.calls[0]?.[1].content)).toContain("usage limit");

    // Layer 2: an `error` event is emitted (daemon log + admin stream), and a
    // warn-style log line is recorded — not a phantom success.
    const errorEvents = events.filter((event) => event.kind === "error");
    expect(
      errorEvents.some(
        (event) => event.kind === "error" && event.payload.message.includes("codex usage limit reached"),
      ),
    ).toBe(true);
    expect(logs.some((line) => line.includes("codex usage limit reached"))).toBe(true);

    // turn_end is reported as an error, never as success.
    expect(events.some((event) => event.kind === "turn_end" && event.payload.status === "error")).toBe(true);
    expect(events.some((event) => event.kind === "turn_end" && event.payload.status === "success")).toBe(false);

    // MVP scope: the message is still acked (no auto-redelivery). The user
    // resends manually once the limit resets.
    expect(completedCounts).toEqual([1]);

    await handler.shutdown();
  });

  it("does NOT flag a legitimate silent turn (model ran, burned tokens, chose to stay silent)", async () => {
    // turn.completed with NON-zero usage and NO agent_message — the model ran
    // and the agent deliberately produced no reply (silent-turn protocol).
    state.turns = [
      [
        {
          type: "turn.completed",
          usage: { input_tokens: 120, cached_input_tokens: 10, output_tokens: 0, reasoning_output_tokens: 4 },
        },
      ],
    ];

    const completedCounts: Array<number | undefined> = [];
    const logs: string[] = [];
    const sendMessage = vi
      .fn<(chatId: string, body: Record<string, unknown>) => Promise<unknown>>()
      .mockResolvedValue(undefined);
    const emitEvent = vi.fn<(event: SessionEvent) => void>();
    const handler = createCodexHandler({ workspaceRoot });
    const ctx = makeContext((count) => completedCounts.push(count), {
      sendMessage,
      emitEvent,
      log: (message) => logs.push(message),
    });

    await handler.start(makeMessage("m1", "hello"), ctx);

    const events = emitEvent.mock.calls.map(([event]) => event);

    // No notice, no usage-limit error/log — a chosen silence is left alone.
    expect(sendMessage).not.toHaveBeenCalled();
    expect(
      events.some((event) => event.kind === "error" && event.payload.message.includes("codex usage limit reached")),
    ).toBe(false);
    expect(logs.some((line) => line.includes("codex usage limit reached"))).toBe(false);

    // A silent turn is a success (the agent's explicit signal of "nothing to add").
    expect(events.some((event) => event.kind === "turn_end" && event.payload.status === "success")).toBe(true);
    expect(completedCounts).toEqual([1]);

    await handler.shutdown();
  });

  it("forwards a normal reply unchanged and reports success (no false trigger when text is produced)", async () => {
    state.turns = [
      [
        { type: "item.completed", item: { type: "agent_message", text: "here is your answer" } },
        {
          type: "turn.completed",
          usage: { input_tokens: 200, cached_input_tokens: 0, output_tokens: 40, reasoning_output_tokens: 0 },
        },
      ],
    ];

    const completedCounts: Array<number | undefined> = [];
    const sendMessage = vi
      .fn<(chatId: string, body: Record<string, unknown>) => Promise<unknown>>()
      .mockResolvedValue(undefined);
    const emitEvent = vi.fn<(event: SessionEvent) => void>();
    const handler = createCodexHandler({ workspaceRoot });
    const ctx = makeContext((count) => completedCounts.push(count), { sendMessage, emitEvent });

    await handler.start(makeMessage("m1", "hello"), ctx);

    const events = emitEvent.mock.calls.map(([event]) => event);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[1].content).toBe("here is your answer");
    expect(
      events.some((event) => event.kind === "error" && event.payload.message.includes("codex usage limit reached")),
    ).toBe(false);
    expect(events.some((event) => event.kind === "turn_end" && event.payload.status === "success")).toBe(true);
    expect(completedCounts).toEqual([1]);

    await handler.shutdown();
  });
});
