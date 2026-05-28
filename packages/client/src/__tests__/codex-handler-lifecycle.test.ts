import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntimeConfigPayload, SessionEvent } from "@first-tree/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfigCache } from "../runtime/agent-config-cache.js";
import { FIRST_TREE_WORKSPACE_MARKER } from "../runtime/bootstrap.js";
import type { SessionContext, SessionMessage } from "../runtime/handler.js";

const codexSdkMock = vi.hoisted(() => {
  const codexOptions: unknown[] = [];
  const threadOptions: unknown[] = [];
  const runInputs: unknown[] = [];
  const runScripts: (unknown[] | Error)[] = [];
  const threadIds: (string | null)[] = [];

  async function* eventStream(events: unknown[]): AsyncGenerator<unknown> {
    for (const event of events) {
      yield event;
    }
  }

  const defaultEvents = () => [
    { type: "thread.started", thread_id: "thread-from-event" },
    { type: "item.completed", item: { type: "agent_message", text: "Default reply" } },
    {
      type: "turn.completed",
      usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 0 },
    },
  ];

  class FakeThread {
    id: string | null;

    constructor(id: string | null) {
      this.id = id;
    }

    async runStreamed(input: unknown): Promise<{ events: AsyncGenerator<unknown> }> {
      runInputs.push(input);
      const events = runScripts.shift() ?? defaultEvents();
      if (events instanceof Error) throw events;
      return { events: eventStream(events) };
    }
  }

  class FakeCodex {
    constructor(options: unknown) {
      codexOptions.push(options);
    }

    startThread(options: unknown): FakeThread {
      threadOptions.push(options);
      return new FakeThread(threadIds.length > 0 ? (threadIds.shift() ?? null) : "thread-from-property");
    }

    resumeThread(_sessionId: string, options: unknown): FakeThread {
      threadOptions.push(options);
      return new FakeThread(threadIds.length > 0 ? (threadIds.shift() ?? null) : "thread-from-property");
    }
  }

  return { Codex: FakeCodex, codexOptions, runInputs, runScripts, threadIds, threadOptions };
});

vi.mock("@openai/codex-sdk", () => ({ Codex: codexSdkMock.Codex }));

function payload(): AgentRuntimeConfigPayload {
  return {
    kind: "codex",
    prompt: { append: "Follow the test playbook." },
    model: "gpt-test",
    mcpServers: [
      { name: "local", transport: "stdio", command: "node", args: ["server.js"] },
      { name: "remote", transport: "http", url: "https://mcp.example.test", headers: { Authorization: "Bearer test" } },
    ],
    env: [{ key: "EXTRA_TOKEN", value: "secret", sensitive: true }],
    gitRepos: [{ url: "https://github.com/agent-team-foundation/first-tree", localPath: "first-tree" }],
  };
}

function message(id: string, content = "Run checks"): SessionMessage {
  return {
    id,
    chatId: "chat-1",
    senderId: "agent-human",
    format: "text",
    content,
    metadata: {},
  };
}

function createContext(events: SessionEvent[], forwarded: string[], logs: string[], states: string[]): SessionContext {
  return {
    agent: {
      agentId: "agent-codex",
      inboxId: "inbox-agent-codex",
      displayName: "Codex Tester",
      type: "agent",
      visibility: "organization",
      delegateMention: "ada",
      metadata: {},
    },
    buildAgentEnv: (env) => ({ ...env, FIRST_TREE_CHAT_ID: "chat-1" }),
    chatId: "chat-1",
    emitEvent: (event) => events.push(event),
    formatInboundContent: async (msg) => `[From: ${msg.senderId}] ${String(msg.content)}`,
    forwardResult: async (text) => {
      forwarded.push(text);
    },
    log: (line) => logs.push(line),
    resolveSenderLabel: async (senderId) => senderId,
    sdk: {
      serverUrl: "https://hub.example.test",
      getChatDetail: async () => ({ title: "Launch room", topic: "Launch" }),
      listChatParticipants: async () => [
        { name: "ada", displayName: "Ada", type: "human" },
        { name: "codex", displayName: "Codex Tester", type: "agent" },
      ],
    } as never,
    setRuntimeState: (state) => states.push(state),
    touch: () => {},
  };
}

