import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatContext } from "../runtime/chat-context.js";
import type { DeliveryToken, SessionContext, SessionMessage } from "../runtime/handler.js";
import { mockCtxPlumbing } from "./test-helpers.js";

const STALE_THREAD_ID = "019f2943-c0af-75b0-9d7b-d58679594749";

const state = vi.hoisted(() => ({
  runCalls: [] as Array<{ threadId: string; input: unknown }>,
  resumeThreadIds: [] as string[],
  startThreadIds: [] as string[],
  nextFreshThreadId: "fresh-thread-1",
}));

vi.mock("@openai/codex-sdk", () => {
  const usage = {
    input_tokens: 1,
    cached_input_tokens: 0,
    output_tokens: 1,
    reasoning_output_tokens: 0,
  };

  function makeThread(threadId: string, stale: boolean) {
    return {
      id: threadId,
      async runStreamed(input: unknown) {
        state.runCalls.push({ threadId, input });
        if (stale) {
          throw new Error(
            `Codex Exec exited with code 1: Reading prompt from stdin...\nError: thread/resume: thread/resume failed: no rollout found for thread id ${threadId} (code -32600)`,
          );
        }
        return {
          events: (async function* () {
            yield { type: "thread.started", thread_id: threadId };
            yield { type: "item.completed", item: { type: "agent_message", text: "fresh answer" } };
            yield { type: "turn.completed", usage };
          })(),
        };
      },
    };
  }

  return {
    Codex: class {
      startThread() {
        state.startThreadIds.push(state.nextFreshThreadId);
        return makeThread(state.nextFreshThreadId, false);
      }
      resumeThread(threadId: string) {
        state.resumeThreadIds.push(threadId);
        return makeThread(threadId, true);
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
      chatId: "chat-stale-rollout",
      title: "stale rollout",
      topic: null,
      description: null,
      participants: [],
    };
  }),
}));

import { createCodexSdkHandler } from "../handlers/codex/index.js";

const AGENT_ID = "019e71c9-88d2-70be-be67-fdb033b2ef0b";

let workspaceRoot: string;

function makeMessage(id: string, content: string): SessionMessage {
  return {
    id,
    chatId: "chat-stale-rollout",
    senderId: "sender-1",
    format: "text",
    content,
    metadata: {},
  };
}

function makeContext(opts: { replaceSessionId?: SessionContext["replaceSessionId"] } = {}): SessionContext {
  const sendMessage = vi
    .fn<(chatId: string, body: Record<string, unknown>) => Promise<unknown>>()
    .mockResolvedValue({});
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
    chatId: "chat-stale-rollout",
    log: () => {},
    recordProviderActivity: () => {},
    emitEvent: () => {},
    ...mockCtxPlumbing({ sendMessage }, "chat-stale-rollout"),
    ...(opts.replaceSessionId ? { replaceSessionId: opts.replaceSessionId } : {}),
  };
}

function makeToken(): DeliveryToken {
  return {
    processingStarted: vi.fn(),
    complete: vi.fn<DeliveryToken["complete"]>().mockResolvedValue(undefined),
    retry: vi.fn(),
    terminalRejected: vi.fn<DeliveryToken["terminalRejected"]>().mockResolvedValue(undefined),
  };
}

describe("codex stale rollout recovery", () => {
  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), "codex-stale-rollout-"));
    state.runCalls = [];
    state.resumeThreadIds = [];
    state.startThreadIds = [];
    state.nextFreshThreadId = "fresh-thread-1";
  });

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("fresh-starts the same resume turn and returns the replacement thread id", async () => {
    const replaceSessionId = vi.fn<NonNullable<SessionContext["replaceSessionId"]>>();
    const handler = createCodexSdkHandler({ workspaceRoot });
    const ctx = makeContext({ replaceSessionId });
    const token = makeToken();

    const result = await handler.resume(makeMessage("m1", "hello"), STALE_THREAD_ID, ctx, token);

    expect(result).toEqual({ sessionId: "fresh-thread-1", route: { kind: "owned", mode: "processing" } });
    expect(state.resumeThreadIds).toEqual([STALE_THREAD_ID]);
    expect(state.startThreadIds).toEqual(["fresh-thread-1"]);
    expect(state.runCalls.map((call) => call.threadId)).toEqual([STALE_THREAD_ID, "fresh-thread-1"]);
    expect(replaceSessionId).toHaveBeenCalledWith("fresh-thread-1", "codex_stale_rollout_recovered");
    expect(token.retry).not.toHaveBeenCalled();
    expect(token.complete).toHaveBeenCalledTimes(1);
  });
});
