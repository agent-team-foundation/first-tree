import { EventEmitter } from "node:events";

import { SdkError } from "@first-tree/client";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bootstrapMocks = vi.hoisted(() => ({
  ensureFreshAccessToken: vi.fn(),
  resolveServerUrl: vi.fn(),
}));

const cliFetchMock = vi.hoisted(() => vi.fn());

const resolveAgentMock = vi.hoisted(() => vi.fn());

const localAgentMocks = vi.hoisted(() => ({
  createSdk: vi.fn(),
  handleSdkError: vi.fn((error: unknown) => {
    throw error;
  }),
}));

const docCaptureMock = vi.hoisted(() => ({
  captureOutboundDocs: vi.fn(),
}));

const ioMocks = vi.hoisted(() => ({
  readStdin: vi.fn(),
}));

const outputMocks = vi.hoisted(() => ({
  fail: vi.fn((code: string, message: string, exitCode = 1) => {
    throw Object.assign(new Error(message), { code, exitCode });
  }),
  success: vi.fn(),
}));

const printLineMock = vi.hoisted(() => vi.fn());
const isJsonModeMock = vi.hoisted(() => vi.fn(() => false));

const readlineMocks = vi.hoisted(() => ({
  createInterface: vi.fn(),
}));

vi.mock("../core/bootstrap.js", () => bootstrapMocks);
vi.mock("../core/cli-fetch.js", () => ({ cliFetch: cliFetchMock }));
vi.mock("../commands/_shared/resolve-agent.js", () => ({ resolveAgent: resolveAgentMock }));
vi.mock("../commands/_shared/local-agent.js", () => localAgentMocks);
vi.mock("../core/doc-capture.js", () => docCaptureMock);
vi.mock("../commands/chat/_shared/io.js", () => ioMocks);
vi.mock("../cli/output.js", () => outputMocks);
vi.mock("../core/output.js", () => ({
  isJsonMode: isJsonModeMock,
  print: { line: printLineMock, result: outputMocks.success, fail: outputMocks.fail },
}));
vi.mock("node:readline", () => readlineMocks);

const originalChatId = process.env.FIRST_TREE_CHAT_ID;
const originalExit = process.exit;
const originalSetInterval = globalThis.setInterval;
const originalClearInterval = globalThis.clearInterval;

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: vi.fn(async () => body),
    text: vi.fn(async () => (typeof body === "string" ? body : JSON.stringify(body))),
  } as unknown as Response;
}

async function runChat(args: string[]): Promise<void> {
  const { registerChatCommands } = await import("../commands/chat/index.js");
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeErr: () => undefined, writeOut: () => undefined });
  registerChatCommands(program);
  await program.parseAsync(["node", "test", "chat", ...args]);
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.FIRST_TREE_CHAT_ID = "chat-env";
  bootstrapMocks.ensureFreshAccessToken.mockResolvedValue("user-token");
  bootstrapMocks.resolveServerUrl.mockReturnValue("https://hub.example");
  resolveAgentMock.mockResolvedValue({ uuid: "agent-1", name: "kael", displayName: "Kael" });
  docCaptureMock.captureOutboundDocs.mockImplementation(async (content: string) => ({ content }));
  ioMocks.readStdin.mockResolvedValue("stdin message");
  localAgentMocks.createSdk.mockReturnValue({
    agentId: "agent-self",
    attention: { raise: vi.fn() },
    createChatWithInitialMessage: vi.fn(async () => ({
      chat: { id: "new-chat" },
      message: { id: "new-message" },
      operationId: "op-1",
      replayed: false,
      senderAgentId: "agent-self",
      recipientAgentIds: ["agent-target"],
      participantAgentIds: ["agent-self", "agent-target", "agent-context"],
    })),
    sendMessage: vi.fn(async () => ({ id: "msg-1" })),
    updateChat: vi.fn(async (_chatId: string, patch: unknown) => {
      const patchObject = patch && typeof patch === "object" ? patch : {};
      return { id: "chat-1", ...patchObject };
    }),
  });
  process.exit = vi.fn(((code?: number) => {
    throw Object.assign(new Error("process.exit"), { code });
  }) as never);
});

