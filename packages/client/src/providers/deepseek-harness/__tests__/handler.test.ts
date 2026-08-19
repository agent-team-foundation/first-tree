import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { type AgentRuntimeConfigPayload, parseProviderRetryEventMessage, type SessionEvent as FtSessionEvent } from "@first-tree/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockCtxPlumbing } from "../../../__tests__/test-helpers.js";
import type { DeliveryToken, SessionContext, SessionMessage, TurnOutcome } from "../../../runtime/handler.js";
import { formatProviderFailureRuntimeNotice } from "../../../runtime/runtime-notice.js";
import {
  createDeepseekHandler,
  DEEPSEEK_PENDING_SESSION_PREFIX,
  isDeepseekPendingSessionId,
} from "../index.js";

type FakeRunResult = {
  sessionId: string;
  finalResponse: string;
  events: SessionEvent[];
};

class FakeHarnessSession {
  constructor(
    readonly id: string,
    private readonly script: () => FakeRunResult | Promise<FakeRunResult>,
    private readonly onRun?: (prompt: string) => void,
  ) {}

  async run(prompt: string): Promise<FakeRunResult> {
    this.onRun?.(prompt);
    return this.script();
  }
}

class FakeHarness {
  readonly sessions = new Map<string, FakeHarnessSession>();
  start = vi.fn(async () => {});
  close = vi.fn(async () => {});
  session(sessionId?: string): FakeHarnessSession {
    const id = sessionId ?? "sess-new";
    const existing = this.sessions.get(id);
    if (existing) return existing;
    throw new Error(`unexpected session(${id})`);
  }
}

function makePayload(
  over: Partial<Omit<Extract<AgentRuntimeConfigPayload, { kind: "deepseek-harness" }>, "kind">> = {},
): Extract<AgentRuntimeConfigPayload, { kind: "deepseek-harness" }> {
  return {
    kind: "deepseek-harness",
    prompt: { append: "" },
    model: "",
    mcpServers: [],
    env: [],
    gitRepos: [],
    resourceSkills: [],
    ...over,
  };
}

function makeToken(): DeliveryToken & { completed: TurnOutcome[]; retried: string[] } {
  const completed: TurnOutcome[] = [];
  const retried: string[] = [];
  return {
    completed,
    retried,
    processingStarted: () => {},
    complete: async (_messages, outcome) => {
      completed.push(outcome);
    },
    retry: (_messages, reason) => {
      retried.push(reason);
    },
    terminalRejected: async () => {},
  };
}

function makeMessage(id: string, content: string): SessionMessage {
  return {
    inboxEntryId: 1,
    id,
    chatId: "chat-deepseek",
    senderId: "human-1",
    format: "text",
    content,
    metadata: {},
  };
}

let workspaceRoot: string;
let harness: FakeHarness;
let runScript: () => FakeRunResult | Promise<FakeRunResult>;

function makeContext(opts: {
  events: FtSessionEvent[];
  forwardResult?: (text: string) => Promise<void>;
  replaceSessionId?: (sessionId: string, reason: string) => void;
}): SessionContext {
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  const plumbing = mockCtxPlumbing({ sendMessage }, "chat-deepseek");
  return {
    agent: {
      agentId: "agent-deepseek-1",
      inboxId: "inbox_agent-deepseek-1",
      displayName: "deepseek-assistant",
      type: "agent",
      visibility: "organization",
      delegateMention: null,
      metadata: {},
    },
    sdk: {
      serverUrl: "https://first-tree.test",
      sendMessage,
      getAgentContextTreeConfig: async () => ({
        bindingState: "invalid",
        repo: null,
        branch: null,
        provider: null,
      }),
    } as unknown as SessionContext["sdk"],
    chatId: "chat-deepseek",
    log: () => {},
    buildAgentEnv: (env) => env,
    formatInboundContent: async (message) => message.content,
    forwardResult: opts.forwardResult ?? (async () => {}),
    emitEvent: (event) => {
      opts.events.push(event);
    },
    recordProviderActivity: () => {},
    ...plumbing,
    ...(opts.replaceSessionId ? { replaceSessionId: opts.replaceSessionId } : {}),
  };
}

