import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ProviderRetryEventPayload, parseProviderRetryEventMessage, type SessionEvent } from "@first-tree/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const BILLING_RESULT = "Failed to authenticate. API Error: 403 Insufficient account balance.";
const TRANSIENT_RESULT =
  "API Error: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()";
const mockState = vi.hoisted(() => ({
  nextMessages: [] as unknown[],
  queryCalls: 0,
  observedInputMessages: [] as Array<{ attempt: number; content: string }>,
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => {
  const drainPrompt = async (prompt: AsyncIterable<{ message?: { content?: unknown } }>, attempt: number) => {
    let drained = 0;
    for await (const sdkMsg of prompt) {
      const content = sdkMsg.message?.content;
      mockState.observedInputMessages.push({
        attempt,
        content: typeof content === "string" ? content : JSON.stringify(content),
      });
      drained += 1;
      if (drained >= 1) break;
    }
  };
  return {
    query: (args: { prompt: AsyncIterable<{ message?: { content?: unknown } }> }) => {
      mockState.queryCalls += 1;
      const attempt = mockState.queryCalls;
      const messages = mockState.nextMessages.slice();
      void drainPrompt(args.prompt, attempt);
      return {
        [Symbol.asyncIterator]() {
          let idx = 0;
          return {
            next: async () => {
              if (idx < messages.length) {
                const value = messages[idx];
                idx += 1;
                return { done: false, value };
              }
              return { done: true, value: undefined };
            },
          };
        },
        close: () => {},
        setModel: async () => {},
      };
    },
  };
});

import { createClaudeCodeHandler } from "../handlers/claude-code.js";
import { createAgentConfigCache } from "../runtime/agent-config-cache.js";
import type { SessionContext, TurnOutcome } from "../runtime/handler.js";
import { formatProviderFailureRuntimeNotice } from "../runtime/runtime-notice.js";
import { mockCtxPlumbing } from "./test-helpers.js";

const AGENT_ID = "019ef431-0000-7000-9000-000000000002";

let workspaceRoot: string;

beforeAll(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "ftt-claude-provider-error-"));
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

function providerRetryPayloads(emitted: readonly SessionEvent[]): ProviderRetryEventPayload[] {
  return emitted
    .filter((event) => event.kind === "error")
    .map((event) => parseProviderRetryEventMessage(event.payload.message))
    .filter((payload): payload is ProviderRetryEventPayload => payload !== null);
}

function firstProviderPayload(payloads: readonly ProviderRetryEventPayload[]): ProviderRetryEventPayload {
  const payload = payloads[0];
  if (!payload) throw new Error("expected provider retry event");
  return payload;
}

async function runSingleResultTurn() {
  mockState.queryCalls = 0;
  mockState.observedInputMessages.length = 0;
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  const forwardResult = vi.fn<SessionContext["forwardResult"]>().mockResolvedValue(undefined);
  const emitted: SessionEvent[] = [];
  const completed: Array<{ count: number; outcome: TurnOutcome }> = [];
  const logs: string[] = [];

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
    chatId: "chat-claude-provider-error",
    log: (m) => logs.push(m),
    recordProviderActivity: () => {},
    emitEvent: (e) => emitted.push(e),
    ...mockCtxPlumbing({ sendMessage }, "chat-claude-provider-error"),
    forwardResult,
    finishTurn: async (messages, outcome) => {
      completed.push({ count: Array.isArray(messages) ? messages.length : 1, outcome });
    },
  };

  await handler.start(
    {
      id: "m1",
      chatId: "chat-claude-provider-error",
      senderId: "user-1",
      format: "text",
      content: "hello",
      metadata: null,
    },
    ctx,
  );
  await handler.suspend();
  await new Promise((r) => setImmediate(r));

  return { sendMessage, forwardResult, emitted, completed, logs };
}

