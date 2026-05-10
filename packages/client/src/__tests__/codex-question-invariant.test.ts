import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@agent-team-foundation/first-tree-hub-shared";
import type { ThreadItem } from "@openai/codex-sdk";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Codex runtime invariant: the codex handler must NEVER emit a Hub message
 * whose `format` is `"question"` or `"question_answer"`. Codex SDK 0.125
 * has no ask-user surface (verified end-to-end in `tmp-verify/verify-codex.mjs`),
 * so any such message would be a runtime regression.
 *
 * The server-side defense (commit 2 — `assertSenderMayEmitQuestion`) is the
 * load-bearing guarantee: even a buggy handler can't sneak a question
 * through. This test pins the *handler-side* invariant so the regression
 * shows up in unit tests before it ever reaches a server with the defense
 * disabled (e.g. local testcontainer with stale schema).
 *
 * Strategy: mock the codex SDK to feed every documented ThreadItem variant
 * the handler knows about (agent_message / command_execution / file_change
 * / mcp_tool_call / web_search / todo_list / reasoning / error), drive a
 * turn end-to-end, then assert:
 *   1. Every captured `sdk.sendMessage` call has `format !== "question"`
 *      and `format !== "question_answer"`.
 *   2. Every captured `emitEvent` call uses one of the documented
 *      `SessionEventKind` values (no synthetic `"question"` kind sneaks in).
 */

type CapturedSend = { chatId: string; data: Record<string, unknown> };
type CapturedEvent = SessionEvent;

// Construct the synthetic event stream the mocked thread emits. Covers every
// ThreadItem case the handler's `processItem` switch is wired for, including
// status variants (completed / failed) so the resulting events include both
// success and error tool_calls. Two `agent_message` items so the handler's
// multi-message accumulation path is exercised.
//
// Cast through `unknown` because the SDK's ThreadItem union has lots of
// optional/required nested fields we don't care about for this invariant
// test — the handler's `processItem` switch only inspects `type`, `text`,
// `command`, `changes`, `query`, `items`, `arguments`, `error`, `result`,
// `message`, and `status`. A faithful synthetic minus the unused fields is
// enough to hit every branch.
const FAKE_THREAD_ITEMS: ThreadItem[] = [
  { id: "msg-1", type: "agent_message", text: "First chunk." },
  { id: "msg-2", type: "agent_message", text: "Second chunk." },
  {
    id: "cmd-1",
    type: "command_execution",
    command: ["bash", "-c", "ls"],
    aggregated_output: "ok",
    status: "completed",
  },
  {
    id: "cmd-2",
    type: "command_execution",
    command: ["bash", "-c", "false"],
    aggregated_output: "error",
    status: "failed",
  },
  {
    id: "file-1",
    type: "file_change",
    changes: [{ path: "a.ts", kind: "update" }],
    status: "completed",
  },
  {
    id: "mcp-1",
    type: "mcp_tool_call",
    server: "test",
    tool: "tool",
    arguments: { foo: "bar" },
    status: "completed",
    result: { content: "ok" },
  },
  {
    id: "mcp-2",
    type: "mcp_tool_call",
    server: "test",
    tool: "tool",
    arguments: { foo: "bar" },
    status: "failed",
    error: { message: "boom" },
  },
  { id: "web-1", type: "web_search", query: "claude" },
  {
    id: "todo-1",
    type: "todo_list",
    items: [{ content: "do thing", status: "pending" }],
  },
  { id: "reason-1", type: "reasoning", text: "thinking..." },
  { id: "err-1", type: "error", message: "tool blew up" },
].map((item) => item as unknown as ThreadItem);

vi.mock("@openai/codex-sdk", () => {
  class FakeThread {
    public id = "thread-fake";
    async runStreamed() {
      const items = FAKE_THREAD_ITEMS;
      const events = (async function* () {
        yield { type: "thread.started", thread_id: "thread-fake" };
        yield { type: "turn.started" };
        for (const item of items) {
          yield { type: "item.started", item };
          yield { type: "item.completed", item };
        }
        yield { type: "turn.completed" };
      })();
      return { events };
    }
  }
  class FakeCodex {
    startThread(_opts?: unknown) {
      return new FakeThread();
    }
    resumeThread(_id: string, _opts?: unknown) {
      return new FakeThread();
    }
  }
  return { Codex: FakeCodex };
});