function makeHandler(extraConfig: Record<string, unknown> = {}) {
  const payload = (extraConfig.payload as AgentRuntimeConfigPayload | undefined) ?? makePayload();
  const runtimeConfig = {
    agentId: "agent-deepseek-1",
    version: 1,
    payload,
    updatedAt: new Date(0).toISOString(),
    updatedBy: "test",
  };
  return createDeepseekHandler({
    workspaceRoot,
    agentName: "deepseek-test-agent",
    runtimeProvider: "deepseek-harness",
    deepseekTurnTimeoutMs: 5_000,
    deepseekRuntimeResolver: () => ({
      ok: true,
      binary: "/bin/dsh-jsonrpc-agent",
      cordisPath: join(workspaceRoot, "cordis.yml"),
    }),
    deepseekHarnessFactory: () => {
      harness.session = (sessionId?: string) => new FakeHarnessSession(sessionId ?? "sess-new", () => runScript());
      return harness;
    },
    agentConfigCache: {
      refresh: async () => runtimeConfig,
      get: () => runtimeConfig,
    },
    ...extraConfig,
  });
}

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "ft-deepseek-handler-"));
  harness = new FakeHarness();
  runScript = () => ({
    sessionId: "sess-new",
    finalResponse: "done",
    events: [
      {
        type: "assistant/chunk",
        seq: 1,
        data: {
          turn: 1,
          step: 1,
          chunk: { type: "text-delta", index: 0, text: "done" },
        },
      },
    ],
  });
});

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});

describe("DeepSeek handler", () => {
  it("tracks pending session ids", () => {
    expect(isDeepseekPendingSessionId(`${DEEPSEEK_PENDING_SESSION_PREFIX}abc`)).toBe(true);
    expect(isDeepseekPendingSessionId("sess-123")).toBe(false);
  });

  it("completes a turn through the SDK harness and streams assistant text", async () => {
    const events: FtSessionEvent[] = [];
    const ctx = makeContext({ events });
    const token = makeToken();
    const handler = makeHandler();

    const result = await handler.start(makeMessage("m1", "hello"), ctx, token);
    expect(result.sessionId).toBe("sess-new");
    expect(result.route).toEqual({ kind: "owned", mode: "processing" });
    expect(token.completed).toEqual([{ status: "success" }]);
    expect(events.some((event) => event.kind === "assistant_text")).toBe(true);
    expect(harness.start).toHaveBeenCalledTimes(1);
  });

  it("fails closed on managed MCP configuration", async () => {
    const events: FtSessionEvent[] = [];
    const ctx = makeContext({ events });
    const token = makeToken();
    const handler = makeHandler({
      payload: makePayload({
        mcpServers: [{ name: "demo", transport: "stdio", command: "echo", args: [] }],
      }),
    });

    await handler.start(makeMessage("m1", "hello"), ctx, token);
    expect(token.completed[0]?.status).toBe("error");
    const retryEvent = events
      .map((event) => (event.kind === "error" ? parseProviderRetryEventMessage(event.payload.message) : null))
      .find(Boolean);
    expect(retryEvent?.category).toBe("configuration");
    expect(formatProviderFailureRuntimeNotice(retryEvent!)).toContain("configuration needs attention");
    expect(harness.start).not.toHaveBeenCalled();
  });

  it("surfaces credential failures without retaining API key material", async () => {
    runScript = () => ({
      sessionId: "sess-auth",
      finalResponse: "",
      events: [
        {
          type: "turn/end",
          seq: 1,
          data: {
            turn: 1,
            reason: {
              kind: "error",
              error: {
                code: "MISSING_CREDENTIAL",
                message: "DEEPSEEK_API_KEY=qa-secret set DEEPSEEK_API_KEY",
              },
            },
          },
        },
      ],
    });
    const events: FtSessionEvent[] = [];
    const ctx = makeContext({ events });
    const token = makeToken();
    const handler = makeHandler();

    await handler.start(makeMessage("m1", "hello"), ctx, token);
    expect(token.completed[0]?.status).toBe("error");
    const sdkError = events.find((event) => event.kind === "error" && event.payload.source === "sdk");
    expect(JSON.stringify(sdkError)).not.toContain("qa-secret");
  });
});
