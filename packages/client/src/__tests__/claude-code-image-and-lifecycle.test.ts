import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const capturedInputs: unknown[] = [];
let streamEvents: unknown[] = [];
let queryClose = vi.fn();

vi.mock("@anthropic-ai/claude-agent-sdk", () => {
  return {
    query: (args: { prompt?: AsyncIterable<unknown> }) => {
      const fakeQuery = {
        [Symbol.asyncIterator]() {
          let i = 0;
          return {
            next: async () => {
              // Drain prompt iterable if present
              if (args.prompt && Symbol.asyncIterator in Object(args.prompt)) {
                try {
                  for await (const msg of args.prompt as AsyncIterable<unknown>) {
                    capturedInputs.push(msg);
                  }
                } catch {
                  // controller may end
                }
              }
              if (i < streamEvents.length) {
                const value = streamEvents[i++];
                return { done: false, value };
              }
              return { done: true, value: undefined };
            },
          };
        },
        close: () => queryClose(),
        setModel: async () => {},
      };
      return fakeQuery;
    },
  };
});

vi.mock("../runtime/chat-context.js", () => ({
  fetchChatContext: vi.fn(async () => ({
    chatId: "chat-img",
    title: "img",
    topic: null,
    description: null,
    participants: [],
  })),
}));

import { createClaudeCodeHandler } from "../handlers/claude-code.js";
import type { DeliveryToken, SessionContext, SessionMessage } from "../runtime/handler.js";
import { imagePath } from "../runtime/image-store.js";
import { mockCtxPlumbing } from "./test-helpers.js";

const AGENT_ID = "019d9a97-90b0-716b-8317-a8c0be8430d7";
let workspaceRoot: string;

function makeCtx(overrides: Partial<SessionContext> = {}): SessionContext {
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  return {
    agent: {
      agentId: AGENT_ID,
      inboxId: "inbox-test",
      displayName: "test",
      type: "agent",
      visibility: "organization",
      delegateMention: null,
      metadata: {},
    },
    sdk: { serverUrl: "http://test", sendMessage } as unknown as SessionContext["sdk"],
    chatId: "chat-img",
    log: vi.fn(),
    recordProviderActivity: () => {},
    emitEvent: vi.fn(),
    ...mockCtxPlumbing({ sendMessage }, "chat-img"),
    ...overrides,
  };
}

function token(): DeliveryToken {
  return {
    processingStarted: vi.fn(),
    complete: vi.fn().mockResolvedValue(undefined),
    retry: vi.fn(),
    terminalRejected: vi.fn().mockResolvedValue(undefined),
  };
}

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "ft-claude-img-"));
  capturedInputs.length = 0;
  streamEvents = [
    {
      type: "result",
      subtype: "success",
      result: "ok",
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  ];
  queryClose = vi.fn();
});

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});

