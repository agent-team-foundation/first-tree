import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CreateSessionOptions,
  Event as KimiEvent,
  ResumeSessionInput,
  SessionUsage,
} from "@botiverse/kimi-code-sdk";
import type { AgentRuntimeConfigPayload, SessionEvent } from "@first-tree/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createKimiCodeHandler, formatKimiCodeError, kimiToolIsReadOnly } from "../handlers/kimi-code.js";
import type { DeliveryToken, SessionContext, SessionMessage, TurnOutcome } from "../runtime/handler.js";
import { mockCtxPlumbing } from "./test-helpers.js";

class FakeSession {
  readonly id: string;
  readonly scripts: KimiEvent[][];
  readonly prompts: string[] = [];
  readonly listeners = new Set<(event: KimiEvent) => void>();
  readonly setPermission = vi.fn().mockResolvedValue(undefined);
  readonly setModel = vi.fn().mockResolvedValue(undefined);
  readonly cancel = vi.fn().mockResolvedValue(undefined);
  readonly close = vi.fn().mockResolvedValue(undefined);
  usage: SessionUsage = {
    currentTurn: { inputOther: 11, inputCacheCreation: 2, inputCacheRead: 3, output: 5 },
  };

  constructor(id: string, scripts: KimiEvent[][]) {
    this.id = id;
    this.scripts = scripts;
  }

  onEvent(listener: (event: KimiEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async prompt(input: string): Promise<void> {
    this.prompts.push(input);
    const events = this.scripts.shift();
    if (!events) throw new Error("fake Kimi session called more times than scripted");
    for (const event of events) {
      for (const listener of this.listeners) listener(event);
    }
  }

  async getUsage(): Promise<SessionUsage> {
    return this.usage;
  }
}

function event(sessionId: string, value: Record<string, unknown>): KimiEvent {
  return { agentId: "main", sessionId, ...value } as KimiEvent;
}

function successfulTurn(sessionId: string, text = "done"): KimiEvent[] {
  return [
    event(sessionId, { type: "turn.started", turnId: 1 }),
    event(sessionId, { type: "thinking.delta", turnId: 1, delta: "private reasoning" }),
    event(sessionId, {
      type: "tool.call.started",
      turnId: 1,
      toolCallId: "tool-1",
      name: "Read",
      args: { path: "AGENTS.md" },
    }),
    event(sessionId, { type: "tool.result", turnId: 1, toolCallId: "tool-1", output: "briefing" }),
    event(sessionId, { type: "assistant.delta", turnId: 1, delta: text }),
    event(sessionId, { type: "turn.ended", turnId: 1, reason: "completed" }),
  ];
}

function failedTurn(
  sessionId: string,
  code: string,
  options: { retryable?: boolean; beforeError?: KimiEvent[] } = {},
): KimiEvent[] {
  const error = {
    code,
    message: code,
    ...(options.retryable === undefined ? {} : { retryable: options.retryable }),
  };
  return [
    event(sessionId, { type: "turn.started", turnId: 1 }),
    ...(options.beforeError ?? []),
    event(sessionId, { type: "error", ...error }),
    event(sessionId, { type: "turn.ended", turnId: 1, reason: "failed", error }),
  ];
}

function makeToken(): DeliveryToken & { completed: TurnOutcome[]; retried: string[] } {
  const completed: TurnOutcome[] = [];
  const retried: string[] = [];
  return {
    completed,
    retried,
    processingStarted: () => {},
    complete: async (_messages, outcome) => void completed.push(outcome),
    retry: (_messages, reason) => void retried.push(reason),
    terminalRejected: async () => {},
  };
}

function message(id: string, content: string): SessionMessage {
  return { id, chatId: "chat-kimi", senderId: "human-1", format: "text", content, metadata: {} };
}

function makeContext(events: SessionEvent[]): SessionContext {
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  return {
    agent: {
      agentId: "agent-kimi",
      inboxId: "inbox-kimi",
      displayName: "kimi-assistant",
      type: "agent",
      visibility: "organization",
      delegateMention: null,
      metadata: {},
    },
    sdk: { sendMessage } as unknown as SessionContext["sdk"],
    chatId: "chat-kimi",
    log: () => {},
    recordProviderActivity: () => {},
    emitEvent: (value) => void events.push(value),
    ...mockCtxPlumbing({ sendMessage }, "chat-kimi"),
  };
}

let workspaceRoot: string;

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "kimi-handler-test-"));
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(workspaceRoot, { recursive: true, force: true });
});