describe("codex handler lifecycle", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "first-tree-codex-handler-"));
    codexSdkMock.codexOptions.length = 0;
    codexSdkMock.threadOptions.length = 0;
    codexSdkMock.runInputs.length = 0;
    codexSdkMock.runScripts.length = 0;
    codexSdkMock.threadIds.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(workspace, { recursive: true, force: true });
  });

  it("starts, processes every completed item kind, injects, resumes, and shuts down", async () => {
    const { createCodexHandler } = await import("../handlers/codex.js");
    const events: SessionEvent[] = [];
    const forwarded: string[] = [];
    const logs: string[] = [];
    const states: string[] = [];
    const runtimePayload = payload();
    const cache = {
      get: () => ({ payload: runtimePayload }),
      refresh: async () => ({ payload: runtimePayload }),
    } as unknown as AgentConfigCache;
    const handler = createCodexHandler({ agentConfigCache: cache, agentName: "codex", workspaceRoot: workspace });
    const ctx = createContext(events, forwarded, logs, states);

    codexSdkMock.runScripts.push([
      { type: "thread.started", thread_id: "thread-from-start" },
      { type: "turn.started" },
      { type: "item.started" },
      { type: "item.updated" },
      { type: "item.completed", item: { type: "agent_message", text: "First reply" } },
      {
        type: "item.completed",
        item: {
          type: "command_execution",
          id: "cmd-1",
          command: "pnpm test",
          status: "completed",
          aggregated_output: "ok",
        },
      },
      {
        type: "item.completed",
        item: { type: "file_change", id: "file-1", status: "failed", changes: [{ path: "README.md" }] },
      },
      {
        type: "item.completed",
        item: {
          type: "mcp_tool_call",
          id: "mcp-1",
          server: "github",
          tool: "search",
          arguments: { q: "first-tree" },
          status: "completed",
          result: { structured_content: { ok: true } },
        },
      },
      {
        type: "item.completed",
        item: {
          type: "mcp_tool_call",
          id: "mcp-2",
          server: "github",
          tool: "comment",
          arguments: {},
          status: "failed",
          error: { message: "denied" },
        },
      },
      { type: "item.completed", item: { type: "web_search", id: "web-1", query: "release notes" } },
      {
        type: "item.completed",
        item: { type: "todo_list", id: "todo-1", items: [{ text: "verify", completed: false }] },
      },
      { type: "item.completed", item: { type: "reasoning" } },
      { type: "item.completed", item: { type: "error", message: "tool failed" } },
      { type: "error", message: "stream warning" },
      {
        type: "turn.completed",
        usage: { input_tokens: 11, cached_input_tokens: 3, output_tokens: 7, reasoning_output_tokens: 2 },
      },
    ]);

    await expect(handler.start(message("msg-1"), ctx)).resolves.toBe("thread-from-start");

    expect(forwarded).toEqual(["First reply"]);
    expect(events.map((event) => event.kind)).toEqual(
      expect.arrayContaining(["assistant_text", "tool_call", "thinking", "error", "turn_end"]),
    );
    expect(states).toEqual(expect.arrayContaining(["working", "idle"]));
    expect(logs.some((line) => line.includes("codex usage chatId=chat-1"))).toBe(true);
    expect(codexSdkMock.runInputs[0]).toBe("[From: agent-human] Run checks");
    expect(codexSdkMock.codexOptions[0]).toMatchObject({
      config: {
        mcp_servers: {
          local: { command: "node", args: ["server.js"] },
          remote: { url: "https://mcp.example.test", headers: { Authorization: "Bearer test" } },
        },
      },
    });
    expect(codexSdkMock.threadOptions[0]).toMatchObject({
      model: "gpt-test",
      workingDirectory: workspace,
      additionalDirectories: [join(workspace, "first-tree")],
    });

    handler.inject(message("msg-2", "Follow-up"));
    await new Promise((resolve) => setImmediate(resolve));
    expect(forwarded).toContain("Default reply");
    expect(codexSdkMock.runInputs).toContain("[From: agent-human] Follow-up");

    await expect(handler.resume(undefined, "thread-resume", ctx)).resolves.toBe("thread-resume");
    await expect(handler.resume(message("msg-3", "Resume input"), "thread-resume", ctx)).resolves.toBe("thread-resume");
    expect(codexSdkMock.runInputs).toContain("[From: agent-human] Resume input");

    await expect(handler.suspend()).resolves.toBeUndefined();
    await expect(handler.shutdown()).resolves.toBeUndefined();
  });

  it("retries transient turn.failed and thrown stream failures before emitting user-visible output", async () => {
    vi.useFakeTimers();
    const { createCodexHandler } = await import("../handlers/codex.js");
    const events: SessionEvent[] = [];
    const forwarded: string[] = [];
    const logs: string[] = [];
    const states: string[] = [];
    const runtimePayload = payload();
    const cache = {
      get: () => ({ payload: runtimePayload }),
      refresh: async () => ({ payload: runtimePayload }),
    } as unknown as AgentConfigCache;
    const handler = createCodexHandler({ agentConfigCache: cache, agentName: "codex", workspaceRoot: workspace });
    const ctx = createContext(events, forwarded, logs, states);

    codexSdkMock.runScripts.push(
      [{ type: "turn.failed", error: { message: "503 service unavailable" } }],
      new Error("fetch failed"),
      [
        { type: "thread.started", thread_id: "thread-after-retry" },
        { type: "item.completed", item: { type: "agent_message", text: "Recovered" } },
        {
          type: "turn.completed",
          usage: { input_tokens: 5, cached_input_tokens: 1, output_tokens: 2, reasoning_output_tokens: 0 },
        },
      ],
    );

    const started = handler.start(message("msg-retry"), ctx);
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(1500);

    await expect(started).resolves.toBe("thread-after-retry");
    expect(forwarded).toEqual(["Recovered"]);
    expect(codexSdkMock.runInputs).toEqual([
      "[From: agent-human] Run checks",
      "[From: agent-human] Run checks",
      "[From: agent-human] Run checks",
    ]);
    expect(logs.filter((line) => line.includes("codex turn retry"))).toHaveLength(2);
    expect(events.find((event) => event.kind === "turn_end")?.payload).toMatchObject({ status: "success" });
  });

  it("does not retry after visible output and reports forwardResult failures", async () => {
    const { createCodexHandler } = await import("../handlers/codex.js");
    const events: SessionEvent[] = [];
    const forwarded: string[] = [];
    const logs: string[] = [];
    const states: string[] = [];
    const runtimePayload = payload();
    const cache = {
      get: () => ({ payload: runtimePayload }),
      refresh: async () => ({ payload: runtimePayload }),
    } as unknown as AgentConfigCache;
    const handler = createCodexHandler({ agentConfigCache: cache, agentName: "codex", workspaceRoot: workspace });
    const ctx = {
      ...createContext(events, forwarded, logs, states),
      forwardResult: async () => {
        throw new Error("send failed");
      },
    } satisfies SessionContext;

    codexSdkMock.runScripts.push([
      { type: "thread.started", thread_id: "thread-visible-failure" },
      { type: "item.completed", item: { type: "agent_message", text: "Partial reply" } },
      { type: "turn.failed", error: { message: "503 service unavailable" } },
    ]);

    await expect(handler.start(message("msg-visible"), ctx)).resolves.toBe("thread-visible-failure");

    expect(codexSdkMock.runInputs).toHaveLength(1);
    expect(events.map((event) => event.kind)).toEqual(expect.arrayContaining(["assistant_text", "error", "turn_end"]));
    expect(events.filter((event) => event.kind === "error").map((event) => event.payload)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "sdk", message: "503 service unavailable" }),
        expect.objectContaining({ source: "runtime", message: "forwardResult failed: send failed" }),
      ]),
    );
    expect(events.findLast((event) => event.kind === "turn_end")?.payload).toMatchObject({ status: "error" });
  });

  it("falls back to the default runtime payload and reports missing thread ids", async () => {
    const { createCodexHandler } = await import("../handlers/codex.js");
    const events: SessionEvent[] = [];
    const forwarded: string[] = [];
    const logs: string[] = [];
    const states: string[] = [];
    const handler = createCodexHandler({ agentName: "codex", workspaceRoot: workspace });
    const ctx = {
      ...createContext(events, forwarded, logs, states),
      sdk: {
        serverUrl: "https://hub.example.test",
        getChatDetail: async () => {
          throw new Error("chat unavailable");
        },
        listChatParticipants: async () => [],
      } as never,
    } satisfies SessionContext;

    codexSdkMock.threadIds.push(null);
    codexSdkMock.runScripts.push([{ type: "item.completed", item: { type: "agent_message", text: "No id" } }]);

    await expect(handler.start(message("msg-no-thread"), ctx)).rejects.toThrow("codex did not assign a thread id");

    expect(codexSdkMock.codexOptions[0]).toMatchObject({ config: { project_root_markers: [".first-tree-workspace"] } });
    expect((codexSdkMock.codexOptions[0] as { config?: Record<string, unknown> }).config).not.toHaveProperty(
      "mcp_servers",
    );
    expect(codexSdkMock.threadOptions[0]).not.toHaveProperty("model");
    expect(logs).toContain("fetchChatContext failed: chat unavailable");
    expect(forwarded).toEqual(["No id"]);
  });

  it("materializes configured source repos through the injected git mirror manager", async () => {
    const { createCodexHandler } = await import("../handlers/codex.js");
    const events: SessionEvent[] = [];
    const forwarded: string[] = [];
    const logs: string[] = [];
    const states: string[] = [];
    const runtimePayload = {
      ...payload(),
      gitRepos: [
        { url: "https://github.com/agent-team-foundation/first-tree", localPath: "first-tree", ref: "main" },
        { url: "https://github.com/agent-team-foundation/failing-repo", localPath: "failing-repo" },
      ],
    } satisfies AgentRuntimeConfigPayload;
    const cache = {
      get: () => ({ payload: runtimePayload }),
      refresh: async () => ({ payload: runtimePayload }),
    } as unknown as AgentConfigCache;
    const gitMirrorManager = {
      ensureMirror: vi.fn(async () => ({
        cloned: true,
        elapsedMs: 3,
        mirrorPath: join(workspace, ".mirrors", "repo"),
      })),
      fetchMirror: vi.fn(async () => ({ elapsedMs: 2 })),
      createWorktree: vi.fn(async (opts: { url: string; targetPath: string }) => {
        if (opts.url.includes("failing-repo")) throw new Error("worktree failed");
        mkdirSync(opts.targetPath, { recursive: true });
        writeFileSync(join(opts.targetPath, FIRST_TREE_WORKSPACE_MARKER), "", "utf-8");
        return { branchName: "agent-codex-first-tree", headCommit: "abc123", worktreePath: opts.targetPath };
      }),
      gcMirrors: vi.fn(async () => ({ removed: [] })),
      gcOrphanSessionBranches: vi.fn(async () => ({ deleted: 0, failed: 0, scanned: 0 })),
      mirrorsRoot: join(workspace, ".mirrors"),
      removeWorktree: vi.fn(async () => {}),
    };
    const handler = createCodexHandler({
      agentConfigCache: cache,
      agentName: "codex",
      gitMirrorManager,
      workspaceRoot: workspace,
    });
    const ctx = createContext(events, forwarded, logs, states);

    await expect(handler.start(message("msg-git"), ctx)).resolves.toBe("thread-from-event");

    expect(gitMirrorManager.ensureMirror).toHaveBeenCalledTimes(2);
    expect(gitMirrorManager.fetchMirror).toHaveBeenCalledTimes(2);
    expect(gitMirrorManager.createWorktree).toHaveBeenCalledTimes(2);
    expect(logs).toContain(
      "codex git materialisation skipped (https://github.com/agent-team-foundation/failing-repo): worktree failed",
    );
    expect(forwarded).toEqual(["Default reply"]);
    expect(codexSdkMock.threadOptions[0]).toMatchObject({
      additionalDirectories: [join(workspace, "first-tree"), join(workspace, "failing-repo")],
    });
    const briefing = String(codexSdkMock.runInputs[0]);
    expect(briefing).toContain("[From: agent-human] Run checks");

    await handler.shutdown();
  });
});
