import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@first-tree/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCursorTurnArgs, CURSOR_PENDING_SESSION_PREFIX, createCursorHandler } from "../handlers/cursor/index.js";
import type { DeliveryToken, SessionContext, SessionMessage, TurnOutcome } from "../runtime/handler.js";
import { mockCtxPlumbing } from "./test-helpers.js";

/**
 * Handler-integration coverage for the per-turn Cursor CLI transport, on a
 * fake spawn seam — locks the canonical spawn contract (args / stdin / cwd),
 * session-id semantics (stream-confirmed vs synthetic), the settlement
 * barrier (stderr-only failures), and completion-hook behavior.
 */

class FakeStdin extends EventEmitter {
  written = "";
  ended = false;
  write(chunk: string): boolean {
    this.written += chunk;
    return true;
  }
  end(): void {
    this.ended = true;
  }
}

class FakeStream extends EventEmitter {
  setEncoding(): this {
    return this;
  }
}

class FakeChild extends EventEmitter {
  stdin = new FakeStdin();
  stdout = new FakeStream();
  stderr = new FakeStream();
  kills: string[] = [];
  kill(signal?: string): boolean {
    this.kills.push(signal ?? "SIGTERM");
    return true;
  }
}

type SpawnCall = { binary: string; args: string[]; options: Record<string, unknown> };

type ChildScript = (child: FakeChild) => void;

function makeFakeSpawn(scripts: ChildScript[]): {
  spawnFn: (binary: string, args: string[], options: Record<string, unknown>) => FakeChild;
  calls: SpawnCall[];
} {
  const calls: SpawnCall[] = [];
  const spawnFn = (binary: string, args: string[], options: Record<string, unknown>): FakeChild => {
    const child = new FakeChild();
    calls.push({ binary, args, options });
    const script = scripts.shift();
    if (!script) throw new Error("fake spawn called more times than scripted");
    setImmediate(() => script(child));
    return child;
  };
  return { spawnFn, calls };
}

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function successScript(input: { sessionId: string; text: string; extraLines?: string[] }): ChildScript {
  return (child) => {
    child.stdout.emit(
      "data",
      line({
        type: "system",
        subtype: "init",
        session_id: input.sessionId,
        model: "Composer 2.5",
        permissionMode: "default",
      }),
    );
    for (const extra of input.extraLines ?? []) child.stdout.emit("data", extra);
    child.stdout.emit(
      "data",
      line({
        type: "result",
        subtype: "success",
        is_error: false,
        result: input.text,
        session_id: input.sessionId,
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 0 },
      }),
    );
    child.stdout.emit("end");
    child.emit("close", 0, null);
  };
}

function authFailureScript(): ChildScript {
  return (child) => {
    child.stderr.emit(
      "data",
      "Error: Authentication required. Please run 'agent login' first, or set CURSOR_API_KEY environment variable.\n",
    );
    child.stdout.emit("end");
    child.emit("close", 1, null);
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
  return { id, chatId: "chat-cursor", senderId: "human-1", format: "text", content, metadata: {} };
}

let workspaceRoot: string;

function makeContext(opts: {
  events: SessionEvent[];
  forwardResult?: (text: string) => Promise<void>;
  replaceSessionId?: (sessionId: string, reason: string) => void;
}): SessionContext {
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  const plumbing = mockCtxPlumbing({ sendMessage }, "chat-cursor");
  return {
    agent: {
      agentId: "agent-cursor-1",
      inboxId: "inbox_agent-cursor-1",
      displayName: "cursor-assistant",
      type: "agent",
      visibility: "organization",
      delegateMention: null,
      metadata: {},
    },
    // fetchChatContext failures are logged and tolerated — a throwing fake sdk
    // exercises that path without network.
    sdk: { sendMessage } as unknown as SessionContext["sdk"],
    chatId: "chat-cursor",
    log: () => {},
    recordProviderActivity: () => {},
    emitEvent: (event) => {
      opts.events.push(event);
    },
    ...plumbing,
    ...(opts.forwardResult ? { forwardResult: opts.forwardResult } : {}),
    ...(opts.replaceSessionId ? { replaceSessionId: opts.replaceSessionId } : {}),
  };
}

function makeHandler(spawnFn: unknown, extraConfig: Record<string, unknown> = {}) {
  return createCursorHandler({
    workspaceRoot,
    runtimeProvider: "cursor",
    cursorSpawnFn: spawnFn,
    cursorBinaryResolver: () => ({ ok: true, binary: "/fake/bin/cursor-agent", version: "2026.07.09-test" }),
    ...extraConfig,
  });
}

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "cursor-handler-test-"));
});

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});

