import { EventEmitter } from "node:events";

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
vi.mock("../commands/chat/_shared/io.js", () => ioMocks);
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
  resolveAgentMock.mockResolvedValue({ uuid: "agent-1", name: "kael", displayName: "Kael" });
  docCaptureMock.captureOutboundDocs.mockImplementation(async (content: string) => ({ content }));
  ioMocks.readStdin.mockResolvedValue("stdin message");
  localAgentMocks.createSdk.mockReturnValue({
    agentId: "agent-self",
    attention: { raise: vi.fn() },
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
