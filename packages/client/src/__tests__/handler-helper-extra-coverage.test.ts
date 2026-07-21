import type { AgentRuntimeConfigPayload, SessionEvent, ToolFileRef } from "@first-tree/shared";
import { describe, expect, it, vi } from "vitest";
import {
  buildClaudeQueryOptions,
  createToolCallProcessor,
  detectClaudeSessionLimitResult,
  detectStreamApiError,
  isSameModelFamily,
  mapMcpServers,
  StreamApiTransientError,
} from "../handlers/claude-code.js";
import {
  appendGitStatusDeltaRefs,
  buildCodexThreadOptions,
  collectCodexFileChangePaths,
  toolFileRefsForTerminalCodexTool,
  toolFileRefsFromCodexFileChange,
} from "../handlers/codex/index.js";
import type { ChatContext } from "../runtime/chat-context.js";
import type { ContextTreeGitWriteTracker } from "../runtime/context-tree-git-status.js";

function claudePayload(overrides: Partial<Extract<AgentRuntimeConfigPayload, { kind: "claude-code" }>> = {}) {
  return {
    kind: "claude-code",
    prompt: { append: "" },
    model: "",
    mcpServers: [],
    env: [],
    gitRepos: [],
    resourceSkills: [],
    reasoningEffort: "",
    ...overrides,
  } satisfies AgentRuntimeConfigPayload;
}

describe("additional Codex helper branches", () => {
  it("handles nested file-change payload shapes and empty context-tree attribution", () => {
    expect(
      collectCodexFileChangePaths([
        "direct/path.md",
        null,
        { file_path: "snake.md", filename: "name.md", nested: [{ path: "ignored-by-collector-value.md" }] },
        { "windows\\path.md": true },
        { plain: "not a path" },
      ]),
    ).toEqual(["direct/path.md", "snake.md", "name.md", "windows\\path.md"]);

    expect(
      toolFileRefsFromCodexFileChange({
        changes: [{ path: "relative.md" }],
        workspaceCwd: "/workspace",
        contextTreePath: null,
        contextTreeRepoUrl: null,
      }),
    ).toEqual([{ origin: "file_change", localPath: "relative.md", pathKind: "file" }]);
  });

  it("captures git baselines for failed terminal tools and returns undefined for empty deltas", () => {
    const captureBaseline = vi.fn();
    const gitWriteTracker: ContextTreeGitWriteTracker = {
      captureBaseline,
      refsForSuccessfulToolCall: vi.fn(() => []),
    };

    expect(
      toolFileRefsForTerminalCodexTool({
        status: "error",
        gitWriteTracker,
        toolName: "Bash",
        toolUseId: "tool-1",
      }),
    ).toBeUndefined();
    expect(captureBaseline).toHaveBeenCalledTimes(1);

    expect(
      toolFileRefsForTerminalCodexTool({
        status: "pending",
        gitWriteTracker,
        toolName: "Bash",
        toolUseId: "tool-2",
      }),
    ).toBeUndefined();

    expect(appendGitStatusDeltaRefs({ toolName: "Bash", toolUseId: "tool-3" })).toBeUndefined();
  });

  it("uses the non-codex reasoning fallback when called with a different runtime payload", () => {
    const opts = buildCodexThreadOptions(claudePayload(), "/workspace");
    expect(opts.modelReasoningEffort).toBe("high");
    expect(opts.additionalDirectories).toEqual([]);
  });
});

