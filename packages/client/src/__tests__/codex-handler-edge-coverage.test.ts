import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntimeConfigPayload, SessionEvent } from "@first-tree/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type StreamControl =
  | { __control: "throw"; error: unknown }
  | { __control: "wait"; promise: Promise<void> }
  | { __control: "waitForAbort" };
type StreamEntry = Record<string, unknown> | StreamControl;
type RunPlan = { entries?: StreamEntry[]; throwBefore?: unknown };
type RunCall = { input: unknown; signal: AbortSignal };

const capturedCodexOptions: unknown[] = [];
const capturedStartThreadOptions: unknown[] = [];
const capturedResumeThreadOptions: Array<{ sessionId: string; options: unknown }> = [];
const capturedRuns: RunCall[] = [];
const queuedRunPlans: RunPlan[] = [];
let nextStartedThreadId: string | null | undefined;

async function* streamEntries(entries: StreamEntry[], signal: AbortSignal): AsyncIterable<unknown> {
  for (const entry of entries) {
    if ("__control" in entry) {
      if (entry.__control === "throw") throw entry.error;
      if (entry.__control === "wait") {
        await entry.promise;
      } else {
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve();
            return;
          }
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        throw new DOMException("Aborted", "AbortError");
      }
    } else {
      yield entry;
    }
  }
}

vi.mock("@openai/codex-sdk", () => {
  let threadCounter = 0;

  class FakeThread {
    id: string | null;

    constructor(id?: string | null) {
      threadCounter += 1;
      this.id = id === undefined ? `fake-thread-${threadCounter}` : id;
    }

    async runStreamed(input: unknown, options: { signal: AbortSignal }): Promise<{ events: AsyncIterable<unknown> }> {
      capturedRuns.push({ input, signal: options.signal });
      const plan = queuedRunPlans.shift() ?? { entries: [] };
      if ("throwBefore" in plan) throw plan.throwBefore;
      return { events: streamEntries(plan.entries ?? [], options.signal) };
    }
  }

  class FakeCodex {
    constructor(options: unknown) {
      capturedCodexOptions.push(options);
    }

    startThread(options: unknown): FakeThread {
      capturedStartThreadOptions.push(options);
      const id = nextStartedThreadId;
      nextStartedThreadId = undefined;
      return new FakeThread(id);
    }

    resumeThread(sessionId: string, options: unknown): FakeThread {
      capturedResumeThreadOptions.push({ sessionId, options });
      return new FakeThread(sessionId);
    }
  }

  return { Codex: FakeCodex };
});

import * as codexModule from "../handlers/codex.js";
import { buildCodexThreadOptions, createCodexHandler } from "../handlers/codex.js";
import type { AgentConfigCache } from "../runtime/agent-config-cache.js";
import { FIRST_TREE_WORKSPACE_MARKER } from "../runtime/bootstrap.js";
import type { GitMirrorManager } from "../runtime/git-mirror-manager.js";
import type { SessionContext, SessionMessage } from "../runtime/handler.js";

type CodexCoverageHelpers = {
  isUserVisibleItem(item: { type: string }): boolean;
  sleepWithAbort(ms: number, signal: AbortSignal): Promise<void>;
};

const helpers = (codexModule as unknown as { __coverage: CodexCoverageHelpers }).__coverage;
const AGENT_ID = "019d9a97-90b0-716b-8317-a8c0be8430d7";

let workspaceRoot: string;

const basePayload: AgentRuntimeConfigPayload = {
  kind: "codex",
  prompt: { append: "" },
  model: "",
  mcpServers: [],
  env: [],
  gitRepos: [],
};

beforeEach(() => {
  capturedCodexOptions.length = 0;
  capturedStartThreadOptions.length = 0;
  capturedResumeThreadOptions.length = 0;
  capturedRuns.length = 0;
  queuedRunPlans.length = 0;
  nextStartedThreadId = undefined;
  workspaceRoot = mkdtempSync(join(tmpdir(), "ftt-codex-edge-workspace-"));
});

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});

function enqueueRun(plan: RunPlan): void {
  queuedRunPlans.push(plan);
}

function usage(): Record<string, number> {
  return {
    input_tokens: 11,
    cached_input_tokens: 2,
    output_tokens: 7,
    reasoning_output_tokens: 3,
  };
}

