import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Verifies the canUseTool bridge wired up in commit 3:
 *
 *   1. Other tools pass through with `{ behavior: "allow", updatedInput }`
 *      so existing handler behavior (Read/Write/Bash inside bypassPermissions)
 *      is preserved.
 *   2. AskUserQuestion is intercepted: the handler publishes a
 *      `format: "question"` message via the SDK and parks until the
 *      ask-user-bridge module resolves.
 *   3. A subsequent answer (delivered via `tryResolveQuestionAnswer` — what
 *      SessionManager.dispatch calls when a `question_answer` lands)
 *      surfaces back to the SDK as `{ behavior: "allow", updatedInput:
 *      { questions, answers } }`.
 *   4. Malformed input is rejected via `{ behavior: "deny" }` so a model
 *      regression can't smuggle bad data into the Hub.
 */

type CapturedCall = { options?: Record<string, unknown> };
const capturedCalls: CapturedCall[] = [];

vi.mock("@anthropic-ai/claude-agent-sdk", () => {
  const fakeQuery = {
    [Symbol.asyncIterator]() {
      return {
        next: async () => ({ done: true, value: undefined }),
      };
    },
    close: () => {},
    setModel: async () => {},
  };
  return {
    query: (args: { options?: Record<string, unknown> }) => {
      capturedCalls.push({ options: args?.options });
      return fakeQuery;
    },
  };
});

import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import {
  clearAllPendingQuestionsForTest,
  pendingQuestionCount,
  tryResolveQuestionAnswer,
} from "../handlers/ask-user-bridge.js";
import { createClaudeCodeHandler } from "../handlers/claude-code.js";
import { createAgentConfigCache } from "../runtime/agent-config-cache.js";
import type { SessionContext } from "../runtime/handler.js";
import { mockCtxPlumbing } from "./test-helpers.js";

const AGENT_ID = "019d9a97-90b0-716b-8317-a8c0be8430d8";

let workspaceRoot: string;

beforeAll(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "ftt-canusetool-bridge-"));
});

afterAll(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});