function makeHandler(
  fakeSession: FakeSession,
  captures: { create?: CreateSessionOptions; resume?: ResumeSessionInput },
) {
  const fakeKaos = {
    withCwd: vi.fn().mockReturnThis(),
    withEnv: vi.fn().mockReturnThis(),
  };
  return createKimiCodeHandler({
    workspaceRoot,
    runtimeProvider: "kimi-code",
    kimiKaosFactory: async () => fakeKaos,
    kimiHarnessFactory: () => ({
      createSession: async (options: CreateSessionOptions) => {
        captures.create = options;
        return fakeSession;
      },
      resumeSession: async (input: ResumeSessionInput) => {
        captures.resume = input;
        return fakeSession;
      },
      close: async () => {},
    }),
  });
}

describe("Kimi Code handler", () => {
  it("creates a yolo session with the standing role contract and translates a successful turn", async () => {
    const fakeSession = new FakeSession("kimi-session-1", [successfulTurn("kimi-session-1", "hello from Kimi")]);
    const captures: { create?: CreateSessionOptions } = {};
    const handler = makeHandler(fakeSession, captures);
    const events: SessionEvent[] = [];
    const token = makeToken();

    const result = await handler.start(message("m1", "do work"), makeContext(events), token);

    expect(result).toMatchObject({ sessionId: "kimi-session-1", route: { kind: "owned", mode: "processing" } });
    expect(captures.create).toMatchObject({
      workDir: workspaceRoot,
      permission: "yolo",
    });
    expect(captures.create).not.toHaveProperty("model");
    expect(captures.create?.roleAdditional).toContain("First Tree");
    expect(fakeSession.prompts).toEqual(["[From: human-1]\n\ndo work"]);
    expect(events.some((item) => item.kind === "thinking")).toBe(true);
    expect(events).toContainEqual({ kind: "assistant_text", payload: { text: "hello from Kimi" } });
    expect(events).toContainEqual({
      kind: "token_usage",
      payload: {
        provider: "kimi-code",
        model: "kimi-default",
        inputTokens: 13,
        cachedInputTokens: 3,
        outputTokens: 5,
      },
    });
    expect(events.at(-1)).toEqual({ kind: "turn_end", payload: { status: "success" } });
    expect(token.completed).toEqual([{ status: "success" }]);
  });

  it("resumes with roleAdditional/kaos and reapplies explicit model plus permission", async () => {
    const fakeSession = new FakeSession("kimi-session-2", [successfulTurn("kimi-session-2")]);
    const captures: { resume?: ResumeSessionInput } = {};
    const payload = {
      kind: "kimi-code" as const,
      prompt: { append: "" },
      model: "kimi-for-coding",
      mcpServers: [],
      env: [],
      gitRepos: [],
      resourceSkills: [],
    };
    const handler = createKimiCodeHandler({
      workspaceRoot,
      runtimeProvider: "kimi-code",
      agentConfigCache: { refresh: async () => ({ payload }), get: () => ({ payload }) },
      kimiKaosFactory: async () => ({ withCwd: vi.fn().mockReturnThis(), withEnv: vi.fn().mockReturnThis() }),
      kimiHarnessFactory: () => ({
        createSession: async () => fakeSession,
        resumeSession: async (input: ResumeSessionInput) => {
          captures.resume = input;
          return fakeSession;
        },
        close: async () => {},
      }),
    });

    await handler.resume(message("m2", "continue"), "kimi-session-2", makeContext([]), makeToken());

    expect(captures.resume).toMatchObject({ id: "kimi-session-2" });
    expect(captures.resume?.roleAdditional).toContain("First Tree");
    expect(fakeSession.setPermission).toHaveBeenCalledWith("yolo");
    expect(fakeSession.setModel).toHaveBeenCalledWith("kimi-for-coding");
  });

  it("does not pass declared but unmaterialized workspace repos as SDK additional directories", async () => {
    const fakeSession = new FakeSession("kimi-session-unmaterialized", [successfulTurn("kimi-session-unmaterialized")]);
    const captures: { create?: CreateSessionOptions } = {};
    const payload: AgentRuntimeConfigPayload = {
      kind: "kimi-code",
      prompt: { append: "" },
      model: "",
      mcpServers: [],
      env: [],
      gitRepos: [{ url: "https://example.com/acme/missing-source.git", localPath: "missing-source" }],
      resourceSkills: [],
    };
    const contextTreePath = join(workspaceRoot, "context-tree");
    const handler = createKimiCodeHandler({
      workspaceRoot,
      runtimeProvider: "kimi-code",
      contextTreePath,
      contextTreeRepoUrl: "https://example.com/acme/context-tree.git",
      agentConfigCache: { refresh: async () => ({ payload }), get: () => ({ payload }) },
      kimiKaosFactory: async () => ({ withCwd: vi.fn().mockReturnThis(), withEnv: vi.fn().mockReturnThis() }),
      kimiHarnessFactory: () => ({
        createSession: async (options: CreateSessionOptions) => {
          captures.create = options;
          return fakeSession;
        },
        resumeSession: async () => fakeSession,
        close: async () => {},
      }),
    });

    await handler.start(message("m1", "materialize the declared repos"), makeContext([]), makeToken());

    expect(captures.create?.workDir).toBe(workspaceRoot);
    expect(captures.create?.additionalDirs).toEqual([]);
  });

  it.each([
    "provider.connection_error",
    "provider.rate_limit",
  ] as const)("never retries %s after a write even when a later tool is read-only", async (errorCode) => {
    vi.useFakeTimers();
    const id = "kimi-session-unsafe-replay";
    const fakeSession = new FakeSession(id, [
      failedTurn(id, errorCode, {
        retryable: true,
        beforeError: [
          event(id, {
            type: "tool.call.started",
            turnId: 1,
            toolCallId: "write-1",
            name: "Write",
            args: { path: "changed.txt", content: "changed" },
          }),
          event(id, { type: "tool.result", turnId: 1, toolCallId: "write-1", output: "ok" }),
          event(id, {
            type: "tool.call.started",
            turnId: 1,
            toolCallId: "read-1",
            name: "Read",
            args: { path: "changed.txt" },
          }),
          event(id, { type: "tool.result", turnId: 1, toolCallId: "read-1", output: "changed" }),
        ],
      }),
      successfulTurn(id, "must not run"),
    ]);
    const handler = makeHandler(fakeSession, {});
    const token = makeToken();

    const turn = handler.start(message("m1", "write once"), makeContext([]), token);
    await vi.runAllTimersAsync();
    await turn;

    expect(fakeSession.prompts).toHaveLength(1);
    expect(token.completed).toMatchObject([{ status: "error", completion: "consumed", reason: "unsafe_replay" }]);
  });

  it("retries a retryable Kimi rate limit before side effects", async () => {
    vi.useFakeTimers();
    const id = "kimi-session-rate-limit";
    const fakeSession = new FakeSession(id, [
      failedTurn(id, "provider.rate_limit", { retryable: true }),
      successfulTurn(id, "recovered"),
    ]);
    const handler = makeHandler(fakeSession, {});
    const token = makeToken();

    const turn = handler.start(message("m1", "retry safely"), makeContext([]), token);
    await vi.runAllTimersAsync();
    await turn;

    expect(fakeSession.prompts).toHaveLength(2);
    expect(token.completed).toEqual([{ status: "success" }]);
  });

  it.each([
    "permission",
    "model",
  ] as const)("closes the resumed session and harness when %s initialization fails", async (failurePoint) => {
    const fakeSession = new FakeSession("kimi-session-init-failure", []);
    const harnessClose = vi.fn().mockResolvedValue(undefined);
    if (failurePoint === "permission") {
      fakeSession.setPermission.mockRejectedValueOnce(new Error("permission setup failed"));
    } else {
      fakeSession.setModel.mockRejectedValueOnce(new Error("model setup failed"));
    }
    const payload: AgentRuntimeConfigPayload = {
      kind: "kimi-code",
      prompt: { append: "" },
      model: "kimi-for-coding",
      mcpServers: [],
      env: [],
      gitRepos: [],
      resourceSkills: [],
    };
    const handler = createKimiCodeHandler({
      workspaceRoot,
      runtimeProvider: "kimi-code",
      agentConfigCache: { refresh: async () => ({ payload }), get: () => ({ payload }) },
      kimiKaosFactory: async () => ({ withCwd: vi.fn().mockReturnThis(), withEnv: vi.fn().mockReturnThis() }),
      kimiHarnessFactory: () => ({
        createSession: async () => fakeSession,
        resumeSession: async () => fakeSession,
        close: harnessClose,
      }),
    });

    await expect(handler.resume(undefined, fakeSession.id, makeContext([]))).rejects.toThrow(
      `${failurePoint} setup failed`,
    );

    expect(fakeSession.close).toHaveBeenCalledTimes(1);
    expect(harnessClose).toHaveBeenCalledTimes(1);
    await handler.shutdown();
    expect(fakeSession.close).toHaveBeenCalledTimes(1);
    expect(harnessClose).toHaveBeenCalledTimes(1);
  });

  it("turns a typed Kimi auth failure into a terminal provider event and login hint", async () => {
    const id = "kimi-session-auth";
    const error = {
      code: "auth.login_required",
      message: "Login required",
      retryable: false,
    };
    const fakeSession = new FakeSession(id, [
      [
        event(id, { type: "turn.started", turnId: 1 }),
        event(id, { type: "error", ...error }),
        event(id, { type: "turn.ended", turnId: 1, reason: "failed", error }),
      ],
    ]);
    const handler = makeHandler(fakeSession, {});
    const events: SessionEvent[] = [];
    const token = makeToken();

    await handler.start(message("m1", "hello"), makeContext(events), token);

    expect(
      events.some(
        (item) =>
          item.kind === "error" &&
          item.payload.source === "runtime" &&
          item.payload.message.startsWith("provider.retry:"),
      ),
    ).toBe(true);
    expect(
      events.some(
        (item) => item.kind === "error" && item.payload.source === "sdk" && item.payload.message.includes("/login"),
      ),
    ).toBe(true);
    expect(token.completed).toMatchObject([{ status: "error", completion: "consumed" }]);
  });

  it("falls back to a cumulative-total delta when the SDK omits currentTurn", async () => {
    const fakeSession = new FakeSession("kimi-session-usage", [successfulTurn("kimi-session-usage")]);
    let usageRead = 0;
    fakeSession.getUsage = async () => {
      usageRead += 1;
      return {
        total:
          usageRead === 1
            ? { inputOther: 10, inputCacheCreation: 2, inputCacheRead: 3, output: 4 }
            : { inputOther: 25, inputCacheCreation: 5, inputCacheRead: 7, output: 10 },
      };
    };
    const handler = makeHandler(fakeSession, {});
    const events: SessionEvent[] = [];

    await handler.start(message("m1", "usage"), makeContext(events), makeToken());

    expect(events).toContainEqual({
      kind: "token_usage",
      payload: {
        provider: "kimi-code",
        model: "kimi-default",
        inputTokens: 18,
        cachedInputTokens: 4,
        outputTokens: 6,
      },
    });
  });
});