function textMessage(content = "hello", chatId = "chat-codex"): SessionMessage {
  return { id: `${chatId}-msg`, chatId, senderId: "user-a", format: "text", content, metadata: null };
}

function recordFromPayload(payload: AgentRuntimeConfigPayload, version = 1) {
  return {
    agentId: AGENT_ID,
    version,
    payload,
    updatedAt: new Date().toISOString(),
    updatedBy: "test",
  };
}

function makeCache(payloadRef: { current: AgentRuntimeConfigPayload; version?: number }): AgentConfigCache {
  return {
    get: vi.fn(() => recordFromPayload(payloadRef.current, payloadRef.version ?? 1)),
    refresh: vi.fn(async () => recordFromPayload(payloadRef.current, payloadRef.version ?? 1)),
  } as unknown as AgentConfigCache;
}

function makeGitMirrorManager(): GitMirrorManager {
  return {
    ensureMirror: vi.fn(async () => ({ cloned: true, elapsedMs: 4 })),
    fetchMirror: vi.fn(async () => {}),
    createWorktree: vi.fn(async (args: { url: string; targetPath: string }) => {
      if (args.url.includes("throw")) throw new Error("mirror boom");
      if (args.url.includes("string-fail")) throw "mirror string";
      mkdirSync(args.targetPath, { recursive: true });
      writeFileSync(join(args.targetPath, ".git"), "gitdir: mock", "utf-8");
      return { branchName: `branch-${args.url.split("/").pop() ?? "repo"}`, headCommit: "abc123" };
    }),
    removeWorktree: vi.fn(async () => {}),
  } as unknown as GitMirrorManager;
}

function makeSessionCtx(
  chatId: string,
  overrides: Partial<SessionContext> = {},
): { ctx: SessionContext; logs: string[]; events: SessionEvent[]; forwarded: string[]; states: string[] } {
  const logs: string[] = [];
  const events: SessionEvent[] = [];
  const forwarded: string[] = [];
  const states: string[] = [];
  const sdk = {
    serverUrl: "http://hub.test",
    sendMessage: vi.fn(async () => undefined),
    getChatDetail: async () => ({ id: chatId, title: "Codex chat", topic: "Runtime planning" }),
    listChatParticipants: async () => [
      { name: "alice", displayName: "Alice", type: "human" },
      { name: "agent-peer", displayName: "Agent Peer", type: "agent" },
    ],
  } as unknown as SessionContext["sdk"];

  const ctx: SessionContext = {
    agent: {
      agentId: AGENT_ID,
      inboxId: "inbox-test",
      displayName: "Codex Agent",
      type: "agent",
      visibility: "organization",
      delegateMention: null,
      metadata: { team: "runtime" },
    },
    sdk,
    chatId,
    log: (msg) => logs.push(msg),
    touch: () => {},
    setRuntimeState: (state) => states.push(state),
    emitEvent: (event) => events.push(event),
    forwardResult: async (text) => {
      forwarded.push(text);
    },
    buildAgentEnv: (env) => ({ ...env, FIRST_TREE_ACCESS_TOKEN: "token", DROP_ME: undefined }),
    formatInboundContent: async (msg) => {
      const raw = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
      return msg.senderId ? `[From: ${msg.senderId}]\n\n${raw}` : raw;
    },
    resolveSenderLabel: async (senderId) => senderId,
    ...overrides,
  };

  return { ctx, logs, events, forwarded, states };
}

function eventKinds(events: SessionEvent[]): string[] {
  return events.map((event) => event.kind);
}

