import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@first-tree/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatContext } from "../runtime/chat-context.js";
import type { SessionContext, SessionMessage } from "../runtime/handler.js";
import { mockCtxPlumbing } from "./test-helpers.js";

type MockState = {
  runInputs: unknown[];
  turns: unknown[][];
  startThreadError: Error | null;
  resumeThreadError: Error | null;
};

const state = vi.hoisted<MockState>(() => ({
  runInputs: [],
  turns: [],
  startThreadError: null,
  resumeThreadError: null,
}));

vi.mock("@openai/codex-sdk", () => {
  const thread = {
    id: "thread-item-coverage",
    async runStreamed(input: unknown) {
      state.runInputs.push(input);
      const idx = state.runInputs.length - 1;
      const events = state.turns[idx] ?? [];
      if (events[0] instanceof Error) throw events[0];
      return {
        events: (async function* () {
          yield { type: "thread.started", thread_id: "thread-item-coverage" };
          for (const event of events) {
            if (event instanceof Error) throw event;
            yield event;
          }
        })(),
      };
    },
  };

  return {
    Codex: class {
      startThread() {
        if (state.startThreadError) throw state.startThreadError;
        return thread;
      }
      resumeThread() {
        if (state.resumeThreadError) throw state.resumeThreadError;
        return thread;
      }
    },
  };
});

vi.mock("../runtime/bootstrap.js", () => ({
  FIRST_TREE_RUNTIME_DIR: ".first-tree-workspace",
  FIRST_TREE_WORKSPACE_MARKER: ".first-tree-workspace",
  bootstrapWorkspace: vi.fn(),
  deepEqualIdentity: vi.fn(() => true),
  ensureWorkspaceRuntimeDir: vi.fn((workspacePath: string) => {
    const dir = join(workspacePath, ".first-tree-workspace");
    mkdirSync(dir, { recursive: true });
    return dir;
  }),
  installCoreSkills: vi.fn(),
  installFirstTreeIntegration: vi.fn(() => true),
  isHubWorktreeMarker: vi.fn(() => false),
  readCachedBundledCliVersion: vi.fn(() => null),
  readCachedContextTreeHead: vi.fn(() => null),
  readContextTreeHead: vi.fn(() => null),
  resolveBundledCliVersion: vi.fn(() => "0.0.0-test"),
  writeAgentBriefing: vi.fn(),
  writeBundledCliVersion: vi.fn(),
  writeContextTreeHead: vi.fn(),
}));

vi.mock("../runtime/chat-context.js", () => ({
  fetchChatContext: vi.fn(async (): Promise<ChatContext> => ({
    chatId: "chat-item",
    title: "items",
    topic: null,
    description: null,
    participants: [],
  })),
}));

import { createCodexSdkHandler } from "../handlers/codex/sdk.js";

const AGENT_ID = "019e71c9-88d2-70be-be67-fdb033b2ef0b";
let workspaceRoot: string;

function makeMessage(id: string, content: string): SessionMessage {
  return {
    id,
    chatId: "chat-item",
    senderId: "sender-1",
    format: "text",
    content,
    metadata: {},
  };
}

function makeContext(opts: {
  emitEvent?: SessionContext["emitEvent"];
  finishTurn?: SessionContext["finishTurn"];
  retryTurn?: SessionContext["retryTurn"];
  failSessionForRecovery?: SessionContext["failSessionForRecovery"];
  log?: SessionContext["log"];
} = {}): SessionContext {
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  return {
    agent: {
      agentId: AGENT_ID,
      inboxId: `inbox_${AGENT_ID}`,
      displayName: "codex",
      type: "agent",
      visibility: "organization",
      delegateMention: null,
      metadata: {},
    },
    sdk: { serverUrl: "http://test", sendMessage } as unknown as SessionContext["sdk"],
    chatId: "chat-item",
    log: opts.log ?? (() => {}),
    recordProviderActivity: () => {},
    emitEvent: opts.emitEvent ?? (() => {}),
    ...mockCtxPlumbing({ sendMessage }, "chat-item"),
    forwardResult: async () => {},
    finishTurn: opts.finishTurn ?? (async () => {}),
    retryTurn: opts.retryTurn ?? (() => {}),
    ...(opts.failSessionForRecovery ? { failSessionForRecovery: opts.failSessionForRecovery } : {}),
  };
}