afterEach(() => {
  capturedCalls.length = 0;
  clearAllPendingQuestionsForTest();
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

type SentMessage = { chatId: string; data: Record<string, unknown> };

function buildSessionCtx(chatId: string, sentMessages: SentMessage[]): SessionContext {
  const sendMessage = async (cId: string, data: Record<string, unknown>): Promise<unknown> => {
    sentMessages.push({ chatId: cId, data });
    return undefined;
  };
  return {
    agent: {
      agentId: AGENT_ID,
      inboxId: "inbox-test",
      displayName: "test",
      type: "autonomous_agent",
      delegateMention: null,
      metadata: {},
    },
    sdk: { serverUrl: "http://test", sendMessage } as unknown as SessionContext["sdk"],
    chatId,
    log: () => {},
    touch: () => {},
    setRuntimeState: () => {},
    emitEvent: () => {},
    ...mockCtxPlumbing({ sendMessage }, chatId),
  };
}

async function startHandlerAndCaptureCanUseTool(chatId: string, sent: SentMessage[]): Promise<CanUseTool> {
  const cache = buildCache();
  await cache.refresh(AGENT_ID);
  const handler = createClaudeCodeHandler({ workspaceRoot, agentConfigCache: cache });
  const ctx = buildSessionCtx(chatId, sent);
  await handler.start(
    { id: `msg-${chatId}`, chatId, senderId: "user", format: "text", content: "hi", metadata: null },
    ctx,
  );
  const options = capturedCalls[0]?.options;
  if (typeof options?.canUseTool !== "function") {
    throw new Error("canUseTool was not registered");
  }
  return options.canUseTool as CanUseTool;
}

const baseOptions = {
  signal: new AbortController().signal,
  toolUseID: "tu_default",
};

describe("claude-code canUseTool bridge", () => {
  it("auto-allows non-AskUserQuestion tool calls without touching the inbox", async () => {
    const sent: SentMessage[] = [];
    const canUseTool = await startHandlerAndCaptureCanUseTool("chat-pass", sent);

    const result = await canUseTool("Read", { path: "/etc/hosts" }, { ...baseOptions, toolUseID: "tu_read" });
    expect(result).toEqual({ behavior: "allow", updatedInput: { path: "/etc/hosts" } });
    expect(sent).toEqual([]);
  });

  it("publishes a question message and resolves on a matching answer", async () => {
    const sent: SentMessage[] = [];
    const canUseTool = await startHandlerAndCaptureCanUseTool("chat-bridge", sent);

    const askInput = {
      questions: [
        {
          question: "Should I proceed?",
          header: "Proceed?",
          options: [
            { label: "Yes", description: "Affirmative", preview: null },
            { label: "No", description: "Negative", preview: null },
          ],
          multiSelect: false,
        },
      ],
    };

    // Kick off the bridge — DON'T await yet.
    const callPromise = canUseTool("AskUserQuestion", askInput, { ...baseOptions, toolUseID: "tu_q1" });

    // Yield once so the bridge's pre-await side effects run (sdk.sendMessage,
    // registerPendingQuestion). Then we should see exactly one outbound
    // question message.
    await Promise.resolve();
    await Promise.resolve();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.chatId).toBe("chat-bridge");
    expect(sent[0]?.data.format).toBe("question");
    expect(sent[0]?.data.content).toMatchObject({
      correlationId: "tu_q1",
      previewFormat: "html",
      allowFreeText: true,
      questions: askInput.questions,
    });

    expect(pendingQuestionCount()).toBe(1);

    // Now resolve the bridge — same shape that arrives via inbox.
    const resolved = tryResolveQuestionAnswer({
      correlationId: "tu_q1",
      answers: { "Should I proceed?": "Yes" },
    });
    expect(resolved).toBe(true);

    const result = await callPromise;
    expect(result).toEqual({
      behavior: "allow",
      updatedInput: { questions: askInput.questions, answers: { "Should I proceed?": "Yes" } },
    });
    expect(pendingQuestionCount()).toBe(0);
  });

  it("denies a malformed AskUserQuestion input without publishing anything", async () => {
    const sent: SentMessage[] = [];
    const canUseTool = await startHandlerAndCaptureCanUseTool("chat-malformed", sent);

    const result = await canUseTool(
      "AskUserQuestion",
      { questions: "not-an-array" } as unknown as Record<string, unknown>,
      { ...baseOptions, toolUseID: "tu_bad" },
    );

    expect(result).toMatchObject({ behavior: "deny" });
    expect(sent).toEqual([]);
    expect(pendingQuestionCount()).toBe(0);
  });

  it("denies when sdk.sendMessage throws (e.g. server-side codex defense)", async () => {
    const sent: SentMessage[] = [];
    const cache = buildCache();
    await cache.refresh(AGENT_ID);
    const handler = createClaudeCodeHandler({ workspaceRoot, agentConfigCache: cache });

    const sendMessage = async (_chatId: string, _body: Record<string, unknown>): Promise<unknown> => {
      throw new Error("Codex runtime cannot emit ask-user questions");
    };
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
      chatId: "chat-codex-defense",
      log: () => {},
      touch: () => {},
      setRuntimeState: () => {},
      emitEvent: () => {},
      ...mockCtxPlumbing({ sendMessage }, "chat-codex-defense"),
    };
    await handler.start(
      { id: "msg-cd", chatId: "chat-codex-defense", senderId: "user", format: "text", content: "hi", metadata: null },
      ctx,
    );

    const canUseTool = capturedCalls[0]?.options?.canUseTool as CanUseTool;
    const result = await canUseTool(
      "AskUserQuestion",
      {
        questions: [
          {
            question: "?",
            header: "Q",
            options: [
              { label: "A", description: "", preview: null },
              { label: "B", description: "", preview: null },
            ],
            multiSelect: false,
          },
        ],
      },
      { ...baseOptions, toolUseID: "tu_codex" },
    );

    expect(result).toMatchObject({ behavior: "deny" });
    expect((result as { message?: string }).message).toMatch(/Codex runtime cannot emit/);
    expect(sent).toEqual([]); // sendMessage threw before push
    expect(pendingQuestionCount()).toBe(0);
  });
});