describe("codex handler — edge coverage", () => {
  it("covers top-level visibility and abort-aware sleep helpers", async () => {
    for (const type of [
      "agent_message",
      "command_execution",
      "file_change",
      "mcp_tool_call",
      "web_search",
      "todo_list",
    ]) {
      expect(helpers.isUserVisibleItem({ type })).toBe(true);
    }
    for (const type of ["reasoning", "error"]) {
      expect(helpers.isUserVisibleItem({ type })).toBe(false);
    }
    expect(helpers.isUserVisibleItem({ type: "unknown" })).toBeUndefined();

    await expect(helpers.sleepWithAbort(0, new AbortController().signal)).resolves.toBeUndefined();

    const preAborted = new AbortController();
    preAborted.abort();
    await expect(helpers.sleepWithAbort(1, preAborted.signal)).rejects.toThrow("Aborted");

    const abortDuringSleep = new AbortController();
    const sleeping = helpers.sleepWithAbort(1_000, abortDuringSleep.signal);
    abortDuringSleep.abort();
    await expect(sleeping).rejects.toThrow("Aborted");
  });

  it("builds options for repo URLs that derive to an empty local path", () => {
    const opts = buildCodexThreadOptions({ ...basePayload, gitRepos: [{ url: "   " }] }, workspaceRoot);
    expect(opts.additionalDirectories).toEqual([]);
  });

  it("starts a richly configured thread and translates every terminal stream item", async () => {
    const reusePath = join(workspaceRoot, "reuse-repo");
    mkdirSync(reusePath, { recursive: true });
    writeFileSync(join(reusePath, ".git"), "gitdir: mock", "utf-8");
    mkdirSync(join(workspaceRoot, "occupied-repo"), { recursive: true });

    const payloadRef = {
      current: {
        ...basePayload,
        prompt: { append: "  Follow Codex edge instructions.  " },
        model: "gpt-5.5",
        env: [{ key: "EDGE_ENV", value: "configured", sensitive: false }],
        mcpServers: [
          { name: "stdio-tool", transport: "stdio", command: "node" },
          {
            name: "http-tool",
            transport: "http",
            url: "https://mcp.test/http",
            headers: { Authorization: "Bearer x" },
          },
          { name: "sse-tool", transport: "sse", url: "https://mcp.test/sse" },
        ],
        gitRepos: [
          { url: "https://github.com/acme/create.git", ref: "main", localPath: "created-repo" },
          { url: "https://github.com/acme/reuse.git", localPath: "reuse-repo" },
          { url: "https://github.com/acme/occupied.git", localPath: "occupied-repo" },
          { url: "https://github.com/acme/throw.git", localPath: "throw-repo" },
          { url: "https://github.com/acme/string-fail.git", localPath: "throw-string-repo" },
          { url: "   " },
        ],
      } satisfies AgentRuntimeConfigPayload,
    };
    const gitMirrorManager = makeGitMirrorManager();
    const { ctx, logs, events, forwarded, states } = makeSessionCtx("chat-rich");

    enqueueRun({
      entries: [
        { type: "thread.started", thread_id: "thread-rich" },
        { type: "turn.started" },
        { type: "item.started" },
        { type: "item.updated" },
        { type: "item.completed", item: { type: "agent_message", text: "   " } },
        { type: "item.completed", item: { type: "agent_message", text: "First answer" } },
        {
          type: "item.completed",
          item: {
            type: "command_execution",
            id: "cmd-ok",
            command: "pwd",
            status: "completed",
            aggregated_output: "x".repeat(450),
          },
        },
        {
          type: "item.completed",
          item: {
            type: "command_execution",
            id: "cmd-err",
            command: "false",
            status: "failed",
            aggregated_output: "failed",
          },
        },
        {
          type: "item.completed",
          item: {
            type: "command_execution",
            id: "cmd-pending",
            command: "sleep",
            status: "running",
            aggregated_output: "",
          },
        },
        {
          type: "item.completed",
          item: { type: "file_change", id: "file-ok", status: "completed", changes: [{ path: "a.ts" }] },
        },
        {
          type: "item.completed",
          item: { type: "file_change", id: "file-err", status: "failed", changes: [{ path: "b.ts" }] },
        },
        {
          type: "item.completed",
          item: {
            type: "mcp_tool_call",
            id: "mcp-ok",
            server: "srv",
            tool: "lookup",
            arguments: { q: "x" },
            status: "completed",
            result: { structured_content: { ok: true }, content: "fallback" },
          },
        },
        {
          type: "item.completed",
          item: {
            type: "mcp_tool_call",
            id: "mcp-failed",
            server: "srv",
            tool: "write",
            arguments: {},
            status: "failed",
            error: { message: "tool failed" },
          },
        },
        {
          type: "item.completed",
          item: {
            type: "mcp_tool_call",
            id: "mcp-pending",
            server: "srv",
            tool: "stream",
            arguments: {},
            status: "running",
            result: { content: "raw content" },
          },
        },
        {
          type: "item.completed",
          item: {
            type: "mcp_tool_call",
            id: "mcp-empty",
            server: "srv",
            tool: "empty",
            arguments: {},
            status: "running",
          },
        },
        { type: "item.completed", item: { type: "web_search", id: "web-1", query: "first tree" } },
        { type: "item.completed", item: { type: "todo_list", id: "todo-1", items: [{ text: "cover codex" }] } },
        { type: "item.completed", item: { type: "reasoning" } },
        { type: "item.completed", item: { type: "error", message: "tool item error" } },
        { type: "item.completed", item: { type: "unknown" } },
        { type: "error", message: "stream side warning" },
        { type: "turn.completed", usage: usage() },
      ],
    });

    const handler = createCodexHandler({
      workspaceRoot,
      agentConfigCache: makeCache(payloadRef),
      gitMirrorManager,
      agentName: "codex-agent",
    });

    const threadId = await handler.start(textMessage("start", "chat-rich"), ctx);
    expect(threadId).toBe("thread-rich");

    const codexOptions = capturedCodexOptions[0] as { env?: Record<string, string>; config?: Record<string, unknown> };
    expect(codexOptions.env?.EDGE_ENV).toBe("configured");
    expect(codexOptions.env?.FIRST_TREE_ACCESS_TOKEN).toBe("token");
    expect(codexOptions.env && "DROP_ME" in codexOptions.env).toBe(false);
    expect(codexOptions.config?.project_root_markers).toEqual([FIRST_TREE_WORKSPACE_MARKER]);
    expect(JSON.stringify(codexOptions.config?.mcp_servers)).toContain("stdio-tool");
    expect(JSON.stringify(codexOptions.config?.mcp_servers)).toContain("Authorization");
    expect(JSON.stringify(codexOptions.config?.mcp_servers)).toContain("sse-tool");

    const threadOptions = capturedStartThreadOptions[0] as { model?: string; additionalDirectories?: string[] };
    expect(threadOptions.model).toBe("gpt-5.5");
    expect(threadOptions.additionalDirectories).toEqual(
      expect.arrayContaining([join(workspaceRoot, "created-repo"), join(workspaceRoot, "reuse-repo")]),
    );

    const agentsMd = readFileSync(join(workspaceRoot, "AGENTS.md"), "utf-8");
    expect(agentsMd).toContain("Follow Codex edge instructions.");
    expect(agentsMd).toContain("Current Chat Context");
    expect(agentsMd).toContain("created-repo");
    expect(logs.some((line) => line.includes("Git: reusing existing source repo at reuse-repo"))).toBe(true);
    expect(logs.some((line) => line.includes("occupied by a non-Hub directory"))).toBe(true);
    expect(logs.some((line) => line.includes("codex git materialisation skipped"))).toBe(true);

    expect(eventKinds(events)).toContain("assistant_text");
    expect(eventKinds(events).filter((kind) => kind === "tool_call").length).toBeGreaterThanOrEqual(9);
    expect(eventKinds(events)).toContain("thinking");
    expect(
      events.some((event) => event.kind === "error" && event.payload.message.includes("stream side warning")),
    ).toBe(true);
    expect(events.at(-1)).toEqual({ kind: "turn_end", payload: { status: "success" } });
    expect(forwarded).toEqual(["First answer"]);
    expect(states).toContain("working");
    expect(states.at(-1)).toBe("idle");
    expect(logs.some((line) => line.includes("codex usage chatId=chat-rich"))).toBe(true);

    await handler.shutdown();

    writeFileSync(join(workspaceRoot, ".agent", "identity.json"), "{bad json", "utf-8");
    enqueueRun({ entries: [{ type: "thread.started", thread_id: "thread-identity-refresh" }] });
    const refreshHandler = createCodexHandler({
      workspaceRoot,
      agentConfigCache: makeCache(payloadRef),
      gitMirrorManager,
      agentName: "codex-agent",
    });
    await refreshHandler.start(textMessage("refresh", "chat-rich-refresh"), ctx);
    expect(logs.some((line) => line.includes("Agent identity drift detected"))).toBe(true);
    await refreshHandler.shutdown();

    writeFileSync(join(workspaceRoot, ".agent", "cli-version"), "old-version", "utf-8");
    enqueueRun({ entries: [{ type: "thread.started", thread_id: "thread-cli-drift" }] });
    const driftHandler = createCodexHandler({
      workspaceRoot,
      agentConfigCache: makeCache(payloadRef),
      gitMirrorManager,
      agentName: "codex-agent",
    });
    await driftHandler.start(textMessage("cli drift", "chat-rich-drift"), ctx);
    expect(logs.some((line) => line.includes("Bundled CLI version changed"))).toBe(true);
    await driftHandler.shutdown();
  });

  it("retries transient failures before user-visible output and falls back to thread.id", async () => {
    const { ctx, logs, events } = makeSessionCtx("chat-retry");
    enqueueRun({ entries: [{ type: "turn.failed", error: { message: "HTTP 503 unavailable" } }] });
    enqueueRun({ entries: [{ type: "turn.completed", usage: usage() }] });

    const handler = createCodexHandler({ workspaceRoot });
    const threadId = await handler.start(textMessage("retry", "chat-retry"), ctx);

    expect(threadId).toMatch(/^fake-thread-/);
    expect(capturedRuns).toHaveLength(2);
    expect(logs.some((line) => line.includes("codex turn retry 1/3"))).toBe(true);
    expect(events.at(-1)).toEqual({ kind: "turn_end", payload: { status: "success" } });
    await handler.shutdown();
  });

  it("retries transient runStreamed throws and surfaces permanent failures", async () => {
    const transient = makeSessionCtx("chat-throw-transient");
    enqueueRun({ throwBefore: new Error("fetch failed") });
    enqueueRun({ entries: [{ type: "thread.started", thread_id: "thread-throw-transient" }] });
    const transientHandler = createCodexHandler({ workspaceRoot: mkdtempSync(join(tmpdir(), "ftt-codex-throw-")) });
    await transientHandler.start(textMessage("throw transient", "chat-throw-transient"), transient.ctx);
    expect(transient.logs.some((line) => line.includes("runStreamed threw (transient): fetch failed"))).toBe(true);
    await transientHandler.shutdown();

    const permanent = makeSessionCtx("chat-permanent");
    enqueueRun({
      entries: [
        { type: "thread.started", thread_id: "thread-permanent" },
        { type: "turn.failed", error: { message: "401 Unauthorized" } },
      ],
    });
    const permanentHandler = createCodexHandler({ workspaceRoot: mkdtempSync(join(tmpdir(), "ftt-codex-permanent-")) });
    await permanentHandler.start(textMessage("permanent", "chat-permanent"), permanent.ctx);
    expect(
      permanent.events.some((event) => event.kind === "error" && event.payload.message === "401 Unauthorized"),
    ).toBe(true);
    expect(permanent.events.at(-1)).toEqual({ kind: "turn_end", payload: { status: "error" } });
    await permanentHandler.shutdown();

    const thrown = makeSessionCtx("chat-throw-permanent");
    enqueueRun({
      entries: [
        { type: "thread.started", thread_id: "thread-throw-permanent" },
        { __control: "throw", error: "plain failure" },
      ],
    });
    const thrownHandler = createCodexHandler({ workspaceRoot: mkdtempSync(join(tmpdir(), "ftt-codex-plain-")) });
    await thrownHandler.start(textMessage("throw permanent", "chat-throw-permanent"), thrown.ctx);
    expect(thrown.events.some((event) => event.kind === "error" && event.payload.message === "plain failure")).toBe(
      true,
    );
    await thrownHandler.shutdown();
  });

  it("marks turns as errors when forwarding assistant output fails", async () => {
    const { ctx, events } = makeSessionCtx("chat-forward-fail", {
      forwardResult: async () => {
        throw new Error("forward boom");
      },
    });
    enqueueRun({
      entries: [
        { type: "thread.started", thread_id: "thread-forward-fail" },
        { type: "item.completed", item: { type: "agent_message", text: "cannot forward" } },
        { type: "turn.completed", usage: usage() },
      ],
    });

    const handler = createCodexHandler({ workspaceRoot });
    await handler.start(textMessage("forward", "chat-forward-fail"), ctx);

    expect(
      events.some((event) => event.kind === "error" && event.payload.message.includes("forwardResult failed")),
    ).toBe(true);
    expect(events.at(-1)).toEqual({ kind: "turn_end", payload: { status: "error" } });
    await handler.shutdown();

    const stringFailure = makeSessionCtx("chat-forward-string", {
      forwardResult: async () => {
        throw "forward string";
      },
    });
    enqueueRun({
      entries: [
        { type: "thread.started", thread_id: "thread-forward-string" },
        { type: "item.completed", item: { type: "agent_message", text: "cannot forward string" } },
      ],
    });
    const stringHandler = createCodexHandler({
      workspaceRoot: mkdtempSync(join(tmpdir(), "ftt-codex-forward-string-")),
    });
    await stringHandler.start(textMessage("forward", "chat-forward-string"), stringFailure.ctx);
    expect(
      stringFailure.events.some((event) => event.kind === "error" && event.payload.message.includes("forward string")),
    ).toBe(true);
    await stringHandler.shutdown();
  });

  it("resumes with default payloads, optional messages, and chat-context fetch failures", async () => {
    const { ctx, logs } = makeSessionCtx("chat-resume", {
      sdk: {
        serverUrl: "http://hub.test",
        getChatDetail: async () => {
          throw new Error("chat fetch failed");
        },
        listChatParticipants: async () => [],
      } as unknown as SessionContext["sdk"],
    });
    const handler = createCodexHandler({ workspaceRoot });

    const withoutMessage = await handler.resume(undefined, "resume-no-message", ctx);
    expect(withoutMessage).toBe("resume-no-message");
    expect(capturedRuns).toHaveLength(0);
    expect(logs.some((line) => line.includes("fetchChatContext failed: chat fetch failed"))).toBe(true);

    enqueueRun({ entries: [{ type: "turn.completed", usage: usage() }] });
    const withMessage = await handler.resume(textMessage("resume body", "chat-resume"), "resume-with-message", ctx);
    expect(withMessage).toBe("resume-with-message");
    expect(capturedRuns).toHaveLength(1);
    expect(capturedResumeThreadOptions.map((call) => call.sessionId)).toEqual([
      "resume-no-message",
      "resume-with-message",
    ]);
    await handler.shutdown();

    const stringFetch = makeSessionCtx("chat-resume-string", {
      sdk: {
        serverUrl: "http://hub.test",
        getChatDetail: async () => {
          throw "chat string failed";
        },
        listChatParticipants: async () => [],
      } as unknown as SessionContext["sdk"],
    });
    const cachedHandler = createCodexHandler({
      workspaceRoot: mkdtempSync(join(tmpdir(), "ftt-codex-resume-cache-")),
      agentConfigCache: makeCache({ current: { ...basePayload, model: "gpt-5.5" } }),
    });
    await cachedHandler.resume(undefined, "resume-cache", stringFetch.ctx);
    expect(stringFetch.logs.some((line) => line.includes("fetchChatContext failed: chat string failed"))).toBe(true);
    await cachedHandler.shutdown();
  });

  it("buffers injects during active turns, drains them, and logs formatting failures", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { ctx, logs } = makeSessionCtx("chat-inject");
    ctx.formatInboundContent = async (msg) => {
      if (msg.id === "bad-format") throw new Error("format failed");
      return `formatted:${String(msg.content)}`;
    };

    enqueueRun({
      entries: [
        { type: "thread.started", thread_id: "thread-inject" },
        { __control: "wait", promise: gate },
        { type: "turn.completed", usage: usage() },
      ],
    });
    enqueueRun({ entries: [{ type: "turn.completed", usage: usage() }] });
    enqueueRun({ entries: [{ type: "turn.completed", usage: usage() }] });

    const handler = createCodexHandler({ workspaceRoot });
    const startPromise = handler.start(textMessage("start", "chat-inject"), ctx);
    await vi.waitFor(() => expect(capturedRuns).toHaveLength(1));

    handler.inject(textMessage("queued", "chat-inject"));
    handler.inject({ ...textMessage("bad", "chat-inject"), id: "bad-format" });
    release();

    await startPromise;
    await vi.waitFor(() => expect(capturedRuns).toHaveLength(2));
    expect(capturedRuns[1]?.input).toBe("formatted:queued");
    expect(logs.some((line) => line.includes("codex inject formatInboundContent failed"))).toBe(true);

    handler.inject(textMessage("direct", "chat-inject"));
    await vi.waitFor(() => expect(capturedRuns).toHaveLength(3));

    ctx.formatInboundContent = async () => {
      throw new Error("direct error failed");
    };
    handler.inject(textMessage("direct bad error", "chat-inject"));
    await vi.waitFor(() =>
      expect(logs.some((line) => line.includes("codex inject failed: direct error failed"))).toBe(true),
    );

    ctx.formatInboundContent = async () => {
      throw "direct format failed";
    };
    handler.inject(textMessage("direct bad", "chat-inject"));
    await vi.waitFor(() =>
      expect(logs.some((line) => line.includes("codex inject failed: direct format failed"))).toBe(true),
    );

    createCodexHandler({ workspaceRoot: mkdtempSync(join(tmpdir(), "ftt-codex-inactive-")) }).inject(
      textMessage("inactive", "chat-inject"),
    );
    await handler.shutdown();

    let releaseEmpty!: () => void;
    const emptyGate = new Promise<void>((resolve) => {
      releaseEmpty = resolve;
    });
    const empty = makeSessionCtx("chat-inject-empty");
    empty.ctx.formatInboundContent = async () => {
      return "empty start";
    };
    enqueueRun({
      entries: [
        { type: "thread.started", thread_id: "thread-inject-empty" },
        { __control: "wait", promise: emptyGate },
      ],
    });
    const emptyHandler = createCodexHandler({ workspaceRoot: mkdtempSync(join(tmpdir(), "ftt-codex-inject-empty-")) });
    const emptyStart = emptyHandler.start(textMessage("empty start", "chat-inject-empty"), empty.ctx);
    await vi.waitFor(() => expect(capturedRuns).toHaveLength(4));
    empty.ctx.formatInboundContent = async (msg) => {
      if (msg.id === "only-bad") throw "queued string failure";
      return "unexpected";
    };
    emptyHandler.inject({ ...textMessage("only bad", "chat-inject-empty"), id: "only-bad" });
    releaseEmpty();
    await emptyStart;
    await vi.waitFor(() =>
      expect(
        empty.logs.some((line) => line.includes("codex inject formatInboundContent failed: queued string failure")),
      ).toBe(true),
    );
    await emptyHandler.shutdown();
  });

  it("throws when Codex never exposes a thread id", async () => {
    nextStartedThreadId = null;
    enqueueRun({ entries: [] });
    const handler = createCodexHandler({ workspaceRoot });
    await expect(
      handler.start(textMessage("missing id", "chat-missing-id"), makeSessionCtx("chat-missing-id").ctx),
    ).rejects.toThrow("codex did not assign a thread id");
    await handler.shutdown();
  });

  it("aborts active turns on suspend and clears state on shutdown", async () => {
    const { ctx } = makeSessionCtx("chat-abort");
    enqueueRun({ entries: [{ type: "thread.started", thread_id: "thread-abort" }, { __control: "waitForAbort" }] });

    const handler = createCodexHandler({ workspaceRoot, gitMirrorManager: makeGitMirrorManager() });
    const startPromise = handler.start(textMessage("abort", "chat-abort"), ctx);
    await vi.waitFor(() => expect(capturedRuns).toHaveLength(1));

    await handler.suspend();
    await expect(startPromise).resolves.toBe("thread-abort");
    await handler.shutdown();
    await handler.suspend();
    expect(existsSync(workspaceRoot)).toBe(true);

    const shutdownCtx = makeSessionCtx("chat-shutdown-abort");
    enqueueRun({
      entries: [
        { type: "thread.started", thread_id: "thread-shutdown-abort" },
        { type: "item.completed", item: { type: "reasoning" } },
        { __control: "waitForAbort" },
      ],
    });
    const shutdownHandler = createCodexHandler({
      workspaceRoot: mkdtempSync(join(tmpdir(), "ftt-codex-shutdown-abort-")),
    });
    const shutdownStart = shutdownHandler.start(textMessage("shutdown abort", "chat-shutdown-abort"), shutdownCtx.ctx);
    await vi.waitFor(() => expect(capturedRuns).toHaveLength(2));
    await vi.waitFor(() => expect(shutdownCtx.events.some((event) => event.kind === "thinking")).toBe(true));
    await shutdownHandler.shutdown();
    await expect(shutdownStart).rejects.toThrow("Cannot read properties of null");
  });
});