describe("buildCursorTurnArgs — canonical spawn contract", () => {
  it("locks the exact canonical argv, with model/resume only when supplied", () => {
    expect(buildCursorTurnArgs({ model: "", resumeSessionId: null })).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--sandbox",
      "disabled",
      "--force",
    ]);
    expect(buildCursorTurnArgs({ model: "composer-2.5", resumeSessionId: "abc" })).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--sandbox",
      "disabled",
      "--force",
      "--model",
      "composer-2.5",
      "--resume",
      "abc",
    ]);
  });
});

describe("cursor handler — per-turn CLI transport", () => {
  it("start: prompt on stdin only, cwd = agent home, canonical args, session id from stream", async () => {
    const events: SessionEvent[] = [];
    const { spawnFn, calls } = makeFakeSpawn([successScript({ sessionId: "sess-real-1", text: "hello world" })]);
    const forwarded: string[] = [];
    const handler = makeHandler(spawnFn);
    const token = makeToken();

    const result = await handler.start(
      makeMessage("m1", "do the thing"),
      makeContext({ events, forwardResult: async (text) => void forwarded.push(text) }),
      token,
    );

    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (!call) throw new Error("unreachable");
    expect(call.binary).toBe("/fake/bin/cursor-agent");
    expect(call.args).toEqual(["-p", "--output-format", "stream-json", "--sandbox", "disabled", "--force"]);
    expect(call.options).toMatchObject({ cwd: workspaceRoot, shell: false });
    // Prompt rides stdin (with the runtime output contract prepended) — never argv.
    const child = call.options;
    expect(child).toBeDefined();
    expect(call.args.join(" ")).not.toContain("do the thing");

    expect(result).toMatchObject({ sessionId: "sess-real-1", route: { kind: "owned", mode: "processing" } });
    expect(token.completed).toMatchObject([{ status: "success", terminal: true }]);
    expect(forwarded).toEqual(["hello world"]);
    // Final text is emitted as assistant_text (from result.result), plus token_usage + turn_end.
    expect(events.some((e) => e.kind === "assistant_text" && e.payload.text === "hello world")).toBe(true);
    expect(events.some((e) => e.kind === "token_usage")).toBe(true);
    expect(events.at(-1)).toMatchObject({ kind: "turn_end", payload: { status: "success" } });
  });

  it("start writes stdin and ends it", async () => {
    const events: SessionEvent[] = [];
    let seenStdin = "";
    const { spawnFn } = makeFakeSpawn([
      (child) => {
        seenStdin = child.stdin.written;
        successScript({ sessionId: "s1", text: "ok" })(child);
      },
    ]);
    const handler = makeHandler(spawnFn);
    await handler.start(makeMessage("m1", "the prompt body"), makeContext({ events }), makeToken());
    expect(seenStdin).toContain("the prompt body");
    // Provider-neutral runtime output contract precedes the inbound message.
    expect(seenStdin.indexOf("the prompt body")).toBeGreaterThan(0);
  });

  it("resume: passes --resume with the stream-confirmed id and the operator model verbatim", async () => {
    const events: SessionEvent[] = [];
    const { spawnFn, calls } = makeFakeSpawn([successScript({ sessionId: "sess-real-2", text: "resumed" })]);
    const payload = {
      kind: "cursor" as const,
      prompt: { append: "" },
      model: "gpt-5.3-codex-high",
      mcpServers: [],
      env: [],
      gitRepos: [],
      resourceSkills: [],
    };
    const handler = makeHandler(spawnFn, {
      agentConfigCache: { refresh: async () => ({ payload }), get: () => ({ payload }) },
    });

    await handler.resume(makeMessage("m2", "continue"), "sess-real-2", makeContext({ events }), makeToken());

    const call = calls[0];
    if (!call) throw new Error("unreachable");
    expect(call.args).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--sandbox",
      "disabled",
      "--force",
      "--model",
      "gpt-5.3-codex-high",
      "--resume",
      "sess-real-2",
    ]);
  });

  it("first-turn auth failure settles consumed-terminal, returns a synthetic id, and never resumes with it", async () => {
    const events: SessionEvent[] = [];
    const replaceCalls: Array<{ id: string; reason: string }> = [];
    const { spawnFn, calls } = makeFakeSpawn([
      authFailureScript(),
      successScript({ sessionId: "sess-real-3", text: "recovered" }),
    ]);
    const handler = makeHandler(spawnFn);
    const token = makeToken();
    const ctx = makeContext({
      events,
      replaceSessionId: (id, reason) => void replaceCalls.push({ id, reason }),
    });

    const started = await handler.start(makeMessage("m1", "hi"), ctx, token);
    if (typeof started === "string") throw new Error("expected a start receipt");
    // Terminal credential failure: delivery consumed (durable-notice path is
    // SessionManager's, keyed off the provider-retry event emitted below).
    expect(token.completed).toMatchObject([{ status: "error", completion: "consumed" }]);
    expect(started.sessionId.startsWith(CURSOR_PENDING_SESSION_PREFIX)).toBe(true);
    // The structured provider-retry event that drives notice-before-ACK.
    expect(
      events.some(
        (e) => e.kind === "error" && e.payload.source === "runtime" && e.payload.message.startsWith("provider.retry:"),
      ),
    ).toBe(true);
    // The user-facing error is reframed with the cursor login hint.
    expect(
      events.some(
        (e) => e.kind === "error" && e.payload.source === "sdk" && /cursor-agent login/.test(e.payload.message),
      ),
    ).toBe(true);

    // Resuming with the synthetic id must NOT put it on --resume; the real id
    // captured from the stream upgrades the mapping via replaceSessionId.
    const token2 = makeToken();
    await handler.resume(makeMessage("m2", "again"), started.sessionId, ctx, token2);
    const secondCall = calls[1];
    if (!secondCall) throw new Error("unreachable");
    expect(secondCall.args).not.toContain("--resume");
    expect(secondCall.args.join(" ")).not.toContain(started.sessionId);
    expect(replaceCalls).toMatchObject([{ id: "sess-real-3", reason: "cursor_session_id_confirmed" }]);
    expect(token2.completed).toMatchObject([{ status: "success" }]);
  });

  it("empty-text success still invokes the completion hook (silent/tool-only turn)", async () => {
    const events: SessionEvent[] = [];
    const forwarded: string[] = [];
    const { spawnFn } = makeFakeSpawn([successScript({ sessionId: "s-silent", text: "" })]);
    const handler = makeHandler(spawnFn);
    const token = makeToken();

    await handler.start(
      makeMessage("m1", "quiet work"),
      makeContext({ events, forwardResult: async (text) => void forwarded.push(text) }),
      token,
    );

    expect(forwarded).toEqual([""]);
    expect(token.completed).toMatchObject([{ status: "success" }]);
    // No assistant_text noise for an empty reply.
    expect(events.some((e) => e.kind === "assistant_text")).toBe(false);
  });

  it("shell tool completion emits a tool_call event with repo-qualified tree refs", async () => {
    const events: SessionEvent[] = [];
    const contextTreePath = join(workspaceRoot, "context-tree");
    const shellLines = [
      line({
        type: "tool_call",
        subtype: "started",
        call_id: "tool_1",
        tool_call: { shellToolCall: { args: { command: "cat context-tree/NODE.md", workingDirectory: "" } } },
        session_id: "s-io",
      }),
      line({
        type: "tool_call",
        subtype: "completed",
        call_id: "tool_1",
        tool_call: {
          shellToolCall: {
            args: { command: "cat context-tree/NODE.md", workingDirectory: "" },
            result: { success: { command: "cat context-tree/NODE.md", exitCode: 0, stdout: "# node", stderr: "" } },
          },
        },
        session_id: "s-io",
      }),
    ];
    const { spawnFn } = makeFakeSpawn([successScript({ sessionId: "s-io", text: "read it", extraLines: shellLines })]);
    const handler = makeHandler(spawnFn, {
      contextTreePath,
      contextTreeRepoUrl: "https://github.com/acme/tree.git",
      contextTreeBranch: "main",
    });

    await handler.start(makeMessage("m1", "read the node"), makeContext({ events }), makeToken());

    const completed = events.find(
      (e) => e.kind === "tool_call" && e.payload.status === "ok" && e.payload.name === "shell",
    );
    expect(completed).toBeDefined();
    if (completed?.kind !== "tool_call") throw new Error("unreachable");
    expect(completed.payload.toolFileRefs).toBeDefined();
    expect(completed.payload.toolFileRefs).toMatchObject([
      {
        repoUrl: "https://github.com/acme/tree.git",
        repoBranch: "main",
        repoRelativePath: "NODE.md",
      },
    ]);
  });

  it("edit tool completion derives a file_change ref from the native path", async () => {
    const events: SessionEvent[] = [];
    const contextTreePath = join(workspaceRoot, "context-tree");
    const editLines = [
      line({
        type: "tool_call",
        subtype: "completed",
        call_id: "tool_2",
        tool_call: {
          editToolCall: {
            args: { path: join(contextTreePath, "system", "NODE.md"), streamContent: "x" },
            result: { success: { path: join(contextTreePath, "system", "NODE.md"), linesAdded: 1, linesRemoved: 0 } },
          },
        },
        session_id: "s-io2",
      }),
    ];
    const { spawnFn } = makeFakeSpawn([successScript({ sessionId: "s-io2", text: "edited", extraLines: editLines })]);
    const handler = makeHandler(spawnFn, {
      contextTreePath,
      contextTreeRepoUrl: "https://github.com/acme/tree.git",
      contextTreeBranch: "main",
    });

    await handler.start(makeMessage("m1", "edit the node"), makeContext({ events }), makeToken());

    const completed = events.find(
      (e) => e.kind === "tool_call" && e.payload.name === "edit" && e.payload.status === "ok",
    );
    if (completed?.kind !== "tool_call") throw new Error("expected an ok edit tool_call event");
    expect(completed.payload.toolFileRefs).toMatchObject([
      {
        origin: "file_change",
        repoUrl: "https://github.com/acme/tree.git",
        repoRelativePath: "system/NODE.md",
      },
    ]);
  });

  it("inject while a turn is active queues and drains as an ordered batch afterwards", async () => {
    const events: SessionEvent[] = [];
    const releaseFirst: { value: (() => void) | null } = { value: null };
    const { spawnFn, calls } = makeFakeSpawn([
      (child) => {
        // Hold the first turn open until the test injects.
        releaseFirst.value = () => successScript({ sessionId: "s-q", text: "first done" })(child);
      },
      successScript({ sessionId: "s-q", text: "queued done" }),
    ]);
    const handler = makeHandler(spawnFn);
    const token1 = makeToken();
    const startPromise = handler.start(makeMessage("m1", "long turn"), makeContext({ events }), token1);

    // Wait for the first spawn, then inject mid-turn.
    await vi.waitFor(() => {
      if (calls.length === 0) throw new Error("not spawned yet");
    });
    const token2 = makeToken();
    const receipt = handler.inject(makeMessage("m2", "queued message"), token2);
    expect(receipt).toMatchObject({ kind: "owned", mode: "queued" });

    releaseFirst.value?.();
    await startPromise;
    await vi.waitFor(() => {
      if (token2.completed.length === 0) throw new Error("queued turn not settled yet");
    });

    expect(calls).toHaveLength(2);
    // The queued turn resumed the now-confirmed session id.
    const second = calls[1];
    if (!second) throw new Error("unreachable");
    expect(second.args).toContain("--resume");
    expect(second.args).toContain("s-q");
    expect(token1.completed).toMatchObject([{ status: "success" }]);
    expect(token2.completed).toMatchObject([{ status: "success" }]);
  });

  it("keeps token_usage on a failed turn and prefers the result error text over stderr noise", async () => {
    const events: SessionEvent[] = [];
    const { spawnFn } = makeFakeSpawn([
      (child) => {
        child.stdout.emit(
          "data",
          line({ type: "system", subtype: "init", session_id: "s-fail", model: "Composer 2.5" }),
        );
        child.stdout.emit(
          "data",
          line({
            type: "result",
            subtype: "error",
            is_error: true,
            result: "You've hit your usage limit for this model",
            session_id: "s-fail",
            usage: { inputTokens: 500, outputTokens: 20, cacheReadTokens: 100, cacheWriteTokens: 0 },
          }),
        );
        // Benign beta-CLI stderr noise must not mask the logical failure.
        child.stderr.emit("data", "warning: a new cursor-agent version is available\n");
        child.stdout.emit("end");
        child.emit("close", 1, null);
      },
    ]);
    const handler = makeHandler(spawnFn);
    const token = makeToken();

    await handler.start(makeMessage("m1", "hi"), makeContext({ events }), token);

    // Billed tokens on the failed turn still produce a token_usage event.
    const usage = events.find((e) => e.kind === "token_usage");
    expect(usage).toBeDefined();
    if (usage?.kind !== "token_usage") throw new Error("unreachable");
    expect(usage.payload.inputTokens).toBe(500);
    // Classification saw the quota text (capacity), not the update warning.
    const sdkError = events.find((e) => e.kind === "error" && e.payload.source === "sdk");
    if (sdkError?.kind !== "error") throw new Error("expected an sdk error event");
    expect(sdkError.payload.message).toContain("usage limit");
    expect(token.completed).toMatchObject([{ status: "error", completion: "consumed" }]);
  });

  it("fails closed for landing campaign trial agents (app-server-only contract)", async () => {
    const { spawnFn } = makeFakeSpawn([]);
    const handler = makeHandler(spawnFn);
    const events: SessionEvent[] = [];
    const ctx = makeContext({ events });
    ctx.agent.metadata = {
      landingCampaignTrial: true,
      campaign: "production-scan",
      skillSetId: "production-scan",
      skillSetVersion: "2026.07.02.1",
      repo: { url: "https://github.com/acme/backend", canonicalKey: "github.com/acme/backend" },
    };
    await expect(handler.start(makeMessage("m1", "hi"), ctx, makeToken())).rejects.toThrow(
      /landing campaign trial agents require the codex app-server/,
    );
  });

  it("admin resume (no message) clears the bring-up guard so later injects still drain", async () => {
    const events: SessionEvent[] = [];
    const { spawnFn, calls } = makeFakeSpawn([successScript({ sessionId: "s-admin", text: "after admin resume" })]);
    const handler = makeHandler(spawnFn);

    // Handler contract: `message` is undefined for admin-triggered resume.
    const receipt = await handler.resume(undefined, "s-admin", makeContext({ events }), makeToken());
    if (typeof receipt === "string") throw new Error("expected a resume receipt");
    expect(receipt.route).toBeNull();

    // A later inject must actually enter the provider and settle — the
    // message-less resume must not leave initialTurnPreparing latched.
    const token = makeToken();
    const injectReceipt = handler.inject(makeMessage("m-post-admin", "hello"), token);
    expect(injectReceipt).toMatchObject({ kind: "owned", mode: "queued" });
    await vi.waitFor(() => {
      if (token.completed.length === 0) throw new Error("queued turn not settled yet");
    });
    expect(calls).toHaveLength(1);
    expect(token.completed).toMatchObject([{ status: "success" }]);
  });

  it("shell refs resolve relative paths against Cursor's reported workingDirectory, not the agent home", async () => {
    const events: SessionEvent[] = [];
    const contextTreePath = join(workspaceRoot, "context-tree");
    const shellLines = [
      line({
        type: "tool_call",
        subtype: "completed",
        call_id: "tool_wd",
        tool_call: {
          shellToolCall: {
            // Relative command executed FROM the tree clone — the provider
            // reports the real workingDirectory; attributing it to the agent
            // home would misresolve to <home>/NODE.md and drop the tree read.
            args: { command: "cat NODE.md", workingDirectory: contextTreePath },
            result: { success: { command: "cat NODE.md", exitCode: 0, stdout: "# node", stderr: "" } },
          },
        },
        session_id: "s-wd",
      }),
    ];
    const { spawnFn } = makeFakeSpawn([successScript({ sessionId: "s-wd", text: "done", extraLines: shellLines })]);
    const handler = makeHandler(spawnFn, {
      contextTreePath,
      contextTreeRepoUrl: "https://github.com/acme/tree.git",
      contextTreeBranch: "main",
    });

    await handler.start(makeMessage("m1", "read the node"), makeContext({ events }), makeToken());

    const completed = events.find(
      (e) => e.kind === "tool_call" && e.payload.name === "shell" && e.payload.status === "ok",
    );
    if (completed?.kind !== "tool_call") throw new Error("expected an ok shell tool_call event");
    expect(completed.payload.toolFileRefs).toMatchObject([
      { repoUrl: "https://github.com/acme/tree.git", repoRelativePath: "NODE.md" },
    ]);
    // The working-turn UI must see the cwd the provider actually used.
    expect(completed.payload.args).toMatchObject({ cwd: contextTreePath });
  });

  it("emits a one-time MCP unsupported diagnostic when the payload configures MCP servers", async () => {
    const events: SessionEvent[] = [];
    const payload = {
      kind: "cursor" as const,
      prompt: { append: "" },
      model: "",
      mcpServers: [{ name: "docs", transport: "stdio" as const, command: "docs-server", args: [] }],
      env: [],
      gitRepos: [],
      resourceSkills: [],
    };
    const { spawnFn } = makeFakeSpawn([successScript({ sessionId: "s-mcp", text: "done" })]);
    const handler = makeHandler(spawnFn, {
      agentConfigCache: { refresh: async () => ({ payload }), get: () => ({ payload }) },
    });

    await handler.start(makeMessage("m1", "hi"), makeContext({ events }), makeToken());

    const diagnostics = events.filter(
      (e) => e.kind === "error" && e.payload.source === "runtime" && /MCP server/.test(e.payload.message),
    );
    expect(diagnostics).toHaveLength(1);
  });
});
