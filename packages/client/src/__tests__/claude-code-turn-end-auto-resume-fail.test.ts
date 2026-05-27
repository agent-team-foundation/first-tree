import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@first-tree/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * When the SDK query loop crashes and the handler attempts auto-resume but
 * `respawnQuery` itself throws (e.g. the underlying SDK rejects a `query()`
 * call synchronously), the handler must surface that failure the same way as
 * MAX_RETRIES exhaustion:
 *   - emit `kind:"error"` with `source:"runtime"` describing the auto-resume
 *     failure so the chat timeline shows an ErrorRow
 *   - emit `kind:"turn_end"` with `status:"error"` so the turn-grouping filter
 *     closes out the dropped turn
 *   - flip `runtimeState` to `"error"` so the SessionManager reclaims the slot
 *
 * Pre-fix this branch was silent like MAX_RETRIES — it only flipped the
 * runtime state and returned with no chat-visible signal.
 */

// First query() call returns a failing iterator (drives the consumer loop
// into its retry-catch). respawnQuery's next query() call throws
// SYNCHRONOUSLY, triggering the auto-resume-failed branch.
let queryCallCount = 0;
vi.mock("@anthropic-ai/claude-agent-sdk", () => {
  const makeFailingQuery = () => ({
    [Symbol.asyncIterator]() {
      return {
        next: async () => {
          throw new Error("initial sdk transport crash");
        },
      };
    },
    close: () => {},
    setModel: async () => {},
  });
  return {
    query: () => {
      queryCallCount += 1;
      if (queryCallCount >= 2) {
        // Synchronous throw — buildQuery has no try/catch around the `query()`
        // call, so this surfaces as a throw out of respawnQuery and lands in
        // the auto-resume-failed catch.
        throw new Error("respawn build failed: sdk module unavailable");
      }
      return makeFailingQuery();
    },
  };
});

import { createClaudeCodeHandler } from "../handlers/claude-code.js";
import { createAgentConfigCache } from "../runtime/agent-config-cache.js";
import type { SessionContext } from "../runtime/handler.js";
import { mockCtxPlumbing } from "./test-helpers.js";

const AGENT_ID = "019d9a97-90b0-716b-8317-a8c0be8430db";

let workspaceRoot: string;

beforeAll(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "ftt-auto-resume-fail-"));
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

describe("claude-code handler — auto-resume failure surfacing", () => {
  it("emits error + turn_end:error and flips runtimeState when respawnQuery throws", async () => {
    queryCallCount = 0;
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
        type: "agent",
        visibility: "organization",
        delegateMention: null,
        metadata: {},
      },
      sdk: { serverUrl: "http://test", sendMessage } as unknown as SessionContext["sdk"],
      chatId: "chat-resume-fail",
      log: () => {},
      touch: () => {},
      setRuntimeState: (state) => runtimeStates.push(state),
      emitEvent: (e) => emitted.push(e),
      ...mockCtxPlumbing({ sendMessage }, "chat-resume-fail"),
    };

    await handler.start(
      { id: "m1", chatId: "chat-resume-fail", senderId: "u", format: "text", content: "hi", metadata: null },
      ctx,
    );
    await handler.suspend();
    await new Promise((r) => setImmediate(r));

    const errors = emitted.filter((e) => e.kind === "error");
    expect(errors).toHaveLength(1);
    const err = errors[0];
    if (!err || err.kind !== "error") throw new Error("expected error event");
    expect(err.payload.source).toBe("runtime");
    expect(err.payload.message).toContain("Auto-resume failed");
    expect(err.payload.message).toContain("respawn build failed");

    const turnEnds = emitted.filter((e) => e.kind === "turn_end");
    expect(turnEnds).toHaveLength(1);
    const te = turnEnds[0];
    if (!te || te.kind !== "turn_end") throw new Error("expected turn_end event");
    expect(te.payload.status).toBe("error");

    // Same emit-order contract as the other error branches: error first,
    // turn_end:error after.
    const errIdx = emitted.findIndex((e) => e.kind === "error");
    const turnEndIdx = emitted.findIndex((e) => e.kind === "turn_end");
    expect(errIdx).toBeLessThan(turnEndIdx);

    // setRuntimeState("error") MUST run so the SessionManager can reclaim
    // the slot even though respawnQuery never produced a working session.
    expect(runtimeStates).toContain("error");
  });
});