describe("additional Claude helper branches", () => {
  it("maps all MCP transports and compares model families defensively", () => {
    expect(
      mapMcpServers(
        claudePayload({
          mcpServers: [
            { name: "stdio-server", transport: "stdio", command: "node", args: ["server.js"] },
            { name: "http-server", transport: "http", url: "https://mcp.example/http", headers: { "x-api": "1" } },
            { name: "sse-server", transport: "sse", url: "https://mcp.example/sse", headers: { "x-api": "2" } },
          ],
        }),
      ),
    ).toEqual({
      "stdio-server": { type: "stdio", command: "node", args: ["server.js"] },
      "http-server": { type: "http", url: "https://mcp.example/http", headers: { "x-api": "1" } },
      "sse-server": { type: "sse", url: "https://mcp.example/sse", headers: { "x-api": "2" } },
    });

    expect(isSameModelFamily("claude-opus-4-5", "claude-opus-4-6")).toBe(true);
    expect(isSameModelFamily("claude-opus-4-5", "claude-sonnet-4-5")).toBe(false);
    expect(isSameModelFamily("", "claude-opus-4-5")).toBe(false);
    expect(isSameModelFamily("short", "claude-opus-4-5")).toBe(false);
  });

  it("builds Claude SDK query options from model, MCP, effort, and chat context", () => {
    const chatContext: ChatContext = {
      chatId: "chat-1",
      title: "Release thread",
      topic: "Coverage",
      description: "Discuss coverage gaps.",
      selfOwner: { name: "alice", displayName: "Alice" },
      participants: [
        { name: "alice", displayName: "Alice", type: "human" },
        { name: "agent", displayName: "Agent", type: "agent" },
      ],
    };

    const options = buildClaudeQueryOptions(
      claudePayload({
        model: "claude-opus-4-5",
        reasoningEffort: "high",
        mcpServers: [{ name: "stdio-server", transport: "stdio", command: "node", args: ["server.js"] }],
      }),
      chatContext,
    );

    expect(options).toMatchObject({
      model: "claude-opus-4-5",
      effort: "high",
      mcpServers: {
        "stdio-server": { type: "stdio", command: "node", args: ["server.js"] },
      },
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
      },
    });
    expect(options.systemPrompt?.append).toContain("<first-tree-runtime-contract>");
    expect(options.systemPrompt?.append).toContain("<first-tree-current-chat-context");
    expect(options.systemPrompt?.append).toContain('"name": "alice"');
  });

  it("classifies stream API and session-limit result text without false positives", () => {
    expect(new StreamApiTransientError("socket dropped").name).toBe("StreamApiTransientError");
    expect(detectStreamApiError("Anthropic API error: socket connection was closed\nretry later")).toEqual({
      message: "Anthropic API error: socket connection was closed",
    });
    expect(detectStreamApiError("API Error: how to handle API errors")).toBeNull();
    expect(detectStreamApiError("x".repeat(500))).toBeNull();
    expect(detectStreamApiError(42 as unknown as string)).toBeNull();

    expect(detectClaudeSessionLimitResult("You've hit your session limit · resets tomorrow.")).toEqual({
      message: "You've hit your session limit · resets tomorrow.",
    });
    expect(detectClaudeSessionLimitResult("You’ve hit your session limit")).toEqual({
      message: "You’ve hit your session limit",
    });
    expect(detectClaudeSessionLimitResult("You've hit your session limit\nextra")).toBeNull();
    expect(detectClaudeSessionLimitResult(null as unknown as string)).toBeNull();
  });

  it("emits pending, assistant text, thinking, ok/error tool calls, file refs, and flushes pending state", () => {
    const events: SessionEvent[] = [];
    const treeRef: ToolFileRef = {
      origin: "git_status_delta",
      localPath: "/tree/changed.md",
      repoUrl: "https://github.com/acme/context.git",
      repoRelativePath: "changed.md",
      pathKind: "file",
    };
    const captureBaseline = vi.fn();
    const gitWriteTracker: ContextTreeGitWriteTracker = {
      captureBaseline,
      refsForSuccessfulToolCall: vi.fn(() => [treeRef]),
    };
    const processor = createToolCallProcessor(
      (event) => events.push(event),
      {
        path: "/tree",
        repoUrl: "https://github.com/acme/context.git",
        branch: "main",
      },
      { cwd: "/workspace", gitWriteTracker },
    );

    processor.onMessage({ type: "unknown" });
    processor.onMessage({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "tool-read", name: "Read", input: { file_path: "/tree/NODE.md" } },
          { type: "text", text: " Assistant output " },
          { type: "thinking", thinking: "hidden" },
          { type: "text", text: "   " },
        ],
      },
    });
    processor.onMessage({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-read",
            content: [{ type: "text", text: "result body" }],
          },
        ],
      },
    });
    processor.onMessage({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "tool-error", name: "Write", input: { file_path: "/tree/BAD.md" } }],
      },
    });
    processor.onMessage({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "tool-error", content: "failed", is_error: true }] },
    });
    processor.onMessage({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "tool-flush", name: "Read", input: { file_path: "/tree/LATE.md" } }],
      },
    });
    processor.flush();
    processor.onMessage({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "tool-flush", content: "ignored" }] },
    });

    expect(captureBaseline).toHaveBeenCalledTimes(4);
    expect(events.map((event) => event.kind)).toEqual([
      "tool_call",
      "assistant_text",
      "thinking",
      "tool_call",
      "tool_call",
      "tool_call",
      "tool_call",
    ]);
    expect(events[0]).toMatchObject({
      kind: "tool_call",
      payload: { toolUseId: "tool-read", name: "Read", status: "pending" },
    });
    expect(events[1]).toEqual({
      kind: "assistant_text",
      payload: { text: "Assistant output", continuation: false },
    });
    expect(events[2]).toEqual({ kind: "thinking", payload: {} });
    expect(events[3]).toMatchObject({
      kind: "tool_call",
      payload: {
        toolUseId: "tool-read",
        status: "ok",
        resultPreview: "result body",
        toolFileRefs: [
          {
            origin: "tool_arg",
            localPath: "/tree/NODE.md",
            repoUrl: "https://github.com/acme/context.git",
            repoBranch: "main",
            repoRelativePath: "NODE.md",
            pathKind: "file",
          },
          treeRef,
        ],
      },
    });
    expect(events[5]).toMatchObject({
      kind: "tool_call",
      payload: { toolUseId: "tool-error", status: "error", resultPreview: "failed" },
    });
    expect(events[6]).toMatchObject({
      kind: "tool_call",
      payload: { toolUseId: "tool-flush", status: "pending" },
    });
  });

  it("attributes notebook, search, and shell tool refs through the processor", () => {
    const events: SessionEvent[] = [];
    const processor = createToolCallProcessor(
      (event) => events.push(event),
      {
        path: "/tree/",
        repoUrl: "https://github.com/acme/context.git",
        branch: "main",
      },
      { cwd: "/tree" },
    );

    for (const [id, name, input] of [
      ["tool-notebook", "NotebookRead", { notebook_path: "/tree/notebooks/demo.ipynb" }],
      ["tool-grep-root", "Grep", { path: "." }],
      ["tool-bash", "Bash", { command: "cat NODE.md" }],
      ["tool-relative-write", "Write", { file_path: "relative.md" }],
      ["tool-no-path", "Glob", { pattern: "*.md" }],
    ] satisfies Array<[string, string, unknown]>) {
      processor.onMessage({
        type: "assistant",
        message: { content: [{ type: "tool_use", id, name, input }] },
      });
      processor.onMessage({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: id, content: "" }] },
      });
    }

    const completed = events.filter((event) => event.kind === "tool_call" && event.payload.status === "ok");
    expect(completed).toHaveLength(5);
    expect(completed[0]).toMatchObject({
      payload: {
        toolUseId: "tool-notebook",
        toolFileRefs: [
          {
            localPath: "/tree/notebooks/demo.ipynb",
            repoUrl: "https://github.com/acme/context.git",
            repoBranch: "main",
            repoRelativePath: "notebooks/demo.ipynb",
            pathKind: "file",
          },
        ],
      },
    });
    expect(completed[1]).toMatchObject({
      payload: {
        toolUseId: "tool-grep-root",
        toolFileRefs: [
          {
            localPath: "/tree",
            repoRelativePath: "/",
            pathKind: "repo",
          },
        ],
      },
    });
    expect(completed[2]).toMatchObject({
      payload: {
        toolUseId: "tool-bash",
        toolFileRefs: [
          {
            localPath: "/tree/NODE.md",
            repoRelativePath: "NODE.md",
            pathKind: "file",
          },
        ],
      },
    });
    expect(completed[3]).toMatchObject({
      payload: {
        toolUseId: "tool-relative-write",
        toolFileRefs: [{ localPath: "relative.md", pathKind: "file" }],
      },
    });
    expect(completed[4]?.payload).not.toHaveProperty("toolFileRefs");
  });
});
