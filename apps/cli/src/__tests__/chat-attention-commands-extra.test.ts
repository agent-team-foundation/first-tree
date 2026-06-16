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

const readlineMocks = vi.hoisted(() => ({
  createInterface: vi.fn(),
}));

vi.mock("../core/bootstrap.js", () => bootstrapMocks);
vi.mock("../core/cli-fetch.js", () => ({ cliFetch: cliFetchMock }));
vi.mock("../commands/_shared/resolve-agent.js", () => ({ resolveAgent: resolveAgentMock }));
vi.mock("../commands/_shared/local-agent.js", () => localAgentMocks);
vi.mock("../core/doc-capture.js", () => docCaptureMock);
vi.mock("../commands/chat/_shared/io.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../commands/chat/_shared/io.js")>()),
  readStdin: ioMocks.readStdin,
}));
vi.mock("../cli/output.js", () => outputMocks);
vi.mock("../core/output.js", () => ({
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
  resolveAgentMock.mockResolvedValue({ uuid: "agent-1", name: "nova", displayName: "Nova" });
  docCaptureMock.captureOutboundDocs.mockImplementation(async (content: string) => ({ content }));
  ioMocks.readStdin.mockResolvedValue("stdin message");
  localAgentMocks.createSdk.mockReturnValue({
    agentId: "agent-self",
    attention: { raise: vi.fn() },
    createTaskChat: vi.fn(async () => ({
      chatId: "chat-created",
      messageId: "msg-created",
      initialRecipientAgentIds: ["agent-1"],
      contextParticipantAgentIds: [],
      effectiveSenderId: "agent-self",
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
  it("sends messages with metadata, stdin fallback, document context, and validation errors", async () => {
    docCaptureMock.captureOutboundDocs.mockResolvedValueOnce({
      content: "see docs/plan.md",
      documentContext: [{ path: "docs/plan.md", content: "Plan" }],
    });
    const sdk = localAgentMocks.createSdk();
    await runChat(["send", "nova", "see docs/plan.md", "--metadata", '{"priority":2}', "--format", "markdown"]);

    expect(sdk.sendMessage).toHaveBeenCalledWith("chat-env", {
      format: "markdown",
      content: "see docs/plan.md",
      metadata: { priority: 2, documentContext: [{ path: "docs/plan.md", content: "Plan" }] },
      source: "cli",
      receiverNames: ["nova"],
    });
    expect(outputMocks.success).toHaveBeenCalledWith({ id: "msg-1" });

    await runChat(["send", "nova"]);
    expect(sdk.sendMessage).toHaveBeenLastCalledWith("chat-env", expect.objectContaining({ content: "stdin message" }));

    delete process.env.FIRST_TREE_CHAT_ID;
    await expect(runChat(["send", "nova", "hello"])).rejects.toMatchObject({ code: "NO_CHAT_CONTEXT", exitCode: 2 });

    process.env.FIRST_TREE_CHAT_ID = "chat-env";
    await expect(runChat(["send", "nova", "hello", "--metadata", "{bad"])).rejects.toMatchObject({
      code: "INVALID_METADATA",
      exitCode: 2,
    });

    ioMocks.readStdin.mockResolvedValueOnce(null);
    await expect(runChat(["send", "nova"])).rejects.toMatchObject({ code: "NO_MESSAGE", exitCode: 2 });
  });

  it("sends a --request with the body as context and --question as just the ask", async () => {
    const sdk = localAgentMocks.createSdk();
    await runChat([
      "send",
      "nova",
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
        receiverNames: ["nova"],
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
    await expect(runChat(["send", "nova", "--request", "--question", "Ship to 20%?"])).rejects.toMatchObject({
      code: "REQUEST_NEEDS_BODY",
      exitCode: 2,
    });
  });

  it("passes --subject through as the request's dock/card headline", async () => {
    const sdk = localAgentMocks.createSdk();
    await runChat([
      "send",
      "nova",
      "Rollout is at 5% and error rate is flat for 24h.",
      "--request",
      "--subject",
      "Rollout gate",
      "--question",
      "Ship to 20%?",
      "--option",
      "yes",
    ]);

    expect(sdk.sendMessage).toHaveBeenCalledWith(
      "chat-env",
      expect.objectContaining({
        format: "request",
        metadata: expect.objectContaining({
          request: expect.objectContaining({ subject: "Rollout gate" }),
        }),
      }),
    );
  });

  it("rejects an over-long --question — the wall of text belongs in the body", async () => {
    await expect(
      runChat(["send", "nova", "body context", "--request", "--question", "x".repeat(201)]),
    ).rejects.toMatchObject({ code: "QUESTION_TOO_LONG", exitCode: 2 });
  });

  it("rejects an over-long --subject — it is a headline, not a summary", async () => {
    await expect(
      runChat(["send", "nova", "body context", "--request", "--subject", "s".repeat(81), "--question", "Ship?"]),
    ).rejects.toMatchObject({ code: "SUBJECT_TOO_LONG", exitCode: 2 });
  });

  it("creates task chats with first-message routing and silent context participants", async () => {
    docCaptureMock.captureOutboundDocs.mockResolvedValueOnce({
      content: "see docs/plan.md",
      documentContext: [{ path: "docs/plan.md", content: "Plan" }],
    });
    const sdk = localAgentMocks.createSdk();
    await runChat([
      "create",
      "see docs/plan.md",
      "--to",
      "nova",
      "--to",
      "design",
      "--with",
      "observer",
      "--topic",
      "Review plan",
      "--description",
      "reviewing the new CLI flow",
      "--metadata",
      '{"priority":2}',
      "--format",
      "markdown",
    ]);

    expect(docCaptureMock.captureOutboundDocs).toHaveBeenCalledWith(
      "see docs/plan.md",
      expect.objectContaining({ sdk }),
    );
    expect(sdk.createTaskChat).toHaveBeenCalledWith({
      mode: "task",
      initialRecipientAgentIds: [],
      initialRecipientNames: ["nova", "design"],
      contextParticipantAgentIds: [],
      contextParticipantNames: ["observer"],
      topic: "Review plan",
      description: "reviewing the new CLI flow",
      initialMessage: {
        format: "markdown",
        content: "see docs/plan.md",
        metadata: { priority: 2, documentContext: [{ path: "docs/plan.md", content: "Plan" }] },
        source: "cli",
      },
    });
    expect(sdk.sendMessage).not.toHaveBeenCalled();
    expect(outputMocks.success).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: "chat-created", messageId: "msg-created" }),
    );
  });

  it("creates task chats from stdin and supports request metadata", async () => {
    const sdk = localAgentMocks.createSdk();
    await runChat([
      "create",
      "--to",
      "nova",
      "--agent",
      "worker",
      "--request",
      "--subject",
      "Rollout gate",
      "--question",
      "Ship to 20%?",
      "--option",
      "yes",
      "--option",
      "hold",
    ]);

    expect(localAgentMocks.createSdk).toHaveBeenCalledWith("worker");
    expect(sdk.createTaskChat).toHaveBeenCalledWith(
      expect.objectContaining({
        initialRecipientNames: ["nova"],
        initialMessage: expect.objectContaining({
          format: "request",
          content: "stdin message",
          metadata: {
            request: {
              subject: "Rollout gate",
              questions: [
                {
                  id: "q1",
                  prompt: "Ship to 20%?",
                  kind: "single",
                  options: ["yes", "hold"],
                  required: true,
                },
              ],
            },
          },
        }),
      }),
    );

    await expect(runChat(["create", "body", "--request", "--to", "nova", "--to", "design"])).rejects.toMatchObject({
      code: "REQUEST_NEEDS_ONE_TARGET",
      exitCode: 2,
    });
    await expect(runChat(["create", "body", "--request", "--to", "nova"])).rejects.toMatchObject({
      code: "REQUEST_NEEDS_QUESTION",
      exitCode: 2,
    });
    await expect(
      runChat(["create", "body", "--request", "--to", "nova", "--question", "x".repeat(201)]),
    ).rejects.toMatchObject({ code: "QUESTION_TOO_LONG", exitCode: 2 });
    await expect(
      runChat(["create", "body", "--request", "--to", "nova", "--subject", "s".repeat(81), "--question", "Ship?"]),
    ).rejects.toMatchObject({ code: "SUBJECT_TOO_LONG", exitCode: 2 });
  });

  it("validates chat create input and treats uncertain create outcomes as non-retryable", async () => {
    const sdk = localAgentMocks.createSdk();

    await expect(runChat(["create", "body"])).rejects.toMatchObject({ code: "NO_TARGET", exitCode: 2 });
    await expect(runChat(["create", "body", "--to", "nova", "--metadata", "{bad"])).rejects.toMatchObject({
      code: "INVALID_METADATA",
      exitCode: 2,
    });
    await expect(runChat(["create", "body", "--to", "nova", "--format", "html"])).rejects.toMatchObject({
      code: "INVALID_FORMAT",
      exitCode: 2,
    });
    ioMocks.readStdin.mockResolvedValueOnce("   ");
    await expect(runChat(["create", "--to", "nova"])).rejects.toMatchObject({ code: "NO_MESSAGE", exitCode: 2 });

    sdk.createTaskChat.mockRejectedValueOnce(new SdkError(503, "temporarily unavailable"));
    await expect(runChat(["create", "body", "--to", "nova"])).rejects.toMatchObject({
      code: "CREATE_RESULT_UNKNOWN",
      exitCode: 6,
    });
    expect(sdk.createTaskChat).toHaveBeenCalledTimes(1);
  });

  it("sets, clears, and validates chat topics", async () => {
    const sdk = localAgentMocks.createSdk();

    await runChat(["set-topic", "  Launch plan  ", "--chat", "chat-1", "--agent", "nova"]);
    expect(localAgentMocks.createSdk).toHaveBeenCalledWith("nova");
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

  it("updates topic and description independently via `chat update`", async () => {
    const sdk = localAgentMocks.createSdk();

    await runChat(["update", "--topic", "  Launch plan  ", "--chat", "chat-1", "--agent", "nova"]);
    expect(localAgentMocks.createSdk).toHaveBeenCalledWith("nova");
    expect(sdk.updateChat).toHaveBeenLastCalledWith("chat-1", { topic: "Launch plan" });

    await runChat(["update", "--clear-topic"]);
    expect(sdk.updateChat).toHaveBeenLastCalledWith("chat-env", { topic: null });

    await runChat(["update", "--description", "  reviewing PR #42  ", "--chat", "chat-1"]);
    expect(sdk.updateChat).toHaveBeenLastCalledWith("chat-1", { description: "reviewing PR #42" });

    await runChat(["update", "--clear-description"]);
    expect(sdk.updateChat).toHaveBeenLastCalledWith("chat-env", { description: null });

    await runChat(["update", "--topic", "Launch plan", "--description", "drafting steps"]);
    expect(sdk.updateChat).toHaveBeenLastCalledWith("chat-env", {
      topic: "Launch plan",
      description: "drafting steps",
    });

    await expect(runChat(["update", "--topic", "x", "--clear-topic"])).rejects.toMatchObject({
      code: "CONFLICTING_ARGS",
      exitCode: 2,
    });
    await expect(runChat(["update", "--description", "x", "--clear-description"])).rejects.toMatchObject({
      code: "CONFLICTING_ARGS",
      exitCode: 2,
    });
    await expect(runChat(["update", "--topic", "   "])).rejects.toMatchObject({ code: "EMPTY_TOPIC", exitCode: 2 });
    await expect(runChat(["update", "--description", "   "])).rejects.toMatchObject({
      code: "EMPTY_DESCRIPTION",
      exitCode: 2,
    });
    await expect(runChat(["update"])).rejects.toMatchObject({ code: "NOTHING_TO_UPDATE", exitCode: 2 });

    delete process.env.FIRST_TREE_CHAT_ID;
    await expect(runChat(["update", "--topic", "Launch"])).rejects.toMatchObject({
      code: "NO_CHAT_CONTEXT",
      exitCode: 2,
    });
  });

  it("guards --description against literal \\n escapes on update and create, with a stdin escape hatch", async () => {
    const sdk = localAgentMocks.createSdk();

    // update: a one-line description whose newlines are literal `\n` escapes is
    // rejected before any write, with a copyable heredoc hint on stderr.
    await expect(
      runChat(["update", "--description", "line1\\n\\n**title**\\nline3", "--chat", "chat-1"]),
    ).rejects.toMatchObject({ code: "ESCAPED_NEWLINES", exitCode: 2 });
    expect(sdk.updateChat).not.toHaveBeenCalled();
    const updateHint = printLineMock.mock.calls.map((call) => String(call[0])).join("");
    expect(updateHint).toContain("chat update --description -");

    // Narrow by design: a single escaped `\n` in prose stays writable.
    await runChat(["update", "--description", "see `\\n` in the logs", "--chat", "chat-1"]);
    expect(sdk.updateChat).toHaveBeenLastCalledWith("chat-1", { description: "see `\\n` in the logs" });

    // `--description -` reads the description from stdin (real newlines) and
    // skips the guard — the escape hatch for an intentional literal `\n` body.
    ioMocks.readStdin.mockResolvedValueOnce("first line\n\n**second** line");
    await runChat(["update", "--description", "-", "--chat", "chat-1"]);
    expect(sdk.updateChat).toHaveBeenLastCalledWith("chat-1", { description: "first line\n\n**second** line" });

    // `--description -` with no piped stdin (TTY) is a usage error, not a write.
    ioMocks.readStdin.mockResolvedValueOnce(null);
    await expect(runChat(["update", "--description", "-", "--chat", "chat-1"])).rejects.toMatchObject({
      code: "NO_STDIN",
      exitCode: 2,
    });

    // The deprecated `set-topic` / `rename` alias is also a description write
    // entry point, so it inherits the same guard and `--description -` hatch.
    await expect(runChat(["set-topic", "--description", "x\\ny\\nz", "--chat", "chat-1"])).rejects.toMatchObject({
      code: "ESCAPED_NEWLINES",
      exitCode: 2,
    });
    await expect(runChat(["rename", "Launch", "--description", "x\\ny\\nz", "--chat", "chat-1"])).rejects.toMatchObject(
      { code: "ESCAPED_NEWLINES", exitCode: 2 },
    );
    ioMocks.readStdin.mockResolvedValueOnce("alpha\n\nbeta");
    await runChat(["set-topic", "--description", "-", "--chat", "chat-1"]);
    expect(sdk.updateChat).toHaveBeenLastCalledWith("chat-1", { description: "alpha\n\nbeta" });

    // create: the same inline guard fires before the chat is created; its hint
    // points at ANSI-C `$'...'` quoting (stdin is taken by the first message).
    printLineMock.mockClear();
    await expect(
      runChat(["create", "--to", "nova", "hello", "--description", "alpha\\nbeta\\ngamma"]),
    ).rejects.toMatchObject({ code: "ESCAPED_NEWLINES", exitCode: 2 });
    expect(sdk.createTaskChat).not.toHaveBeenCalled();
    const createHint = printLineMock.mock.calls.map((call) => String(call[0])).join("");
    expect(createHint).toContain("$'first line");
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

    await runChat(["open", "nova"]);

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