import { createCodexHandler } from "../handlers/codex.js";
import { createAgentConfigCache } from "../runtime/agent-config-cache.js";
import type { SessionContext } from "../runtime/handler.js";
import { mockCtxPlumbing } from "./test-helpers.js";

const AGENT_ID = "019d9a97-90b0-716b-8317-a8c0be8430cc";
let workspaceRoot: string;

beforeAll(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "ftt-codex-invariant-"));
});

afterAll(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});

function buildCache() {
  const stubSdk = {
    fetchAgentConfig: async () => ({
      agentId: AGENT_ID,
      version: 1,
      payload: {
        kind: "codex" as const,
        prompt: { append: "" },
        model: "",
        mcpServers: [],
        env: [],
        gitRepos: [],
      },
      updatedAt: new Date().toISOString(),
      updatedBy: "test",
    }),
  } as unknown as Parameters<typeof createAgentConfigCache>[0]["sdk"];
  return createAgentConfigCache({ sdk: stubSdk });
}

function buildSessionCtx(chatId: string, sent: CapturedSend[], events: CapturedEvent[]): SessionContext {
  const sendMessage = async (cId: string, data: Record<string, unknown>): Promise<unknown> => {
    sent.push({ chatId: cId, data });
    return { id: `msg-${sent.length}` };
  };
  return {
    agent: {
      agentId: AGENT_ID,
      inboxId: "inbox-codex",
      displayName: "Codex Agent",
      type: "autonomous_agent",
      delegateMention: null,
      metadata: {},
    },
    sdk: { serverUrl: "http://test", sendMessage } as unknown as SessionContext["sdk"],
    chatId,
    log: () => {},
    touch: () => {},
    setRuntimeState: () => {},
    emitEvent: (event) => {
      events.push(event);
    },
    reportSessionCompletion: () => {},
    ...mockCtxPlumbing({ sendMessage }, chatId),
  };
}

describe("codex handler — question/question_answer invariant", () => {
  it("never emits format=question or format=question_answer across the full ThreadItem matrix", async () => {
    const sent: CapturedSend[] = [];
    const events: CapturedEvent[] = [];

    const cache = buildCache();
    await cache.refresh(AGENT_ID);

    const handler = createCodexHandler({ workspaceRoot, agentConfigCache: cache });
    const ctx = buildSessionCtx("chat-codex-inv", sent, events);

    await handler.start(
      {
        id: "msg-in-1",
        chatId: "chat-codex-inv",
        senderId: "user",
        format: "text",
        content: "kick off the codex turn",
        metadata: null,
      },
      ctx,
    );

    // The mocked codex emits two agent_message chunks → forwardResult should
    // have published one consolidated text reply. That's the only message
    // the handler legitimately sends; assert it is text-shaped.
    expect(sent.length).toBeGreaterThanOrEqual(1);
    for (const call of sent) {
      const format = call.data.format as string | undefined;
      expect(format).not.toBe("question");
      expect(format).not.toBe("question_answer");
      // Codex handler only forwards assistant text, so we can also pin the
      // positive shape — the only non-text format that could legitimately
      // appear here is none today.
      expect(format === undefined || format === "text").toBe(true);
    }

    // Same invariant on emitEvent: no `question` kind should leak in.
    const ALLOWED_EVENT_KINDS = new Set(["tool_call", "assistant_text", "thinking", "error", "turn_end"]);
    for (const ev of events) {
      expect(ALLOWED_EVENT_KINDS.has(ev.kind)).toBe(true);
    }

    // Sanity: the test would trivially pass if the handler bailed out before
    // touching the synthetic ThreadItems. Pin that the branches we care about
    // actually executed by checking we observed both an assistant_text event
    // (from agent_message) and at least one tool_call event (from
    // command_execution / file_change / mcp_tool_call / web_search /
    // todo_list).
    expect(events.some((e) => e.kind === "assistant_text")).toBe(true);
    expect(events.some((e) => e.kind === "tool_call")).toBe(true);
    expect(events.some((e) => e.kind === "thinking")).toBe(true);
    expect(events.some((e) => e.kind === "turn_end")).toBe(true);

    await handler.shutdown();
  });
});