describe("claude-code image message paths", () => {
  it("materializes imageRef, image batch, missing images, and legacy inline images", async () => {
    const handler = createClaudeCodeHandler({
      workspaceRoot,
      runtimeProvider: "claude-code",
    });
    const ctx = makeCtx();
    const imageId = "019e71c9-88d2-70be-be67-fdb033b2ef0b";
    const path = imagePath("chat-img", imageId, "image/png");
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, Buffer.from([137, 80, 78, 71]));

    // Single imageRef present on disk
    await handler.start(
      {
        id: "m1",
        chatId: "chat-img",
        senderId: "u1",
        format: "file",
        content: {
          imageId,
          mimeType: "image/png",
          filename: "shot.png",
          size: 4,
        },
        metadata: {},
      } as SessionMessage,
      ctx,
      token(),
    );
    await new Promise((r) => setTimeout(r, 30));
    await handler.shutdown?.();

    // Missing imageRef
    streamEvents = [
      {
        type: "result",
        subtype: "success",
        result: "ok2",
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    ];
    const handler2 = createClaudeCodeHandler({
      workspaceRoot,
      runtimeProvider: "claude-code",
    });
    await handler2.start(
      {
        id: "m2",
        chatId: "chat-img",
        senderId: "u1",
        format: "file",
        content: {
          imageId: "00000000-0000-0000-0000-000000000099",
          mimeType: "image/png",
          filename: "missing.png",
          size: 1,
        },
        metadata: {},
      } as SessionMessage,
      makeCtx(),
      token(),
    );
    await new Promise((r) => setTimeout(r, 30));
    await handler2.shutdown?.();

    // Batch with one present + one missing
    streamEvents = [
      {
        type: "result",
        subtype: "success",
        result: "ok3",
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    ];
    const handler3 = createClaudeCodeHandler({
      workspaceRoot,
      runtimeProvider: "claude-code",
    });
    await handler3.start(
      {
        id: "m3",
        chatId: "chat-img",
        senderId: "u1",
        format: "file",
        content: {
          caption: "look",
          attachments: [
            { imageId, mimeType: "image/png", filename: "a.png", size: 4 },
            {
              imageId: "00000000-0000-0000-0000-000000000098",
              mimeType: "image/jpeg",
              filename: "b.jpg",
              size: 1,
            },
          ],
        },
        metadata: {},
      } as SessionMessage,
      makeCtx(),
      token(),
    );
    await new Promise((r) => setTimeout(r, 30));
    await handler3.shutdown?.();

    // Legacy inline base64
    streamEvents = [
      {
        type: "result",
        subtype: "success",
        result: "ok4",
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    ];
    const handler4 = createClaudeCodeHandler({
      workspaceRoot,
      runtimeProvider: "claude-code",
    });
    await handler4.start(
      {
        id: "m4",
        chatId: "chat-img",
        senderId: "u1",
        format: "file",
        content: {
          data: Buffer.from([1, 2, 3]).toString("base64"),
          mimeType: "image/png",
          filename: "legacy.png",
          size: 3,
        },
        metadata: {},
      } as SessionMessage,
      makeCtx(),
      token(),
    );
    await new Promise((r) => setTimeout(r, 30));

    // inject while active should queue
    const injectResult = handler4.inject?.(
      {
        id: "m5",
        chatId: "chat-img",
        senderId: "u1",
        format: "text",
        content: "late",
        metadata: {},
      },
      token(),
    );
    expect(injectResult).toMatchObject({ kind: "owned", mode: "queued" });
    await handler4.shutdown?.();
  });

  it("rejects inject when no session has started", () => {
    const handler = createClaudeCodeHandler({
      workspaceRoot,
      runtimeProvider: "claude-code",
    });
    const result = handler.inject?.(
      {
        id: "m0",
        chatId: "chat-img",
        senderId: "u1",
        format: "text",
        content: "no session",
        metadata: {},
      },
      token(),
    );
    expect(result).toMatchObject({ kind: "rejected", reason: "no_active_session", retryable: true });
  });

  it("resume without transcript mints a fresh session", async () => {
    const handler = createClaudeCodeHandler({
      workspaceRoot,
      runtimeProvider: "claude-code",
    });
    streamEvents = [
      {
        type: "result",
        subtype: "success",
        result: "fresh",
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    ];
    const ctx = makeCtx();
    const result = await handler.resume(
      {
        id: "m1",
        chatId: "chat-img",
        senderId: "u1",
        format: "text",
        content: "resume missing",
        metadata: {},
      },
      "00000000-0000-4000-8000-000000000001",
      ctx,
      token(),
    );
    // With explicit token, result is an object with sessionId
    if (typeof result === "object" && result && "sessionId" in result) {
      expect(result.sessionId).not.toBe("00000000-0000-4000-8000-000000000001");
    } else {
      expect(typeof result).toBe("string");
      expect(result).not.toBe("00000000-0000-4000-8000-000000000001");
    }
    await handler.shutdown?.();
  });

  it("suspend retries buffered messages and clears controllers", async () => {
    const handler = createClaudeCodeHandler({
      workspaceRoot,
      runtimeProvider: "claude-code",
    });
    // Hang the stream so suspend can tear it down mid-turn
    streamEvents = [];
    const startPromise = handler.start(
      {
        id: "m1",
        chatId: "chat-img",
        senderId: "u1",
        format: "text",
        content: "hang",
        metadata: {},
      },
      makeCtx(),
      token(),
    );
    await new Promise((r) => setTimeout(r, 20));
    await handler.suspend?.("test_suspend");
    await startPromise.catch(() => {});
    await handler.shutdown?.("test_shutdown");
  });
});
