import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Attention } from "@first-tree/shared";
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

const attentionMocks = vi.hoisted(() => ({
  AttentionRespondError: class AttentionRespondError extends Error {
    constructor(
      public readonly statusCode: number,
      message: string,
    ) {
      super(message);
      this.name = "AttentionRespondError";
    }
  },
  raiseAttention: vi.fn(),
  respondAttention: vi.fn(),
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
vi.mock("../core/attention/index.js", () => attentionMocks);
vi.mock("../cli/output.js", () => outputMocks);
vi.mock("../core/output.js", () => ({
  print: { line: printLineMock, result: outputMocks.success, fail: outputMocks.fail },
}));
vi.mock("node:readline", () => readlineMocks);

let tempDir = "";
const originalChatId = process.env.FIRST_TREE_CHAT_ID;
const originalExit = process.exit;
const originalSetInterval = globalThis.setInterval;
const originalClearInterval = globalThis.clearInterval;

function attention(overrides: Partial<Attention> = {}): Attention {
  return {
    id: overrides.id ?? "attention-1",
    originAgentId: overrides.originAgentId ?? "agent-1",
    originChatId: overrides.originChatId ?? "chat-1",
    targetHumanId: overrides.targetHumanId ?? "human-1",
    subject: overrides.subject ?? "Approve deploy",
    body: overrides.body ?? "Can I ship?",
    requiresResponse: overrides.requiresResponse ?? true,
    state: overrides.state ?? "open",
    response: overrides.response ?? null,
    respondedBy: overrides.respondedBy ?? null,
    respondedAt: overrides.respondedAt ?? null,
    cancelled: overrides.cancelled ?? false,
    cancelledReason: overrides.cancelledReason ?? null,
    metadata: overrides.metadata ?? {},
    createdAt: overrides.createdAt ?? "2026-06-01T00:00:00.000Z",
    closedAt: overrides.closedAt ?? null,
  };
}

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

async function runAttention(args: string[]): Promise<void> {
  const { registerAttentionCommands } = await import("../commands/attention/index.js");
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeErr: () => undefined, writeOut: () => undefined });
  registerAttentionCommands(program);
  await program.parseAsync(["node", "test", "attention", ...args]);
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "ft-cli-chat-attention-"));
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
  attentionMocks.raiseAttention.mockResolvedValue(attention());
  attentionMocks.respondAttention.mockResolvedValue(attention({ response: "done", state: "closed" }));
  process.exit = vi.fn(((code?: number) => {
    throw Object.assign(new Error("process.exit"), { code });
  }) as never);
});

afterEach(() => {
  rmSync(tempDir, { force: true, recursive: true });
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

describe("attention command behavior", () => {
  it("raises attention from literal, file, stdin, flat metadata, and JSON metadata", async () => {
    const bodyFile = join(tempDir, "body.md");
    const metaFile = join(tempDir, "meta.json");
    writeFileSync(bodyFile, "file body");
    writeFileSync(metaFile, JSON.stringify({ choices: [{ label: "Ship", value: "ship" }] }));

    await runAttention([
      "raise",
      "--chat",
      "chat-1",
      "--target",
      "human-1",
      "--subject",
      "Approve",
      "--body",
      `@${bodyFile}`,
      "--requires-response",
      "--meta",
      "priority=2",
      "--meta-json",
      `@${metaFile}`,
      "--agent",
      "kael",
    ]);

    expect(localAgentMocks.createSdk).toHaveBeenCalledWith("kael");
    expect(attentionMocks.raiseAttention).toHaveBeenCalledWith(localAgentMocks.createSdk(), {
      chatId: "chat-1",
      target: "human-1",
      subject: "Approve",
      body: "file body",
      requiresResponse: true,
      metadata: {
        priority: 2,
        choices: [{ label: "Ship", value: "ship" }],
      },
    });
    expect(outputMocks.success).toHaveBeenCalledWith(expect.objectContaining({ id: "attention-1" }));

    await runAttention(["raise", "--chat", "chat-1", "--target", "human-1", "--subject", "Literal", "--body", "plain"]);
    expect(attentionMocks.raiseAttention).toHaveBeenLastCalledWith(
      localAgentMocks.createSdk(),
      expect.objectContaining({ body: "plain", requiresResponse: false }),
    );

    ioMocks.readStdin.mockResolvedValueOnce("piped body");
    await runAttention(["raise", "--chat", "chat-1", "--target", "human-1", "--subject", "Pipe", "--body", "@-"]);
    expect(attentionMocks.raiseAttention).toHaveBeenLastCalledWith(
      localAgentMocks.createSdk(),
      expect.objectContaining({ body: "piped body" }),
    );

    ioMocks.readStdin.mockResolvedValueOnce(null);
    await expect(
      runAttention(["raise", "--chat", "chat-1", "--target", "human-1", "--subject", "Pipe", "--body", "@-"]),
    ).rejects.toMatchObject({ code: "BODY_READ_FAILED", exitCode: 2 });
  });

  it("responds with text or structured answers and maps validation and HTTP errors", async () => {
    await runAttention(["respond", "attention-1", "--text", "approved"]);
    expect(attentionMocks.respondAttention).toHaveBeenCalledWith({
      id: "attention-1",
      text: "approved",
      answers: undefined,
    });

    await runAttention(["respond", "attention-1", "--answer", "choice=ship", "--answer", "risk=low"]);
    expect(attentionMocks.respondAttention).toHaveBeenLastCalledWith({
      id: "attention-1",
      text: undefined,
      answers: { choice: "ship", risk: "low" },
    });

    await runAttention(["respond", "attention-1", "--text", "approved", "--answer", "ignored=yes"]);
    expect(printLineMock.mock.calls.map((call) => String(call[0])).join("")).toContain("--text wins");

    await expect(runAttention(["respond", "attention-1"])).rejects.toMatchObject({
      code: "UNKNOWN_ERROR",
      exitCode: 1,
    });
    await expect(runAttention(["respond", "attention-1", "--answer", "bad"])).rejects.toMatchObject({
      code: "UNKNOWN_ERROR",
      exitCode: 1,
    });

    attentionMocks.respondAttention.mockRejectedValueOnce(new attentionMocks.AttentionRespondError(401, "expired"));
    await expect(runAttention(["respond", "attention-1", "--text", "approved"])).rejects.toMatchObject({
      code: "HTTP_401",
      exitCode: 3,
    });

    attentionMocks.respondAttention.mockRejectedValueOnce(new Error("boom"));
    await expect(runAttention(["respond", "attention-1", "--text", "approved"])).rejects.toMatchObject({
      code: "UNKNOWN_ERROR",
      exitCode: 1,
    });
  });
});
