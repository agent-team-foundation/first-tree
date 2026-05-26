import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@first-tree/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * When the SDK query loop throws (process crash, transport reset, etc.) and
 * the handler exhausts its MAX_RETRIES budget, it must surface the failure
 * the same way as the other error branches:
 *   - emit `kind:"error"` with `source:"runtime"`, carrying the underlying
 *     error message, so the chat timeline's ErrorRow renders the failure
 *   - emit `kind:"turn_end"` with `status:"error"` so the turn-grouping
 *     filter on the frontend closes out the failed turn
 *
 * Pre-fix this path was silent — it only flipped runtimeState to "error"
 * (so the SessionManager could reclaim the slot) and returned, leaving the
 * chat with no visible signal that the agent had crashed.
 */

// Every query() call returns an iterator that throws on first .next() — the
// handler should retry up to MAX_RETRIES (= 2) times, hitting three failures
// total, then bail through the retry-exhausted branch.
vi.mock("@anthropic-ai/claude-agent-sdk", () => {
  const makeFailingQuery = () => ({
    [Symbol.asyncIterator]() {
      return {
        next: async () => {
          throw new Error("sdk transport crashed");
        },
      };
    },
    close: () => {},
    setModel: async () => {},
  });
  return { query: () => makeFailingQuery() };
});

import { createClaudeCodeHandler } from "../handlers/claude-code.js";
import { createAgentConfigCache } from "../runtime/agent-config-cache.js";
import type { SessionContext } from "../runtime/handler.js";
import { mockCtxPlumbing } from "./test-helpers.js";

const AGENT_ID = "019d9a97-90b0-716b-8317-a8c0be8430da";

let workspaceRoot: string;

beforeAll(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "ftt-retry-exhausted-"));
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

describe("claude-code handler — retry-exhausted surfacing", () => {
  it("emits error + turn_end:error and flips runtimeState to error after MAX_RETRIES", async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const emitted: SessionEvent[] = [];
    const runtimeStates: string[] = [];

    const cache = buildCache();
    await cache.refresh(AGENT_ID);

    const handler = createClaudeCodeHandler({ workspaceRoot, agentConfigCache: cache });
    const ctx: SessionContext = {
      agent: {
        agentId: AGENT_ID,
        inboxId: "inbox-test",
        displayName: "test",
        type: "autonomous_agent",
        delegateMention: null,
        metadata: {},
      },
      sdk: { serverUrl: "http://test", sendMessage } as unknown as SessionContext["sdk"],
      chatId: "chat-retry",
      log: () => {},
      touch: () => {},
      setRuntimeState: (state) => runtimeStates.push(state),
      emitEvent: (e) => emitted.push(e),
      ...mockCtxPlumbing({ sendMessage }, "chat-retry"),
    };

    await handler.start(
      { id: "m1", chatId: "chat-retry", senderId: "u", format: "text", content: "hi", metadata: null },
      ctx,
    );
    await handler.suspend();
    await new Promise((r) => setImmediate(r));

    // Result auto-forward never ran — every iteration threw.
    expect(sendMessage).not.toHaveBeenCalled();

    const errors = emitted.filter((e) => e.kind === "error");
    expect(errors).toHaveLength(1);
    const err = errors[0];
    if (!err || err.kind !== "error") throw new Error("expected error event");
    expect(err.payload.source).toBe("runtime");
    expect(err.payload.message).toContain("Query failed after 2 retries");
    expect(err.payload.message).toContain("sdk transport crashed");

    const turnEnds = emitted.filter((e) => e.kind === "turn_end");
    expect(turnEnds).toHaveLength(1);
    const te = turnEnds[0];
    if (!te || te.kind !== "turn_end") throw new Error("expected turn_end event");
    expect(te.payload.status).toBe("error");

    // Emit order: error first, then turn_end:error — same contract as the
    // SDK-subtype-error and result-forward-failure branches so the chat UI's
    // turn-grouping filter behaves identically across error paths.
    const errIdx = emitted.findIndex((e) => e.kind === "error");
    const turnEndIdx = emitted.findIndex((e) => e.kind === "turn_end");
    expect(errIdx).toBeLessThan(turnEndIdx);

    // setRuntimeState("error") MUST run so the SessionManager's idle path
    // can reclaim the slot. (Pre-fix this was the only signal of failure.)
    expect(runtimeStates).toContain("error");
  });

  it("still flips runtimeState to error even when emitEvent throws", async () => {
    // Defensive contract: if the onSessionEvent callback throws (e.g. the
    // agent-slot reporting hits a dead WS), the handler must still run
    // setRuntimeState("error") so the SessionManager can reclaim the slot.
    // Without this, the session stays counted as `working` forever.
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const runtimeStates: string[] = [];

    const cache = buildCache();
    await cache.refresh(AGENT_ID);

    const handler = createClaudeCodeHandler({ workspaceRoot, agentConfigCache: cache });
    const ctx: SessionContext = {
      agent: {
        agentId: AGENT_ID,
        inboxId: "inbox-test",
        displayName: "test",
        type: "autonomous_agent",
        delegateMention: null,
        metadata: {},
      },
      sdk: { serverUrl: "http://test", sendMessage } as unknown as SessionContext["sdk"],
      chatId: "chat-retry-emit-throw",
      log: () => {},
      touch: () => {},
      setRuntimeState: (state) => runtimeStates.push(state),
      emitEvent: () => {
        throw new Error("event sink down");
      },
      ...mockCtxPlumbing({ sendMessage }, "chat-retry-emit-throw"),
    };

    await handler.start(
      { id: "m1", chatId: "chat-retry-emit-throw", senderId: "u", format: "text", content: "hi", metadata: null },
      ctx,
    );
    await handler.suspend();
    await new Promise((r) => setImmediate(r));

    expect(runtimeStates).toContain("error");
  });
});
