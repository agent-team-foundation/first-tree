import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@agent-team-foundation/first-tree-hub-shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * When a Claude `result` arrives but the auto-bridge `sdk.sendMessage` rejects
 * (Hub outage / chat permission etc.), the assistant text would otherwise be
 * lost — the session_output table was retired in NC2. The handler now mirrors
 * the loss as a `runtime` SessionEvent containing a truncated snapshot so it
 * stays visible via the events API.
 */

const RESULT_TEXT = `final answer ${"x".repeat(2200)}`;

vi.mock("@anthropic-ai/claude-agent-sdk", () => {
  const fakeQuery = {
    [Symbol.asyncIterator]() {
      let step = 0;
      return {
        next: async () => {
          step += 1;
          if (step === 1) {
            return {
              done: false,
              value: { type: "result", subtype: "success", result: RESULT_TEXT, num_turns: 1, duration_ms: 5 },
            };
          }
          return { done: true, value: undefined };
        },
      };
    },
    close: () => {},
    setModel: async () => {},
  };
  return { query: () => fakeQuery };
});

import { createClaudeCodeHandler } from "../handlers/claude-code.js";
import { createAgentConfigCache } from "../runtime/agent-config-cache.js";
import type { SessionContext } from "../runtime/handler.js";

const AGENT_ID = "019d9a97-90b0-716b-8317-a8c0be8430d7";

let workspaceRoot: string;

beforeAll(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "ftt-result-fail-"));
});

afterAll(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});

function buildCache() {
  const stubSdk = {
    fetchAgentConfig: async () => ({
      agentId: AGENT_ID,
      version: 1,
      payload: { prompt: { append: "" }, model: "", mcpServers: [], env: [], gitRepos: [] },
      updatedAt: new Date().toISOString(),
      updatedBy: "test",
    }),
  } as unknown as Parameters<typeof createAgentConfigCache>[0]["sdk"];
  return createAgentConfigCache({ sdk: stubSdk, log: () => {} });
}

describe("claude-code handler — sendMessage failure surfaces lost result", () => {
  it("emits a runtime error event with a snapshot of the dropped text", async () => {
    const sendMessage = vi.fn().mockRejectedValue(new Error("hub unreachable"));
    const emitted: SessionEvent[] = [];
    const reportSessionCompletion = vi.fn();

    const cache = buildCache();
    await cache.refresh(AGENT_ID);

    const handler = createClaudeCodeHandler({ workspaceRoot, agentConfigCache: cache });
    const ctx: SessionContext = {
      agent: {
        agentId: AGENT_ID,
        displayName: "test",
        type: "autonomous_agent",
        delegateMention: null,
        metadata: {},
      },
      sdk: { serverUrl: "http://test", sendMessage } as unknown as SessionContext["sdk"],
      chatId: "chat-1",
      log: () => {},
      touch: () => {},
      setRuntimeState: () => {},
      emitEvent: (e) => {
        emitted.push(e);
      },
      reportSessionCompletion,
    };

    await handler.start(
      { id: "m1", chatId: "chat-1", senderId: "u", format: "text", content: "hi", metadata: null },
      ctx,
    );

    // Consumer loop is async; let microtasks (the rejected sendMessage promise) settle.
    await handler.suspend();
    await new Promise((r) => setImmediate(r));

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(reportSessionCompletion).not.toHaveBeenCalled();

    const errors = emitted.filter((e) => e.kind === "error");
    expect(errors).toHaveLength(1);
    const err = errors[0];
    if (!err || err.kind !== "error") throw new Error("expected error event");
    expect(err.payload.source).toBe("runtime");
    expect(err.payload.message).toContain("Result forward failed: hub unreachable");
    // snapshot is truncated to keep total message ≤ 2000 chars
    expect(err.payload.message.length).toBeLessThanOrEqual(2000);
    expect(err.payload.message).toContain("final answer");
  });
});
