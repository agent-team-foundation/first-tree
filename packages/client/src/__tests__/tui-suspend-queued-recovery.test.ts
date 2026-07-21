import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatContext } from "../runtime/chat-context.js";
import type { DeliveryToken, SessionContext, SessionMessage } from "../runtime/handler.js";
import { mockCtxPlumbing } from "./test-helpers.js";

type MockDrainResult = {
  entries: Array<{ type: string; message: { content: Array<{ type: string; text: string }> } }>;
  bytesRead: number;
  hasMore: boolean;
  skippedOversizedLines: number;
};

const state = vi.hoisted(() => ({
  workspaceRoot: "",
  pasteTexts: [] as string[],
  lastPasteOrdinal: 0,
  emittedOrdinals: new Set<number>(),
  emitFromOrdinal: 2,
  workingOrdinals: new Set([1]),
  tailerStartPositions: [] as string[],
  callOrder: [] as string[],
  discardStarted: false,
  discardGate: null as Promise<void> | null,
  discardError: null as Error | null,
  createError: null as Error | null,
  drainResults: [] as MockDrainResult[],
  captureEnqueueResults: [] as MockDrainResult[],
  drainCalls: 0,
  drainCallsAtFirstCapture: null as number | null,
  drainForever: false,
  chatContext: {
    chatId: "chat-tui-suspend-queued-recovery",
    title: "queued recovery",
    topic: null,
    description: null,
    participants: [],
  } satisfies ChatContext,
}));

vi.mock("../runtime/agent-bootstrap.js", () => ({
  ensureAgentBootstrap: vi.fn(),
}));

vi.mock("../runtime/agent-briefing.js", () => ({
  buildAgentBriefing: vi.fn(() => ""),
}));

vi.mock("../runtime/chat-context.js", () => ({
  fetchChatContext: vi.fn(async () => state.chatContext),
}));

vi.mock("../runtime/context-tree-git-status.js", () => ({
  createContextTreeGitWriteTracker: vi.fn(() => ({})),
}));

vi.mock("../runtime/source-repos.js", () => ({
  currentSourceRepoNamesFromPayload: vi.fn(() => null),
  declaredSourceRepos: vi.fn(() => []),
}));

vi.mock("../runtime/workspace.js", () => ({
  acquireAgentHome: vi.fn(() => state.workspaceRoot),
  markWorkspaceInitComplete: vi.fn(),
}));

vi.mock("../handlers/claude-code.js", () => ({
  createToolCallProcessor: vi.fn(() => ({
    flush: vi.fn(),
    onMessage: vi.fn(),
  })),
  mapMcpServers: vi.fn(() => []),
}));

vi.mock("../handlers/claude-executable.js", () => ({
  resolveClaudeCodeExecutable: vi.fn(() => ({ path: "/bin/claude-fake" })),
}));

vi.mock("../handlers/claude-code-tui/tmux-session.js", () => ({
  capturePane: vi.fn(async () => {
    state.drainCallsAtFirstCapture ??= state.drainCalls;
    state.drainResults.push(...state.captureEnqueueResults.splice(0));
    return state.workingOrdinals.has(state.lastPasteOrdinal) ? "esc to interrupt" : "";
  }),
  deriveSessionName: vi.fn(() => "ftth-test-session"),
  killSession: vi.fn(async () => undefined),
  listOwnedSessions: vi.fn(async () => []),
  newSession: vi.fn(async () => undefined),
  ownedSessionPrefix: vi.fn(() => "ftth-test-"),
  pasteText: vi.fn(async (_sessionName: string, text: string) => {
    state.callOrder.push("paste");
    state.pasteTexts.push(text);
    state.lastPasteOrdinal = state.pasteTexts.length;
  }),
  sendKey: vi.fn(async () => undefined),
  sessionExists: vi.fn(async () => false),
  waitForReady: vi.fn(async () => undefined),
}));

