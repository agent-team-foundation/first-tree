import { describe, expect, it, vi } from "vitest";
import type { AgentHandler, SessionContext, SessionMessage } from "../runtime/handler.js";
import { TreeWriteBackgroundRunner } from "../runtime/tree-write-runner.js";

function makeRunner(handler: AgentHandler, onResult = vi.fn()) {
  return {
    onResult,
    runner: new TreeWriteBackgroundRunner({
      agent: {
        agentId: "agent-1",
        inboxId: "inbox-1",
        displayName: "Agent One",
        type: "autonomous_agent",
        delegateMention: null,
        metadata: {},
      },
      handlerFactory: () => handler,
      handlerConfig: { workspaceRoot: "/tmp/tree-write-runner-test" },
      sdk: { serverUrl: "http://test" } as SessionContext["sdk"],
      log: vi.fn(),
      onResult,
    }),
  };
}

describe("TreeWriteBackgroundRunner", () => {
  it("parses a valid JSON result and emits a typed task:result", async () => {
    let capturedChatId: string | null = null;
    const shutdown = vi.fn(async () => {});
    const handler: AgentHandler = {
      start: vi.fn(async (_message: SessionMessage, ctx: SessionContext) => {
        capturedChatId = ctx.chatId;
        await ctx.forwardResult(
          '{"kind":"done","prUrl":"https://github.com/agent-team-foundation/first-tree-context/pull/999"}',
        );
        return "session-1";
      }),
      resume: vi.fn(),
      inject: vi.fn(),
      suspend: vi.fn(async () => {}),
      shutdown,
    };

    const { runner, onResult } = makeRunner(handler);
    runner.enqueue({
      type: "task:tree_write:start",
      taskId: "task-1",
      execChatId: "exec-chat-1",
      sourceChatId: "source-chat-1",
      prompt: "test prompt",
    });

    await vi.waitFor(() => {
      expect(onResult).toHaveBeenCalledWith({
        type: "task:tree_write:result",
        taskId: "task-1",
        kind: "done",
        prUrl: "https://github.com/agent-team-foundation/first-tree-context/pull/999",
      });
    });
    expect(capturedChatId).toBe("exec-chat-1");
    await vi.waitFor(() => {
      expect(shutdown).toHaveBeenCalled();
    });
  });

  it("turns invalid JSON output into a typed failed result", async () => {
    const handler: AgentHandler = {
      start: vi.fn(async (_message: SessionMessage, ctx: SessionContext) => {
        await ctx.forwardResult("not-json");
        return "session-2";
      }),
      resume: vi.fn(),
      inject: vi.fn(),
      suspend: vi.fn(async () => {}),
      shutdown: vi.fn(async () => {}),
    };

    const { runner, onResult } = makeRunner(handler);
    runner.enqueue({
      type: "task:tree_write:start",
      taskId: "task-2",
      execChatId: "exec-chat-2",
      sourceChatId: "source-chat-2",
      prompt: "test prompt",
    });

    await vi.waitFor(() => {
      expect(onResult).toHaveBeenCalledWith({
        type: "task:tree_write:result",
        taskId: "task-2",
        kind: "failed",
        error: {
          code: "invalid_result_payload",
          message: expect.any(String),
        },
      });
    });
  });
});
