import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@agent-team-foundation/first-tree-hub-shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * When the SDK returns a non-success result subtype (e.g. `error_max_turns`,
 * `error_during_execution`), the handler must still close the turn with a
 * `turn_end:error` event — otherwise the frontend's turn-grouping filter
 * keeps the transient `thinking` / `tool_call` / `assistant_text` rows
 * visible forever, instead of collapsing them around an error.
 */

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
              value: {
                type: "result",
                subtype: "error_max_turns",
                errors: ["exceeded max turns"],
                num_turns: 99,
                duration_ms: 5,
              },
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

const AGENT_ID = "019d9a97-90b0-716b-8317-a8c0be8430d8";

let workspaceRoot: string;

beforeAll(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "ftt-turn-end-sdk-err-"));
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

describe("claude-code handler — turn_end on SDK-reported subtype error", () => {
  it("emits error event then turn_end:error when result subtype !== success", async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
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
      emitEvent: (e) => emitted.push(e),
      reportSessionCompletion,
    };

    await handler.start(
      { id: "m1", chatId: "chat-1", senderId: "u", format: "text", content: "hi", metadata: null },
      ctx,
    );
    await handler.suspend();
    await new Promise((r) => setImmediate(r));

    // Success path was NOT taken.
    expect(sendMessage).not.toHaveBeenCalled();
    expect(reportSessionCompletion).not.toHaveBeenCalled();

    // Error event carries the SDK-reported cause.
    const errors = emitted.filter((e) => e.kind === "error");
    expect(errors).toHaveLength(1);
    const err = errors[0];
    if (!err || err.kind !== "error") throw new Error("expected error event");
    expect(err.payload.source).toBe("sdk");
    expect(err.payload.message).toContain("exceeded max turns");

    // turn_end:error closes the turn — and comes AFTER the error event.
    const turnEnds = emitted.filter((e) => e.kind === "turn_end");
    expect(turnEnds).toHaveLength(1);
    const te = turnEnds[0];
    if (!te || te.kind !== "turn_end") throw new Error("expected turn_end event");
    expect(te.payload.status).toBe("error");

    const errIdx = emitted.findIndex((e) => e.kind === "error");
    const turnEndIdx = emitted.findIndex((e) => e.kind === "turn_end");
    expect(errIdx).toBeLessThan(turnEndIdx);
  });
});
