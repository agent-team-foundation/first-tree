import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@first-tree/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Regression guard for the turn_end serialization race.
 *
 * If `sendMessage` is fire-and-forget, a slow HTTP round-trip (say 200ms)
 * can let the SDK emit turn N+1's thinking / tool_call / assistant_text
 * events BEFORE the client has posted turn N's `turn_end` over the WebSocket.
 * The server then assigns a smaller seq to turn N+1's first events than to
 * turn N's turn_end — and the chat-view's `filterEventsForTimeline` treats
 * the latest turn_end as a hard boundary, retroactively hiding turn N+1's
 * live events.
 *
 * The fix: await `sendMessage` synchronously inside the consumer loop so
 * the turn_end emit happens BEFORE the for-await pulls the next SDK
 * message off the queue. This test proves the property.
 */

let releaseSendMessage: (() => void) | null = null;
const sendMessageStalled = new Promise<void>((resolve) => {
  releaseSendMessage = resolve;
});

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
              value: { type: "result", subtype: "success", result: "turn-1", num_turns: 1, duration_ms: 5 },
            };
          }
          // Turn 2 begins: the SDK has a next assistant message ready. If the
          // consumer loop were not awaiting sendMessage, this would fire
          // before turn_end and break the seq invariant.
          if (step === 2) {
            return {
              done: false,
              value: {
                type: "assistant",
                message: {
                  role: "assistant",
                  content: [{ type: "tool_use", id: "tu-next-turn", name: "Bash", input: { command: "x" } }],
                },
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
import { mockCtxPlumbing } from "./test-helpers.js";

const AGENT_ID = "019d9a97-90b0-716b-8317-a8c0be8430d9";

let workspaceRoot: string;

beforeAll(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "ftt-turn-end-ser-"));
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
  return createAgentConfigCache({ sdk: stubSdk });
}

describe("claude-code handler — turn_end serialization (race guard)", () => {
  it("blocks the next turn's events until the current turn_end has been emitted", async () => {
    // sendMessage holds for 50ms to simulate a slow Hub round-trip.
    const sendMessage = vi.fn().mockImplementation(async () => {
      await sendMessageStalled;
    });

    const emitted: { kind: string; at: number }[] = [];
    const start = Date.now();

    const cache = buildCache();
    await cache.refresh(AGENT_ID);

    const handler = createClaudeCodeHandler({ workspaceRoot, agentConfigCache: cache });
    const ctx: SessionContext = {
      agent: {
        agentId: AGENT_ID,
        inboxId: "inbox-test",
        displayName: "test",
        type: "agent",
        visibility: "organization",
        delegateMention: null,
        metadata: {},
      },
      sdk: { serverUrl: "http://test", sendMessage } as unknown as SessionContext["sdk"],
      chatId: "chat-1",
      log: () => {},
      touch: () => {},
      setRuntimeState: () => {},
      emitEvent: (e: SessionEvent) => {
        emitted.push({ kind: e.kind, at: Date.now() - start });
      },
      ...mockCtxPlumbing({ sendMessage }, "chat-1"),
    };

    const startPromise = handler.start(
      { id: "m1", chatId: "chat-1", senderId: "u", format: "text", content: "hi", metadata: null },
      ctx,
    );

    // Wait until sendMessage was invoked (turn 1 result arrived), then hold
    // briefly to prove that no turn-2 events were emitted while we stalled.
    await new Promise((r) => setTimeout(r, 30));
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(emitted.filter((e) => e.kind !== "turn_end")).toEqual([]);

    // Release sendMessage — turn_end should fire, THEN turn 2 tool_use pending.
    releaseSendMessage?.();

    await startPromise;
    await handler.suspend();
    await new Promise((r) => setImmediate(r));

    const kinds = emitted.map((e) => e.kind);
    const turnEndIdx = kinds.indexOf("turn_end");
    const nextTurnToolIdx = kinds.indexOf("tool_call");

    expect(turnEndIdx).toBeGreaterThanOrEqual(0);
    expect(nextTurnToolIdx).toBeGreaterThanOrEqual(0);
    // The cardinal invariant: turn_end from turn 1 strictly precedes every
    // event from turn 2.
    expect(turnEndIdx).toBeLessThan(nextTurnToolIdx);
  });
});