afterEach(() => {
  if (originalChatId === undefined) {
    delete process.env.FIRST_TREE_CHAT_ID;
  } else {
    process.env.FIRST_TREE_CHAT_ID = originalChatId;
  }
  process.exit = originalExit;
  globalThis.setInterval = originalSetInterval;
  globalThis.clearInterval = originalClearInterval;
});

describe("chat command behavior", () => {
  it("creates a new task chat with raw selectors, explicit operation id, and human output", async () => {
    const sdk = localAgentMocks.createSdk();

    await runChat([
      "create",
      "--to",
      "name:code-agent",
      "--with",
      "id:reviewer-id",
      "--message",
      "Please implement",
      "--format",
      "markdown",
      "--topic",
      "Implementation",
      "--operation-id",
      "op-1",
      "--agent",
      "sender",
    ]);

    expect(localAgentMocks.createSdk).toHaveBeenCalledWith("sender");
    expect(sdk.createChatWithInitialMessage).toHaveBeenCalledWith({
      operationId: "op-1",
      to: ["name:code-agent"],
      with: ["id:reviewer-id"],
      topic: "Implementation",
      message: {
        format: "markdown",
        content: "Please implement",
        source: "cli",
      },
    });
    expect(printLineMock.mock.calls.map((call) => String(call[0])).join("")).toContain("Current session unchanged");
    expect(outputMocks.success).not.toHaveBeenCalled();
  });

  it("creates a new task chat from stdin and emits JSON mode result", async () => {
    isJsonModeMock.mockReturnValueOnce(true);
    docCaptureMock.captureOutboundDocs.mockResolvedValueOnce({
      content: "see docs/plan.md",
      documentContext: [{ path: "docs/plan.md", content: "Plan" }],
    });
    const sdk = localAgentMocks.createSdk();

    await runChat(["create", "--to", "code-agent", "--operation-id", "op-stdin"]);

    expect(sdk.createChatWithInitialMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: "op-stdin",
        to: ["code-agent"],
        with: [],
        message: {
          format: "text",
          content: "see docs/plan.md",
          source: "cli",
          metadata: { documentContext: [{ path: "docs/plan.md", content: "Plan" }] },
        },
      }),
    );
    expect(outputMocks.success).toHaveBeenCalledWith(expect.objectContaining({ chat: { id: "new-chat" } }));
  });

  it("validates chat create local syntax before calling the SDK", async () => {
    await expect(runChat(["create", "--message", "hi"])).rejects.toMatchObject({
      code: "CHAT_CREATE_MISSING_TO",
      exitCode: 2,
    });
    await expect(runChat(["create", "--to", "a", "--to", "a", "--message", "hi"])).rejects.toMatchObject({
      code: "CHAT_CREATE_DUPLICATE_TARGET",
      exitCode: 2,
    });
    await expect(runChat(["create", "--to", "a", "--message", "hi", "--format", "card"])).rejects.toMatchObject({
      code: "CHAT_CREATE_INVALID_FORMAT",
      exitCode: 2,
    });
    ioMocks.readStdin.mockResolvedValueOnce("   ");
    await expect(runChat(["create", "--to", "a"])).rejects.toMatchObject({
      code: "CHAT_CREATE_EMPTY_MESSAGE",
      exitCode: 2,
    });
    const sdk = localAgentMocks.createSdk();
    expect(sdk.createChatWithInitialMessage).not.toHaveBeenCalled();
  });

  it("maps unknown chat create commit status to a retryable operation-id envelope", async () => {
    const sdk = localAgentMocks.createSdk();
    sdk.createChatWithInitialMessage.mockRejectedValueOnce(new SdkError(502, "bad gateway"));

    await expect(
      runChat(["create", "--to", "code-agent", "--message", "go", "--operation-id", "op-retry"]),
    ).rejects.toMatchObject({ code: "CHAT_CREATE_UNKNOWN_COMMIT_STATUS", exitCode: 1 });
    expect(outputMocks.fail).toHaveBeenLastCalledWith(
      "CHAT_CREATE_UNKNOWN_COMMIT_STATUS",
      "Unable to confirm whether chat create committed.",
      1,
      expect.objectContaining({ details: expect.objectContaining({ operationId: "op-retry" }) }),
    );
  });

  it("maps terminal SDK network errors to chat create unknown commit status", async () => {
    const sdk = localAgentMocks.createSdk();
    const cases = [
      [Object.assign(new Error("timeout"), { name: "TimeoutError" }), "op-timeout"],
      [Object.assign(new Error("aborted"), { name: "AbortError" }), "op-abort"],
      [new TypeError("fetch failed"), "op-fetch"],
      [Object.assign(new Error("request failed"), { cause: { code: "ETIMEDOUT" } }), "op-cause"],
    ] as const;

    for (const [error, operationId] of cases) {
      sdk.createChatWithInitialMessage.mockRejectedValueOnce(error);
      await expect(
        runChat(["create", "--to", "code-agent", "--message", "go", "--operation-id", operationId]),
      ).rejects.toMatchObject({ code: "CHAT_CREATE_UNKNOWN_COMMIT_STATUS", exitCode: 1 });
      expect(outputMocks.fail).toHaveBeenLastCalledWith(
        "CHAT_CREATE_UNKNOWN_COMMIT_STATUS",
        "Unable to confirm whether chat create committed.",
        1,
        expect.objectContaining({ details: expect.objectContaining({ operationId }) }),
      );
    }
  });

  it("sends messages with metadata, stdin fallback, document context, and validation errors", async () => {
    docCaptureMock.captureOutboundDocs.mockResolvedValueOnce({
      content: "see docs/plan.md",
      documentContext: [{ path: "docs/plan.md", content: "Plan" }],
    });
    const sdk = localAgentMocks.createSdk();
    await runChat(["send", "kael", "see docs/plan.md", "--metadata", '{"priority":2}', "--format", "markdown"]);

    expect(sdk.sendMessage).toHaveBeenCalledWith("chat-env", {
      format: "markdown",
      content: "see docs/plan.md",
      metadata: { priority: 2, documentContext: [{ path: "docs/plan.md", content: "Plan" }] },
      source: "cli",
      receiverNames: ["kael"],
    });
    expect(outputMocks.success).toHaveBeenCalledWith({ id: "msg-1" });

    await runChat(["send", "kael"]);
    expect(sdk.sendMessage).toHaveBeenLastCalledWith("chat-env", expect.objectContaining({ content: "stdin message" }));

    delete process.env.FIRST_TREE_CHAT_ID;
    await expect(runChat(["send", "kael", "hello"])).rejects.toMatchObject({ code: "NO_CHAT_CONTEXT", exitCode: 2 });

    process.env.FIRST_TREE_CHAT_ID = "chat-env";
    await expect(runChat(["send", "kael", "hello", "--metadata", "{bad"])).rejects.toMatchObject({
      code: "INVALID_METADATA",
      exitCode: 2,
    });

    ioMocks.readStdin.mockResolvedValueOnce(null);
    await expect(runChat(["send", "kael"])).rejects.toMatchObject({ code: "NO_MESSAGE", exitCode: 2 });
  });

  it("sends a --request with the body as context and --question as just the ask", async () => {
    const sdk = localAgentMocks.createSdk();
    await runChat([
      "send",
      "kael",
      "Rollout is at 5% and error rate is flat for 24h.",
      "--request",
      "--question",
      "Ship to 20%?",
      "--option",
      "yes",
      "--option",
      "hold",
    ]);

    expect(sdk.sendMessage).toHaveBeenCalledWith(
      "chat-env",
      expect.objectContaining({
        format: "request",
        content: "Rollout is at 5% and error rate is flat for 24h.",
        receiverNames: ["kael"],
        metadata: expect.objectContaining({
          request: {
            questions: [{ id: "q1", prompt: "Ship to 20%?", kind: "single", options: ["yes", "hold"], required: true }],
          },
        }),
      }),
    );
  });

  it("rejects a --request with no body — context belongs in the body, not the question", async () => {
    ioMocks.readStdin.mockResolvedValueOnce(null);
    await expect(runChat(["send", "kael", "--request", "--question", "Ship to 20%?"])).rejects.toMatchObject({
      code: "REQUEST_NEEDS_BODY",
      exitCode: 2,
    });
  });

  it("sets, clears, and validates chat topics", async () => {
    const sdk = localAgentMocks.createSdk();

    await runChat(["set-topic", "  Launch plan  ", "--chat", "chat-1", "--agent", "kael"]);
    expect(localAgentMocks.createSdk).toHaveBeenCalledWith("kael");
    expect(sdk.updateChat).toHaveBeenCalledWith("chat-1", { topic: "Launch plan" });

    await runChat(["set-topic", "--clear"]);
    expect(sdk.updateChat).toHaveBeenLastCalledWith("chat-env", { topic: null });

    await expect(runChat(["set-topic", "bad", "--clear"])).rejects.toMatchObject({
      code: "CONFLICTING_ARGS",
      exitCode: 2,
    });
    await expect(runChat(["set-topic", "   "])).rejects.toMatchObject({ code: "EMPTY_TOPIC", exitCode: 2 });

    delete process.env.FIRST_TREE_CHAT_ID;
    await expect(runChat(["set-topic", "Launch"])).rejects.toMatchObject({ code: "NO_CHAT_CONTEXT", exitCode: 2 });
  });

  it("sets, clears, and validates chat descriptions; updates both fields together", async () => {
    const sdk = localAgentMocks.createSdk();

    await runChat(["set-topic", "--description", "  reviewing PR #42  ", "--chat", "chat-1"]);
    expect(sdk.updateChat).toHaveBeenLastCalledWith("chat-1", { description: "reviewing PR #42" });

    await runChat(["set-topic", "--clear-description"]);
    expect(sdk.updateChat).toHaveBeenLastCalledWith("chat-env", { description: null });

    await runChat(["set-topic", "Launch plan", "--description", "drafting steps"]);
    expect(sdk.updateChat).toHaveBeenLastCalledWith("chat-env", {
      topic: "Launch plan",
      description: "drafting steps",
    });

    await expect(runChat(["set-topic", "--description", "x", "--clear-description"])).rejects.toMatchObject({
      code: "CONFLICTING_ARGS",
      exitCode: 2,
    });
    await expect(runChat(["set-topic", "--description", "   "])).rejects.toMatchObject({
      code: "EMPTY_DESCRIPTION",
      exitCode: 2,
    });
    await expect(runChat(["set-topic"])).rejects.toMatchObject({ code: "NOTHING_TO_UPDATE", exitCode: 2 });
  });

  it("opens an interactive chat, polls, sends input, handles send failures, and closes cleanly", async () => {
    const emitter = new EventEmitter() as EventEmitter & { prompt: () => void };
    emitter.prompt = vi.fn();
    readlineMocks.createInterface.mockReturnValue(emitter);
    globalThis.setInterval = vi.fn(() => 42) as unknown as typeof setInterval;
    globalThis.clearInterval = vi.fn() as unknown as typeof clearInterval;
    cliFetchMock
      .mockResolvedValueOnce(jsonResponse({ id: "dm-1" }))
      .mockResolvedValueOnce(
        jsonResponse({
          items: [{ id: "old", senderId: "agent-1", content: "old", createdAt: "2026-06-01T00:00:00.000Z" }],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ createdAt: "2026-06-01T00:00:01.000Z" }))
      .mockResolvedValueOnce(jsonResponse("nope", false, 500));

    await runChat(["open", "kael"]);

    emitter.emit("line", " hello ");
    await Promise.resolve();
    await Promise.resolve();
    expect(cliFetchMock).toHaveBeenCalledWith(
      "https://hub.example/api/v1/chats/dm-1/messages",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ format: "text", content: "hello" }),
      }),
    );

    emitter.emit("line", "again");
    await Promise.resolve();
    await Promise.resolve();
    expect(printLineMock.mock.calls.map((call) => String(call[0])).join("")).toContain("Failed to send: 500");

    emitter.emit("line", "   ");
    expect(() => emitter.emit("close")).toThrow("process.exit");
    expect(globalThis.clearInterval).toHaveBeenCalledWith(42);
  });
});
