import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@first-tree/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatContext } from "../runtime/chat-context.js";
import type { SessionContext, SessionMessage } from "../runtime/handler.js";
import { mockCtxPlumbing } from "./test-helpers.js";

type MockState = {
  runInputs: unknown[];
  signals: AbortSignal[];
  streamClosedByAttempt: boolean[];
  lateAbortAfterClose: boolean;
};

const state = vi.hoisted<MockState>(() => ({
  runInputs: [],
  signals: [],
  streamClosedByAttempt: [],
  lateAbortAfterClose: false,
}));

vi.mock("@openai/codex-sdk", () => {
  const usage = {
    input_tokens: 1,
    cached_input_tokens: 0,
    output_tokens: 1,
    reasoning_output_tokens: 0,
  };

  const thread = {
    id: "thread-retry-abort",
    async runStreamed(input: unknown, opts: { signal?: AbortSignal } = {}) {
      state.runInputs.push(input);
      const attempt = state.runInputs.length;
      const attemptIndex = attempt - 1;
      const signal = opts.signal;
      if (signal) {
        state.signals.push(signal);
        signal.addEventListener("abort", () => {
          if (state.streamClosedByAttempt[attemptIndex]) state.lateAbortAfterClose = true;
        });
      }

      return {
        events: (async function* () {
          try {
            yield { type: "thread.started", thread_id: "thread-retry-abort" };
            if (attempt === 1) {
              yield { type: "error", message: "stream disconnected before completion: fetch failed" };
              return;
            }
            yield {
              type: "item.completed",
              item: { type: "agent_message", text: "retry succeeded" },
            };
            yield { type: "turn.completed", usage };
          } finally {
            state.streamClosedByAttempt[attemptIndex] = true;
          }
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
  generateToolsDoc: vi.fn(() => ""),
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
  fetchChatContext: vi.fn(async (): Promise<ChatContext> => {
    return {
      chatId: "chat-retry-abort",
      title: "retry abort",
      topic: null,
      participants: [],
    };
  }),
}));

import { createCodexHandler } from "../handlers/codex.js";

const AGENT_ID = "019e71c9-88d2-70be-be67-fdb033b2ef0b";

let workspaceRoot: string;

type SendMessageMock = ReturnType<typeof vi.fn<(chatId: string, body: Record<string, unknown>) => Promise<unknown>>>;

function makeMessage(id: string, content: string): SessionMessage {
  return {
    id,
    chatId: "chat-retry-abort",
    senderId: "sender-1",
    format: "text",
    content,
    metadata: {},
  };
}

function makeContext(
  markCompleted: (count?: number) => void,
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
    chatId: "chat-retry-abort",
    log: opts.log ?? (() => {}),
    touch: () => {},
    setRuntimeState: () => {},
    emitEvent: opts.emitEvent ?? (() => {}),
    ...mockCtxPlumbing({ sendMessage }, "chat-retry-abort"),
    markCompleted,
  };
}

async function waitForMicrotasks(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 20; i++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error(`timed out waiting for ${label}`);
}

beforeEach(() => {
  vi.useFakeTimers();
  workspaceRoot = mkdtempSync(join(tmpdir(), "ft-codex-retry-abort-"));
  state.runInputs.length = 0;
  state.signals.length = 0;
  state.streamClosedByAttempt.length = 0;
  state.lateAbortAfterClose = false;
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(workspaceRoot, { recursive: true, force: true });
});

describe("codex handler retry abort cleanup", () => {
  it("retries a transient stream failure without aborting the per-attempt signal after iterator close", async () => {
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

    const startPromise = handler.start(makeMessage("m1", "first"), ctx);

    await waitForMicrotasks(
      () => state.streamClosedByAttempt[0] === true && logs.some((message) => message.includes("codex turn retry")),
      "first attempt retry backoff",
    );

    expect(state.runInputs).toHaveLength(1);
    expect(state.lateAbortAfterClose).toBe(false);

    await vi.advanceTimersByTimeAsync(500);
    await startPromise;

    const events = emitEvent.mock.calls.map(([event]) => event);
    const assistantTexts: string[] = [];
    for (const event of events) {
      if (event.kind === "assistant_text") assistantTexts.push(event.payload.text);
    }

    expect(state.runInputs).toHaveLength(2);
    expect(state.signals).toHaveLength(2);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[1].content).toBe("retry succeeded");
    expect(assistantTexts).toEqual(["retry succeeded"]);
    expect(events.some((event) => event.kind === "error")).toBe(false);
    expect(events.some((event) => event.kind === "turn_end" && event.payload.status === "success")).toBe(true);
    expect(completedCounts).toEqual([1]);
    expect(state.lateAbortAfterClose).toBe(false);

    await handler.shutdown();
  });
});