describe("Kimi homeDir lifecycle", () => {
  it("normalizes trimmed KIMI_CODE_HOME and forwards it as harness homeDir", async () => {
    const harnessOptions: Array<Record<string, unknown>> = [];
    const payload = {
      kind: "kimi-code" as const,
      prompt: { append: "" },
      model: "",
      mcpServers: [],
      env: [{ key: "KIMI_CODE_HOME", value: "  /custom/kimi  " }],
      gitRepos: [],
      resourceSkills: [],
    };
    const handler = createKimiCodeHandler({
      workspaceRoot,
      runtimeProvider: "kimi-code",
      agentConfigCache: { refresh: async () => ({ payload }), get: () => ({ payload }) },
      kimiKaosFactory: async () => ({ withCwd: vi.fn().mockReturnThis(), withEnv: vi.fn().mockReturnThis() }),
      kimiHarnessFactory: (options) => {
        harnessOptions.push(options as Record<string, unknown>);
        return {
          createSession: async () => new FakeSession("s1", [successfulTurn("s1")]),
          resumeSession: async () => new FakeSession("s1", [successfulTurn("s1")]),
          close: async () => {},
        };
      },
    });

    await handler.start(message("m1", "hi"), makeContext([]), makeToken());

    expect(harnessOptions).toHaveLength(1);
    expect(harnessOptions[0].homeDir).toBe("/custom/kimi");
  });

  it("omits homeDir when KIMI_CODE_HOME is empty or whitespace-only", async () => {
    const harnessOptions: Array<Record<string, unknown>> = [];
    const payload = {
      kind: "kimi-code" as const,
      prompt: { append: "" },
      model: "",
      mcpServers: [],
      env: [{ key: "KIMI_CODE_HOME", value: "   " }],
      gitRepos: [],
      resourceSkills: [],
    };
    const handler = createKimiCodeHandler({
      workspaceRoot,
      runtimeProvider: "kimi-code",
      agentConfigCache: { refresh: async () => ({ payload }), get: () => ({ payload }) },
      kimiKaosFactory: async () => ({ withCwd: vi.fn().mockReturnThis(), withEnv: vi.fn().mockReturnThis() }),
      kimiHarnessFactory: (options) => {
        harnessOptions.push(options as Record<string, unknown>);
        return {
          createSession: async () => new FakeSession("s1", [successfulTurn("s1")]),
          resumeSession: async () => new FakeSession("s1", [successfulTurn("s1")]),
          close: async () => {},
        };
      },
    });

    await handler.start(message("m1", "hi"), makeContext([]), makeToken());

    expect(harnessOptions).toHaveLength(1);
    expect(harnessOptions[0]).not.toHaveProperty("homeDir");
  });

  it("reuses the same harness after suspend when effective home is unchanged", async () => {
    const session = new FakeSession("shared-session", [
      successfulTurn("shared-session"),
      successfulTurn("shared-session"),
    ]);
    let factoryCalls = 0;
    const closeFn = vi.fn().mockResolvedValue(undefined);
    const payload = {
      kind: "kimi-code" as const,
      prompt: { append: "" },
      model: "",
      mcpServers: [],
      env: [{ key: "KIMI_CODE_HOME", value: "/custom/kimi" }],
      gitRepos: [],
      resourceSkills: [],
    };
    const handler = createKimiCodeHandler({
      workspaceRoot,
      runtimeProvider: "kimi-code",
      agentConfigCache: { refresh: async () => ({ payload }), get: () => ({ payload }) },
      kimiKaosFactory: async () => ({ withCwd: vi.fn().mockReturnThis(), withEnv: vi.fn().mockReturnThis() }),
      kimiHarnessFactory: () => {
        factoryCalls++;
        return {
          createSession: async () => session,
          resumeSession: async () => session,
          close: closeFn,
        };
      },
    });

    await handler.start(message("m1", "hi"), makeContext([]), makeToken());
    expect(factoryCalls).toBe(1);
    expect(closeFn).not.toHaveBeenCalled();

    await handler.suspend("test");
    expect(closeFn).not.toHaveBeenCalled();

    await handler.resume(message("m2", "resume"), "shared-session", makeContext([]), makeToken());
    expect(factoryCalls).toBe(1);
    expect(closeFn).not.toHaveBeenCalled();
  });

  it("reuses the default harness across resume when KIMI_CODE_HOME is unset", async () => {
    const session = new FakeSession("default-session", [
      successfulTurn("default-session"),
      successfulTurn("default-session"),
    ]);
    let factoryCalls = 0;
    const closeFn = vi.fn().mockResolvedValue(undefined);
    const payload = {
      kind: "kimi-code" as const,
      prompt: { append: "" },
      model: "",
      mcpServers: [],
      env: [],
      gitRepos: [],
      resourceSkills: [],
    };
    const handler = createKimiCodeHandler({
      workspaceRoot,
      runtimeProvider: "kimi-code",
      agentConfigCache: { refresh: async () => ({ payload }), get: () => ({ payload }) },
      kimiKaosFactory: async () => ({ withCwd: vi.fn().mockReturnThis(), withEnv: vi.fn().mockReturnThis() }),
      kimiHarnessFactory: () => {
        factoryCalls++;
        return {
          createSession: async () => session,
          resumeSession: async () => session,
          close: closeFn,
        };
      },
    });

    await handler.start(message("m1", "hi"), makeContext([]), makeToken());
    expect(factoryCalls).toBe(1);

    await handler.suspend("test");
    expect(closeFn).not.toHaveBeenCalled();

    await handler.resume(message("m2", "resume"), "default-session", makeContext([]), makeToken());
    expect(factoryCalls).toBe(1);
    expect(closeFn).not.toHaveBeenCalled();
  });

  it("closes old harness before creating a replacement when home changes across suspend/resume", async () => {
    const firstSession = new FakeSession("s-1", [successfulTurn("s-1")]);
    const secondSession = new FakeSession("s-2", [successfulTurn("s-2")]);
    let factoryCalls = 0;
    const homes: (string | undefined)[] = [];
    let closeResolver: (() => void) | null = null;
    const closePromise = new Promise<void>((resolve) => {
      closeResolver = resolve;
    });
    const payload = {
      kind: "kimi-code" as const,
      prompt: { append: "" },
      model: "",
      mcpServers: [],
      env: [{ key: "KIMI_CODE_HOME", value: "/old/kimi" }],
      gitRepos: [],
      resourceSkills: [],
    };
    const handler = createKimiCodeHandler({
      workspaceRoot,
      runtimeProvider: "kimi-code",
      agentConfigCache: { refresh: async () => ({ payload }), get: () => ({ payload }) },
      kimiKaosFactory: async () => ({ withCwd: vi.fn().mockReturnThis(), withEnv: vi.fn().mockReturnThis() }),
      kimiHarnessFactory: (options) => {
        factoryCalls++;
        homes.push(options.homeDir);
        return {
          createSession: async () => (factoryCalls === 1 ? firstSession : secondSession),
          resumeSession: async () => (factoryCalls === 2 ? secondSession : firstSession),
          close: factoryCalls === 1 ? async () => { await closePromise; } : async () => {},
        };
      },
    });

    await handler.start(message("m1", "hi"), makeContext([]), makeToken());
    expect(factoryCalls).toBe(1);
    expect(homes).toEqual(["/old/kimi"]);

    // Simulate operator correcting KIMI_CODE_HOME after a credential/config failure.
    payload.env = [{ key: "KIMI_CODE_HOME", value: "/new/kimi" }];

    await handler.suspend("test");

    // Kick off resume; the second harness factory must not fire before
    // the first harness's close promise resolves.
    const resumePromise = handler.resume(message("m2", "resume"), "s-1", makeContext([]), makeToken());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(factoryCalls).toBe(1);
    expect(homes).toEqual(["/old/kimi"]);

    if (closeResolver) closeResolver();
    await resumePromise;

    expect(factoryCalls).toBe(2);
    expect(homes).toEqual(["/old/kimi", "/new/kimi"]);
  });
});

describe("Kimi provider helpers", () => {
  it("only treats reads and proven read-only Bash commands as replay safe", () => {
    expect(kimiToolIsReadOnly("Read", { path: "NODE.md" })).toBe(true);
    expect(kimiToolIsReadOnly("Bash", { command: "cat NODE.md" })).toBe(true);
    expect(kimiToolIsReadOnly("Write", { path: "NODE.md" })).toBe(false);
    expect(kimiToolIsReadOnly("Bash", { command: "touch changed" })).toBe(false);
  });

  it("formats typed auth errors with the official Kimi login recovery", () => {
    const error = new Error("Login required") as Error & { code: string };
    error.code = "auth.login_required";
    expect(formatKimiCodeError(error)).toContain("`kimi` and then `/login`");
  });
});