vi.mock("../handlers/claude-code-tui/transcript-tail.js", () => ({
  transcriptPathFor: vi.fn(() => "/tmp/fake-transcript.jsonl"),
  TranscriptTailer: class MockTranscriptTailer {
    static async create(_path: string, options: { startAt?: string } = {}) {
      const startAt = options.startAt ?? "start";
      state.tailerStartPositions.push(startAt);
      state.callOrder.push(`create:${startAt}`);
      if (state.createError) throw state.createError;
      return new MockTranscriptTailer();
    }

    async discardToEnd() {
      state.callOrder.push("discard:start");
      state.discardStarted = true;
      if (state.discardGate) await state.discardGate;
      if (state.discardError) throw state.discardError;
      state.callOrder.push("discard:end");
    }

    async captureWatermark() {
      return 1;
    }

    async drainEntries() {
      state.drainCalls += 1;
      const queued = state.drainResults.shift();
      if (queued) return queued;
      if (state.drainForever) {
        return { entries: [], bytesRead: 1, hasMore: true, skippedOversizedLines: 0 };
      }
      const ordinal = state.lastPasteOrdinal;
      if (ordinal < state.emitFromOrdinal || state.emittedOrdinals.has(ordinal)) {
        return { entries: [], bytesRead: 0, hasMore: false, skippedOversizedLines: 0 };
      }
      state.emittedOrdinals.add(ordinal);
      return {
        entries: [
          {
            type: "assistant",
            message: {
              content: [{ type: "text", text: `reply ${ordinal}` }],
            },
          },
        ],
        bytesRead: 1,
        hasMore: false,
        skippedOversizedLines: 0,
      };
    }
  },
}));

import { createClaudeCodeTuiHandler } from "../handlers/claude-code-tui/index.js";
import { killSession, newSession } from "../handlers/claude-code-tui/tmux-session.js";

const AGENT_ID = "019eca71-0000-7000-8000-000000000001";
const CHAT_ID = "chat-tui-suspend-queued-recovery";

function makeMessage(id: string, content: string): SessionMessage {
  return {
    id,
    chatId: CHAT_ID,
    senderId: "sender-1",
    format: "text",
    content,
    metadata: {},
    inboxEntryId: Number(id.replace(/\D/g, "")),
  };
}

function makeContext(
  opts: { formatInboundContent?: SessionContext["formatInboundContent"]; emitEvent?: SessionContext["emitEvent"] } = {},
): SessionContext {
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  const plumbing = mockCtxPlumbing({ sendMessage }, CHAT_ID);
  return {
    agent: {
      agentId: AGENT_ID,
      inboxId: `inbox_${AGENT_ID}`,
      displayName: "tui-agent",
      type: "agent",
      visibility: "organization",
      delegateMention: null,
      metadata: {},
    },
    sdk: { serverUrl: "http://test", sendMessage } as unknown as SessionContext["sdk"],
    chatId: CHAT_ID,
    log: () => {},
    recordProviderActivity: () => {},
    emitEvent: opts.emitEvent ?? (() => {}),
    ...plumbing,
    ...(opts.formatInboundContent ? { formatInboundContent: opts.formatInboundContent } : {}),
    finishTurn: vi.fn(plumbing.finishTurn),
    retryTurn: vi.fn(plumbing.retryTurn),
  };
}

function makeToken(): DeliveryToken & {
  processingStarted: ReturnType<typeof vi.fn>;
  complete: ReturnType<typeof vi.fn>;
  retry: ReturnType<typeof vi.fn>;
} {
  return {
    processingStarted: vi.fn(() => state.callOrder.push("processingStarted")),
    complete: vi.fn(async () => {
      state.callOrder.push("complete");
    }),
    retry: vi.fn(() => {
      state.callOrder.push("retry");
    }),
    terminalRejected: vi.fn(async () => {}),
  };
}

async function waitFor(assertion: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!assertion()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for assertion");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  state.workspaceRoot = mkdtempSync(join(tmpdir(), "ft-tui-suspend-queue-"));
  state.pasteTexts.length = 0;
  state.lastPasteOrdinal = 0;
  state.emittedOrdinals.clear();
  state.emitFromOrdinal = 2;
  state.workingOrdinals = new Set([1]);
  state.tailerStartPositions.length = 0;
  state.callOrder.length = 0;
  state.discardStarted = false;
  state.discardGate = null;
  state.discardError = null;
  state.createError = null;
  state.drainResults.length = 0;
  state.captureEnqueueResults.length = 0;
  state.drainCalls = 0;
  state.drainCallsAtFirstCapture = null;
  state.drainForever = false;
});

afterEach(() => {
  rmSync(state.workspaceRoot, { recursive: true, force: true });
});