function usageEvent(total = 5) {
  return {
    type: "turn.completed",
    usage: {
      input_tokens: total,
      cached_input_tokens: 0,
      output_tokens: 1,
      reasoning_output_tokens: 0,
    },
  };
}

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "ft-codex-sdk-items-"));
  state.runInputs.length = 0;
  state.turns = [];
  state.startThreadError = null;
  state.resumeThreadError = null;
});

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});

describe("codex SDK processItem coverage", () => {
  it("emits tool_call / thinking / error events for every item type", async () => {
    const emitEvent = vi.fn<(event: SessionEvent) => void>();
    state.turns = [
      [
        {
          type: "item.completed",
          item: { type: "agent_message", id: "blank", text: "   " },
        },
        {
          type: "item.completed",
          item: {
            type: "command_execution",
            id: "cmd-1",
            status: "completed",
            command: "echo hi",
            aggregated_output: "hi",
          },
        },
        {
          type: "item.completed",
          item: {
            type: "command_execution",
            id: "cmd-2",
            status: "failed",
            command: "false",
            aggregated_output: "err",
          },
        },
        {
          type: "item.completed",
          item: {
            type: "command_execution",
            id: "cmd-3",
            status: "in_progress",
            command: "sleep 1",
          },
        },
        {
          type: "item.completed",
          item: {
            type: "file_change",
            id: "fc-1",
            status: "completed",
            changes: [{ path: "a.ts", kind: "add" }],
          },
        },
        {
          type: "item.completed",
          item: {
            type: "file_change",
            id: "fc-2",
            status: "failed",
            changes: [{ path: "b.ts", kind: "update" }],
          },
        },
        {
          type: "item.completed",
          item: {
            type: "mcp_tool_call",
            id: "mcp-1",
            status: "completed",
            server: "docs",
            tool: "search",
            arguments: { q: "x" },
            result: { content: [{ type: "text", text: "ok" }] },
          },
        },
        {
          type: "item.completed",
          item: {
            type: "mcp_tool_call",
            id: "mcp-2",
            status: "failed",
            server: "docs",
            tool: "get",
            arguments: {},
            error: { message: "timeout" },
          },
        },
        {
          type: "item.completed",
          item: {
            type: "mcp_tool_call",
            id: "mcp-3",
            status: "in_progress",
            server: "docs",
            tool: "pending",
            arguments: {},
          },
        },
        {
          type: "item.completed",
          item: { type: "web_search", id: "ws-1", query: "first tree" },
        },
        {
          type: "item.completed",
          item: { type: "todo_list", id: "todo-1", items: [{ text: "a", completed: false }] },
        },
        {
          type: "item.completed",
          item: { type: "reasoning", id: "r-1", text: "thinking..." },
        },
        {
          type: "item.completed",
          item: {
            type: "error",
            id: "e-1",
            message: "Your access token could not be refreshed because your refresh token was revoked.",
          },
        },
        {
          type: "item.completed",
          item: { type: "unknown_kind", id: "u-1" },
        },
        {
          type: "item.completed",
          item: {
            type: "agent_message",
            id: "msg-1",
            text: "final answer",
          },
        },
        usageEvent(8),
      ],
    ];

    const handler = createCodexSdkHandler({
      workspaceRoot,
      runtimeProvider: "codex",
      contextTreePath: join(workspaceRoot, "tree"),
      contextTreeRepoUrl: "https://github.com/acme/tree",
      contextTreeBranch: "main",
    });
    mkdirSync(join(workspaceRoot, "tree"), { recursive: true });
    const ctx = makeContext({ emitEvent });
    await handler.start(makeMessage("m1", "go"), ctx);

    const kinds = emitEvent.mock.calls.map(([e]) => e.kind);
    expect(kinds).toContain("tool_call");
    expect(kinds).toContain("thinking");
    expect(kinds).toContain("error");
    expect(kinds).toContain("assistant_text");
    expect(kinds.filter((k) => k === "tool_call").length).toBeGreaterThanOrEqual(7);

    await handler.shutdown();
  });

  it("handles turn.failed and stream errors with retry classification", async () => {
    const emitEvent = vi.fn<(event: SessionEvent) => void>();
    const retryTurn = vi.fn();
    const finishTurn = vi.fn(async () => {});
    state.turns = [
      [
        {
          type: "turn.failed",
          error: { message: "HTTP 503 Service Unavailable" },
        },
      ],
    ];
    const handler = createCodexSdkHandler({ workspaceRoot, runtimeProvider: "codex" });
    const ctx = makeContext({ emitEvent, retryTurn, finishTurn });
    await handler.start(makeMessage("m1", "go"), ctx);
    expect(retryTurn.mock.calls.length + finishTurn.mock.calls.length).toBeGreaterThan(0);
    await handler.shutdown();
  });

  it("surfaces startThread failures through failSessionForRecovery when present", async () => {
    state.startThreadError = new Error("Unable to locate Codex CLI binaries");
    const failSessionForRecovery = vi.fn();
    const handler = createCodexSdkHandler({ workspaceRoot, runtimeProvider: "codex" });
    const ctx = makeContext({ failSessionForRecovery });
    await expect(handler.start(makeMessage("m1", "go"), ctx)).rejects.toThrow(/Unable to locate|Codex CLI/i);
  });

  it("covers inject, suspend, and shutdown lifecycle", async () => {
    state.turns = [
      [
        {
          type: "item.completed",
          item: { type: "agent_message", id: "a", text: "first" },
        },
        usageEvent(3),
      ],
      [
        {
          type: "item.completed",
          item: { type: "agent_message", id: "b", text: "second" },
        },
        usageEvent(6),
      ],
    ];
    const handler = createCodexSdkHandler({ workspaceRoot, runtimeProvider: "codex" });
    const ctx = makeContext();
    await handler.start(makeMessage("m1", "first"), ctx);
    handler.inject?.(makeMessage("m2", "second"));
    await new Promise((r) => setTimeout(r, 50));
    await handler.suspend?.();
    await handler.shutdown?.("done");
  });

  it("resumes a thread and processes stream events", async () => {
    const emitEvent = vi.fn<(event: SessionEvent) => void>();
    state.turns = [
      [
        {
          type: "item.completed",
          item: { type: "agent_message", id: "a", text: "resumed reply" },
        },
        usageEvent(4),
      ],
    ];
    const handler = createCodexSdkHandler({ workspaceRoot, runtimeProvider: "codex" });
    const ctx = makeContext({ emitEvent });
    await handler.resume(makeMessage("m1", "again"), "thread-item-coverage", ctx);
    expect(emitEvent.mock.calls.some(([e]) => e.kind === "assistant_text")).toBe(true);
    await handler.shutdown();
  });

  it("builds mcp config and env from agent config cache", async () => {
    const config = {
      agentId: AGENT_ID,
      version: 1,
      payload: {
        kind: "codex" as const,
        prompt: { append: "extra" },
        model: "gpt-5",
        mcpServers: [
          { transport: "stdio" as const, name: "local", command: "node", args: ["m.js"] },
          { transport: "http" as const, name: "remote", url: "https://mcp.example" },
        ],
        env: [{ key: "CODEX_TEST", value: "1" }],
        gitRepos: [],
        resourceSkills: [],
        reasoningEffort: "medium" as const,
      },
      updatedAt: "",
      updatedBy: "",
    };
    const cache = {
      get: () => config,
      refresh: async () => config,
      maybeRefresh: async () => config,
      updateUrls: () => {},
      forget: () => {},
    };
    state.turns = [
      [
        {
          type: "item.completed",
          item: { type: "agent_message", id: "a", text: "ok" },
        },
        usageEvent(2),
      ],
    ];
    const handler = createCodexSdkHandler({
      workspaceRoot,
      runtimeProvider: "codex",
      agentConfigCache: cache as never,
    });
    await handler.start(makeMessage("m1", "hi"), makeContext());
    await handler.shutdown();
  });
});