describe("claude-code handler — structured provider error result", () => {
  it("emits a provider failure and consumes a billing failure instead of forwarding final text", async () => {
    mockState.nextMessages = [
      {
        type: "result",
        subtype: "success",
        is_error: true,
        api_error_status: 403,
        result: BILLING_RESULT,
      },
    ];
    const { sendMessage, forwardResult, emitted, completed, logs } = await runSingleResultTurn();

    expect(forwardResult).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(logs.some((line) => line.includes("Claude SDK provider failure"))).toBe(true);

    const providerPayloads = providerRetryPayloads(emitted);
    expect(providerPayloads).toHaveLength(1);
    expect(providerPayloads[0]).toMatchObject({
      event: "provider_failure_terminal",
      provider: "claude-code",
      scope: "provider_turn",
      category: "provider_capacity",
      reasonCode: "provider_billing_limit",
      userSeverity: "error",
    });
    expect(formatProviderFailureRuntimeNotice(firstProviderPayload(providerPayloads))).toContain(
      "insufficient account balance",
    );

    expect(
      emitted.some(
        (event) =>
          event.kind === "error" &&
          event.payload.source === "sdk" &&
          event.payload.message.includes("provider_billing_limit"),
      ),
    ).toBe(true);
    expect(emitted.some((event) => event.kind === "turn_end" && event.payload.status === "error")).toBe(true);
    expect(completed).toEqual([
      {
        count: 1,
        outcome: {
          status: "error",
          terminal: true,
          completion: "consumed",
          reason: "provider_billing_limit",
        },
      },
    ]);
  });

  it("keeps structured auth failures as credential failures with a relogin notice", async () => {
    mockState.nextMessages = [
      {
        type: "result",
        subtype: "success",
        is_error: true,
        api_error_status: 401,
        result: "authentication_failed",
      },
    ];
    const { sendMessage, forwardResult, emitted, completed } = await runSingleResultTurn();

    expect(forwardResult).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();

    const providerPayloads = providerRetryPayloads(emitted);
    expect(providerPayloads[0]).toMatchObject({
      event: "provider_failure_terminal",
      provider: "claude-code",
      scope: "provider_turn",
      category: "credential",
      reasonCode: "provider_credential_required",
      userSeverity: "error",
    });
    expect(formatProviderFailureRuntimeNotice(firstProviderPayload(providerPayloads))).toContain("`claude auth login`");
    expect(completed[0]?.outcome).toMatchObject({
      status: "error",
      terminal: true,
      completion: "consumed",
      reason: "provider_credential_required",
    });
  });

  it("retries a transient structured failure after assistant text was emitted", async () => {
    mockState.nextMessages = [
      {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "I started working on this." }],
        },
      },
      {
        type: "result",
        subtype: "success",
        is_error: true,
        api_error_status: 503,
        result: TRANSIENT_RESULT,
      },
    ];
    const { sendMessage, forwardResult, emitted, completed } = await runSingleResultTurn();

    expect(mockState.queryCalls).toBe(3);
    expect(forwardResult).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(emitted.some((event) => event.kind === "assistant_text")).toBe(true);

    const providerPayloads = providerRetryPayloads(emitted);
    expect(providerPayloads).toHaveLength(3);
    expect(providerPayloads[0]).toMatchObject({
      event: "provider_retry_scheduled",
      provider: "claude-code",
      scope: "provider_turn",
      category: "transient_transport",
      attempt: 1,
      replaySafety: "user_visible",
    });
    expect(providerPayloads[1]).toMatchObject({
      event: "provider_retry_scheduled",
      category: "transient_transport",
      attempt: 2,
      replaySafety: "user_visible",
    });
    expect(providerPayloads[2]).toMatchObject({
      event: "provider_retry_exhausted",
      category: "transient_transport",
      replaySafety: "user_visible",
    });
    expect(formatProviderFailureRuntimeNotice(firstProviderPayload(providerPayloads))).toContain(
      "provider API connection failed after retry handling",
    );
    expect(completed[0]?.outcome).toMatchObject({
      status: "error",
      terminal: true,
      completion: "consumed",
      reason: "provider_retry_exhausted",
    });
  });

  it("keeps assistant billing_error as the primary classification for a generic 403 result", async () => {
    mockState.nextMessages = [
      {
        type: "assistant",
        error: "billing_error",
      },
      {
        type: "result",
        subtype: "success",
        is_error: true,
        api_error_status: 403,
        result: "Failed to authenticate.",
      },
    ];
    const { sendMessage, forwardResult, emitted, completed } = await runSingleResultTurn();

    expect(forwardResult).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();

    const providerPayloads = providerRetryPayloads(emitted);
    const notice = formatProviderFailureRuntimeNotice(firstProviderPayload(providerPayloads));
    expect(notice).toContain("insufficient account balance");
    expect(notice).not.toContain("`claude auth login`");
    expect(providerPayloads[0]).toMatchObject({
      event: "provider_failure_terminal",
      provider: "claude-code",
      scope: "provider_turn",
      category: "provider_capacity",
      reasonCode: "provider_billing_limit",
      userSeverity: "error",
    });
    expect(completed[0]?.outcome).toMatchObject({
      status: "error",
      terminal: true,
      completion: "consumed",
      reason: "provider_billing_limit",
    });
  });

  it("treats a 403 Request not allowed as egress even with a typed authentication_failed signal", async () => {
    // The exact mixed shape that misdiagnosed the China-network 403: a typed
    // auth signal arrives first, the 403 "Request not allowed" detail only in
    // the result. The user-visible output must lead with egress/proxy guidance
    // and must NOT pre-empt it with the auth-login hint.
    mockState.nextMessages = [
      { type: "assistant", error: "authentication_failed" },
      {
        type: "result",
        subtype: "success",
        is_error: true,
        api_error_status: 403,
        result: "Failed to authenticate. API Error: 403 Request not allowed",
      },
    ];
    const { sendMessage, emitted } = await runSingleResultTurn();

    expect(sendMessage).not.toHaveBeenCalled();
    const providerPayloads = providerRetryPayloads(emitted);
    const notice = formatProviderFailureRuntimeNotice(firstProviderPayload(providerPayloads));
    expect(notice).toContain("before authentication");
    expect(notice).toContain("daemon.env");
    expect(notice).not.toContain("rejected the local Claude authentication");
    // The deferred auth hint must be suppressed for an egress 403.
    expect(
      emitted.some(
        (event) =>
          event.kind === "error" &&
          typeof event.payload.message === "string" &&
          event.payload.message.includes("auth on this machine looks broken"),
      ),
    ).toBe(false);
  });

  it("keeps the 403 Request not allowed detail for a non-success result subtype", async () => {
    // Bypass guard: a non-success subtype where `errors` carries only the
    // opaque code must still surface the API detail so egress detection fires.
    mockState.nextMessages = [
      {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        api_error_status: 403,
        errors: ["authentication_failed"],
        result: "Failed to authenticate. API Error: 403 Request not allowed",
      },
    ];
    const { sendMessage, emitted } = await runSingleResultTurn();

    expect(sendMessage).not.toHaveBeenCalled();
    const providerPayloads = providerRetryPayloads(emitted);
    const notice = formatProviderFailureRuntimeNotice(firstProviderPayload(providerPayloads));
    expect(notice).toContain("before authentication");
    expect(notice).not.toContain("rejected the local Claude authentication");
  });

  it("does not leak a deferred auth hint when an auth_status warning is followed by success", async () => {
    mockState.nextMessages = [
      { type: "auth_status", error: "token will expire soon" },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "done" }] },
      },
      { type: "result", subtype: "success", is_error: false, result: "all good" },
    ];
    const { emitted, forwardResult } = await runSingleResultTurn();

    expect(forwardResult).toHaveBeenCalledWith("all good");
    expect(
      emitted.some(
        (event) =>
          event.kind === "error" &&
          typeof event.payload.message === "string" &&
          event.payload.message.includes("auth on this machine looks broken"),
      ),
    ).toBe(false);
  });

  it("does not sniff ordinary success result text as a provider error", async () => {
    const resultText = "API Error: 401 Unauthorized is an example the user asked about.";
    mockState.nextMessages = [
      {
        type: "result",
        subtype: "success",
        is_error: false,
        result: resultText,
      },
    ];
    const { sendMessage, forwardResult, emitted } = await runSingleResultTurn();

    expect(sendMessage).not.toHaveBeenCalled();
    expect(forwardResult).toHaveBeenCalledWith(resultText);
    expect(
      emitted
        .filter((event) => event.kind === "error")
        .some((event) => parseProviderRetryEventMessage(event.payload.message) !== null),
    ).toBe(false);
    expect(emitted.some((event) => event.kind === "turn_end" && event.payload.status === "success")).toBe(true);
  });
});