describe("claude-code-tui suspend queued recovery", () => {
  it("starts claude with per-session Current Chat Context via append-system-prompt-file", async () => {
    const handler = createClaudeCodeTuiHandler({ workspaceRoot: state.workspaceRoot, clientId: "client-test" });
    const ctx = makeContext();
    const first = makeMessage("m1", "active turn");

    const start = handler.start(first, ctx);
    await waitFor(() => vi.mocked(newSession).mock.calls.length > 0);

    const command = vi.mocked(newSession).mock.calls[0]?.[0].command ?? "";
    expect(command).toContain("--append-system-prompt-file");
    const match = command.match(/--append-system-prompt-file\s+(\S+)/);
    expect(match).not.toBeNull();
    const promptPath = match?.[1];
    expect(promptPath).toBeTruthy();
    if (!promptPath) throw new Error("missing append-system-prompt-file path");
    const prompt = readFileSync(promptPath, "utf-8");
    expect(prompt).toContain('<first-tree-current-chat-context format="json">');
    expect(prompt).toContain('"chatId": "chat-tui-suspend-queued-recovery"');

    await handler.suspend();
    await start;
    expect(state.tailerStartPositions).toEqual(["start"]);
    await handler.shutdown();
  });

  it("initializes admin resume at EOF without discarding or pasting a turn", async () => {
    const handler = createClaudeCodeTuiHandler({ workspaceRoot: state.workspaceRoot, clientId: "client-test" });
    const ctx = makeContext();

    const result = await handler.resume(undefined, "existing-session", ctx, makeToken());

    expect(typeof result === "string" ? result : result.sessionId).toBe("existing-session");
    expect(state.tailerStartPositions).toEqual(["end"]);
    expect(state.callOrder).toEqual(["create:end"]);
    expect(state.pasteTexts).toEqual([]);
    await handler.shutdown();
  });

  it("orders discard before processing and paste on a messageful resume", async () => {
    state.workingOrdinals.clear();
    state.emitFromOrdinal = 1;
    const handler = createClaudeCodeTuiHandler({ workspaceRoot: state.workspaceRoot, clientId: "client-test" });
    const ctx = makeContext();
    const token = makeToken();
    const message = makeMessage("m10", "ordered resume");

    const result = await handler.resume(message, "existing-session", ctx, token);

    expect(typeof result === "string" ? null : result.route).toEqual({ kind: "owned", mode: "processing" });
    expect(state.tailerStartPositions).toEqual(["end"]);
    expect(state.callOrder.indexOf("discard:end")).toBeLessThan(state.callOrder.indexOf("processingStarted"));
    expect(state.callOrder.indexOf("processingStarted")).toBeLessThan(state.callOrder.indexOf("paste"));
    expect(token.complete).toHaveBeenCalledTimes(1);
    expect(token.retry).not.toHaveBeenCalled();
    await handler.shutdown();
  });

  it("retries without provider entry when suspend lands during async preflush", async () => {
    let releaseDiscard!: () => void;
    state.discardGate = new Promise<void>((resolve) => {
      releaseDiscard = resolve;
    });
    const handler = createClaudeCodeTuiHandler({ workspaceRoot: state.workspaceRoot, clientId: "client-test" });
    const ctx = makeContext();
    const token = makeToken();
    const message = makeMessage("m11", "suspend during discard");

    const resume = handler.resume(message, "existing-session", ctx, token);
    await waitFor(() => state.discardStarted);
    const suspend = handler.suspend();
    releaseDiscard();
    await suspend;
    const result = await resume;

    expect(typeof result === "string" ? null : result.route).toEqual({ kind: "owned", mode: "queued" });
    expect(state.pasteTexts).toEqual([]);
    expect(token.processingStarted).not.toHaveBeenCalled();
    expect(token.complete).not.toHaveBeenCalled();
    expect(token.retry).toHaveBeenCalledTimes(1);
    expect(token.retry).toHaveBeenCalledWith([message], "tui_turn_stopped_before_paste");
    await handler.shutdown();
  });

  it("retries exactly once when transcript preflush rejects even if error reporting also throws", async () => {
    state.discardError = new Error("stat denied");
    const handler = createClaudeCodeTuiHandler({ workspaceRoot: state.workspaceRoot, clientId: "client-test" });
    const ctx = makeContext({
      emitEvent: () => {
        throw new Error("event sink unavailable");
      },
    });
    const token = makeToken();
    const message = makeMessage("m12", "discard failure");

    const result = await handler.resume(message, "existing-session", ctx, token);

    expect(typeof result === "string" ? null : result.route).toEqual({ kind: "owned", mode: "queued" });
    expect(state.pasteTexts).toEqual([]);
    expect(token.processingStarted).not.toHaveBeenCalled();
    expect(token.complete).not.toHaveBeenCalled();
    expect(token.retry).toHaveBeenCalledTimes(1);
    expect(token.retry).toHaveBeenCalledWith([message], "tui_transcript_preflush_failed");
    await handler.shutdown();
  });

  it("cleans the tmux session when resume EOF initialization fails", async () => {
    state.createError = new Error("transcript stat failed");
    const handler = createClaudeCodeTuiHandler({ workspaceRoot: state.workspaceRoot, clientId: "client-test" });
    const ctx = makeContext();

    await expect(handler.resume(undefined, "existing-session", ctx, makeToken())).rejects.toThrow(
      "transcript stat failed",
    );
    expect(state.tailerStartPositions).toEqual(["end"]);
    expect(killSession).toHaveBeenCalledTimes(1);
    expect(state.pasteTexts).toEqual([]);

    await handler.shutdown();
    expect(killSession).toHaveBeenCalledTimes(1);
  });

  it("cooperatively stops a fixed-watermark backlog when the turn is aborted", async () => {
    state.workingOrdinals.clear();
    state.drainForever = true;
    const handler = createClaudeCodeTuiHandler({ workspaceRoot: state.workspaceRoot, clientId: "client-test" });
    const ctx = makeContext();
    const token = makeToken();
    const message = makeMessage("m13", "abort backlog");

    const resume = handler.resume(message, "existing-session", ctx, token);
    await waitFor(() => state.drainCalls >= 3);
    const callsAtSuspend = state.drainCalls;
    await handler.suspend();
    await resume;
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(state.drainCalls).toBeLessThanOrEqual(callsAtSuspend + 1);
    expect(token.processingStarted).toHaveBeenCalledTimes(1);
    expect(token.complete).not.toHaveBeenCalled();
    expect(token.retry).toHaveBeenCalledWith([message], "turn_aborted");
    await handler.shutdown();
  });

  it("stops a continuously non-empty fixed watermark when the turn deadline expires", async () => {
    state.workingOrdinals.clear();
    state.drainResults.push({
      entries: [
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "output before deadline" }] },
        },
      ],
      bytesRead: 1,
      hasMore: true,
      skippedOversizedLines: 0,
    });
    state.drainForever = true;
    let now = 0;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => {
      now += 100_000;
      return now;
    });
    const handler = createClaudeCodeTuiHandler({ workspaceRoot: state.workspaceRoot, clientId: "client-test" });
    const ctx = makeContext();
    const token = makeToken();

    try {
      await handler.resume(makeMessage("m14", "deadline backlog"), "existing-session", ctx, token);
    } finally {
      nowSpy.mockRestore();
    }

    expect(state.drainCalls).toBeGreaterThan(1);
    expect(state.drainCalls).toBeLessThan(10);
    expect(token.complete).not.toHaveBeenCalled();
    expect(token.retry).toHaveBeenCalledTimes(1);
    expect(token.retry).toHaveBeenCalledWith([expect.objectContaining({ id: "m14" })], "turn_timeout");
    await handler.shutdown();
  });

  it("consumes every chunk added after pane idle below one final-flush watermark", async () => {
    state.workingOrdinals.clear();
    state.emitFromOrdinal = Number.POSITIVE_INFINITY;
    state.drainResults.push({
      entries: [
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "initial chunk" }] },
        },
      ],
      bytesRead: 1,
      hasMore: false,
      skippedOversizedLines: 0,
    });
    state.captureEnqueueResults.push(
      { entries: [], bytesRead: 1, hasMore: true, skippedOversizedLines: 0 },
      { entries: [], bytesRead: 1, hasMore: true, skippedOversizedLines: 0 },
      { entries: [], bytesRead: 1, hasMore: true, skippedOversizedLines: 0 },
      {
        entries: [
          {
            type: "assistant",
            message: { content: [{ type: "text", text: "final chunk" }] },
          },
        ],
        bytesRead: 1,
        hasMore: false,
        skippedOversizedLines: 0,
      },
    );
    const handler = createClaudeCodeTuiHandler({ workspaceRoot: state.workspaceRoot, clientId: "client-test" });
    const ctx = makeContext();
    const token = makeToken();

    await handler.resume(makeMessage("m15", "large final flush"), "existing-session", ctx, token);

    expect(state.drainCallsAtFirstCapture).toBe(1);
    expect(state.drainCalls).toBeGreaterThanOrEqual(5);
    expect(token.complete).toHaveBeenCalledTimes(1);
    expect(token.retry).not.toHaveBeenCalled();
    await handler.shutdown();
  });

  it("drops handler-local queued injects on suspend so recovered messages are not pasted twice", async () => {
    const handler = createClaudeCodeTuiHandler({ workspaceRoot: state.workspaceRoot, clientId: "client-test" });
    const ctx = makeContext();
    const first = makeMessage("m1", "active turn");
    const recovered = makeMessage("m2", "queued recovered turn");

    const start = handler.start(first, ctx);
    await waitFor(() => state.pasteTexts.some((text) => text.includes("active turn")));

    handler.inject(recovered);
    await handler.suspend();
    const startResult = await start;
    const sessionId = typeof startResult === "string" ? startResult : startResult.sessionId;

    await handler.resume(recovered, sessionId, ctx);
    await new Promise((resolve) => setImmediate(resolve));

    const recoveredPastes = state.pasteTexts.filter((text) => text.includes("queued recovered turn"));
    expect(recoveredPastes).toHaveLength(1);

    const finishTurn = vi.mocked(ctx.finishTurn);
    const recoveredFinishes = finishTurn.mock.calls.filter((call) => {
      const messages = Array.isArray(call[0]) ? call[0] : [call[0]];
      return messages.some((message) => message.id === recovered.id);
    });
    expect(recoveredFinishes).toHaveLength(1);

    await handler.shutdown();
  });

  it("does not paste a drained queued batch when suspend arrives during formatting", async () => {
    const handler = createClaudeCodeTuiHandler({ workspaceRoot: state.workspaceRoot, clientId: "client-test" });
    const queued = makeMessage("m2", "format-held queued turn");
    let formattingStarted = false;
    let releaseFormat!: () => void;
    const formatGate = new Promise<void>((resolve) => {
      releaseFormat = resolve;
    });
    const ctx = makeContext({
      formatInboundContent: async (message) => {
        if (message.id === queued.id) {
          formattingStarted = true;
          await formatGate;
        }
        const raw = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
        return `[From: ${message.senderId}]\n\n${raw}`;
      },
    });

    await handler.resume(undefined, "existing-session", ctx);

    handler.inject(queued);
    await waitFor(() => formattingStarted);

    const suspend = handler.suspend();
    await Promise.resolve();
    releaseFormat();
    await suspend;
    await new Promise((resolve) => setImmediate(resolve));

    expect(state.pasteTexts.some((text) => text.includes("format-held queued turn"))).toBe(false);
    expect(ctx.finishTurn).not.toHaveBeenCalled();
    expect(ctx.retryTurn).toHaveBeenCalledWith(queued, "queued_turn_stopped_before_paste");

    await handler.shutdown();
  });

  it("retries a queued batch when all inbound formatting fails before paste", async () => {
    const handler = createClaudeCodeTuiHandler({ workspaceRoot: state.workspaceRoot, clientId: "client-test" });
    const queued = makeMessage("m3", "format-fail queued turn");
    const ctx = makeContext({
      formatInboundContent: async (message) => {
        if (message.id === queued.id) throw new Error("format failed");
        const raw = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
        return `[From: ${message.senderId}]\n\n${raw}`;
      },
    });

    await handler.resume(undefined, "existing-session", ctx);
    handler.inject(queued);

    await waitFor(() => vi.mocked(ctx.retryTurn).mock.calls.length > 0);

    expect(state.pasteTexts.some((text) => text.includes("format-fail queued turn"))).toBe(false);
    expect(ctx.finishTurn).not.toHaveBeenCalled();
    expect(ctx.retryTurn).toHaveBeenCalledWith(queued, "tui_queued_turn_format_failed");

    await handler.shutdown();
  });

  it.each([
    {
      name: "first failed and second succeeded",
      failingIds: new Set(["m4"]),
      messages: [makeMessage("m4", "bad first"), makeMessage("m5", "good second")],
    },
    {
      name: "first succeeded and second failed",
      failingIds: new Set(["m5"]),
      messages: [makeMessage("m4", "good first"), makeMessage("m5", "bad second")],
    },
  ])("retries the whole queued batch when mixed formatting occurs: $name", async ({ failingIds, messages }) => {
    const handler = createClaudeCodeTuiHandler({ workspaceRoot: state.workspaceRoot, clientId: "client-test" });
    const ctx = makeContext({
      formatInboundContent: async (message) => {
        if (failingIds.has(message.id)) throw new Error(`format failed for ${message.id}`);
        const raw = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
        return `[From: ${message.senderId}]\n\n${raw}`;
      },
    });

    await handler.resume(undefined, "existing-session", ctx);
    for (const message of messages) handler.inject(message);

    await waitFor(() => vi.mocked(ctx.retryTurn).mock.calls.length >= messages.length);

    expect(state.pasteTexts.some((text) => text.includes("bad first") || text.includes("good first"))).toBe(false);
    expect(state.pasteTexts.some((text) => text.includes("bad second") || text.includes("good second"))).toBe(false);
    expect(ctx.finishTurn).not.toHaveBeenCalled();
    for (const message of messages) {
      expect(ctx.retryTurn).toHaveBeenCalledWith(message, "tui_queued_turn_format_failed");
    }

    await handler.shutdown();
  });
});
