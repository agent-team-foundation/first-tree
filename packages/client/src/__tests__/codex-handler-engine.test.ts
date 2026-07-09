import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexAppServerStartupError } from "../handlers/codex/app-server/index.js";
import { createCodexHandler } from "../handlers/codex/index.js";
import type { DeliveryToken, SessionContext, SessionMessage } from "../runtime/handler.js";

const trialMetadata = {
  landingCampaignTrial: true,
  campaign: "production-scan",
  skillSetId: "production-scan",
  skillSetVersion: "2026.07.02.1",
  repo: {
    url: "https://github.com/acme/backend",
    canonicalKey: "github.com/acme/backend",
  },
};

const appServerHandlers: Array<Record<string, ReturnType<typeof vi.fn>>> = [];
const sdkHandlers: Array<Record<string, ReturnType<typeof vi.fn>>> = [];

vi.mock("../handlers/codex/app-server/index.js", async () => {
  const actual = await vi.importActual<typeof import("../handlers/codex/app-server/index.js")>(
    "../handlers/codex/app-server/index.js",
  );
  return {
    ...actual,
    createCodexAppServerHandler: vi.fn(() => {
      const handler = {
        start: vi.fn(async () => undefined),
        resume: vi.fn(async () => undefined),
        inject: vi.fn(async () => undefined),
        suspend: vi.fn(async () => undefined),
        shutdown: vi.fn(async () => undefined),
      };
      appServerHandlers.push(handler);
      return handler;
    }),
  };
});

vi.mock("../handlers/codex/sdk.js", async () => {
  const actual = await vi.importActual<typeof import("../handlers/codex/sdk.js")>("../handlers/codex/sdk.js");
  return {
    ...actual,
    createCodexSdkHandler: vi.fn(() => {
      const handler = {
        start: vi.fn(async () => undefined),
        resume: vi.fn(async () => undefined),
        inject: vi.fn(async () => undefined),
        suspend: vi.fn(async () => undefined),
        shutdown: vi.fn(async () => undefined),
      };
      sdkHandlers.push(handler);
      return handler;
    }),
  };
});

function message(): SessionMessage {
  return {
    id: "m1",
    chatId: "chat-1",
    senderId: "human-1",
    format: "text",
    content: "start",
    metadata: {},
  };
}

function context(metadata: Record<string, unknown> = {}): SessionContext {
  return {
    agent: {
      agentId: "agent-1",
      inboxId: "inbox_agent-1",
      displayName: "Trial Agent",
      type: "agent",
      visibility: "organization",
      delegateMention: null,
      metadata,
    },
    log: vi.fn(),
  } as unknown as SessionContext;
}

const token = {} as DeliveryToken;

describe("codex handler engine selection", () => {
  afterEach(() => {
    appServerHandlers.length = 0;
    sdkHandlers.length = 0;
    vi.clearAllMocks();
    delete process.env.FIRST_TREE_CODEX_HANDLER_ENGINE;
  });

  it("fails closed instead of running landing campaign trials on the SDK engine", async () => {
    const handler = createCodexHandler({
      workspaceRoot: "/tmp/first-tree-codex-test",
      runtimeProvider: "codex",
      codexHandlerEngine: "sdk",
    });

    expect(() => handler.start(message(), context(trialMetadata), token)).toThrow(
      /require the app-server workspace-only runtime/,
    );
    expect(() => handler.resume(message(), "sess-1", context(trialMetadata), token)).toThrow(
      /require the app-server workspace-only runtime/,
    );
  });

  it("uses the sdk engine wrapper for non-trial agents", async () => {
    const handler = createCodexHandler({
      workspaceRoot: "/tmp/first-tree-codex-test",
      runtimeProvider: "codex",
      codexHandlerEngine: "sdk",
    });
    const ctx = context({});
    await handler.start(message(), ctx, token);
    await handler.resume(message(), "sess-1", ctx, token);
    await handler.inject?.(message(), token);
    await handler.suspend?.();
    await handler.shutdown?.("done");

    expect(sdkHandlers).toHaveLength(1);
    expect(sdkHandlers[0]?.start).toHaveBeenCalledOnce();
    expect(sdkHandlers[0]?.resume).toHaveBeenCalledOnce();
    expect(sdkHandlers[0]?.inject).toHaveBeenCalledOnce();
    expect(sdkHandlers[0]?.suspend).toHaveBeenCalledOnce();
    expect(sdkHandlers[0]?.shutdown).toHaveBeenCalledWith("done");
  });

  it("uses app-server engine when configured", async () => {
    const handler = createCodexHandler({
      workspaceRoot: "/tmp/first-tree-codex-test",
      runtimeProvider: "codex",
      codexHandlerEngine: "app-server",
    });
    expect(appServerHandlers).toHaveLength(1);
    await handler.start(message(), context({}), token);
    expect(appServerHandlers[0]?.start).toHaveBeenCalledOnce();
  });

  it("auto-falls back from app-server startup failures to the sdk handler", async () => {
    const handler = createCodexHandler({
      workspaceRoot: "/tmp/first-tree-codex-test",
      runtimeProvider: "codex",
      codexHandlerEngine: "auto",
    });
    const app = appServerHandlers[0];
    if (!app) throw new Error("missing app-server handler");
    app.start.mockRejectedValueOnce(new CodexAppServerStartupError("boot", "spawn failed"));
    const ctx = context({});
    await handler.start(message(), ctx, token);

    expect(app.shutdown).toHaveBeenCalledOnce();
    expect(sdkHandlers).toHaveLength(1);
    expect(sdkHandlers[0]?.start).toHaveBeenCalledOnce();
    expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining("falling back to @openai/codex-sdk handler"));

    // Already on fallback — non-startup errors rethrow without another switch.
    app.start.mockClear();
    sdkHandlers[0]?.start.mockRejectedValueOnce(new Error("sdk boom"));
    await expect(handler.start(message(), ctx, token)).rejects.toThrow("sdk boom");
  });

  it("auto-falls back on resume startup failures and logs shutdown errors", async () => {
    const handler = createCodexHandler({
      workspaceRoot: "/tmp/first-tree-codex-test",
      runtimeProvider: "codex",
      codexHandlerEngine: "auto",
    });
    const app = appServerHandlers[0];
    if (!app) throw new Error("missing app-server handler");
    app.resume.mockRejectedValueOnce(new CodexAppServerStartupError("resume", "no thread"));
    app.shutdown.mockRejectedValueOnce(new Error("shutdown failed"));
    const ctx = context({});
    await handler.resume(message(), "sess-1", ctx, token);

    expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining("shutdown before fallback failed"));
    expect(sdkHandlers[0]?.resume).toHaveBeenCalledOnce();

    await handler.inject?.(message(), token);
    await handler.suspend?.();
    await handler.shutdown?.();
    expect(sdkHandlers[0]?.inject).toHaveBeenCalledOnce();
    expect(sdkHandlers[0]?.suspend).toHaveBeenCalledOnce();
    expect(sdkHandlers[0]?.shutdown).toHaveBeenCalledOnce();
  });

  it("does not fall back for landing campaign trials on auto engine", async () => {
    const handler = createCodexHandler({
      workspaceRoot: "/tmp/first-tree-codex-test",
      runtimeProvider: "codex",
      codexHandlerEngine: "auto",
    });
    const app = appServerHandlers[0];
    if (!app) throw new Error("missing app-server handler");
    const err = new CodexAppServerStartupError("boot", "spawn failed");
    app.start.mockRejectedValueOnce(err);
    await expect(handler.start(message(), context(trialMetadata), token)).rejects.toBe(err);
    expect(sdkHandlers).toHaveLength(0);
  });

  it("rethrows non-startup errors without fallback", async () => {
    const handler = createCodexHandler({
      workspaceRoot: "/tmp/first-tree-codex-test",
      runtimeProvider: "codex",
      codexHandlerEngine: "auto",
    });
    const app = appServerHandlers[0];
    if (!app) throw new Error("missing app-server handler");
    app.start.mockRejectedValueOnce(new Error("turn failed"));
    await expect(handler.start(message(), context({}), token)).rejects.toThrow("turn failed");
    expect(sdkHandlers).toHaveLength(0);
  });

  it("reads engine from env and defaults invalid values in test to sdk", () => {
    process.env.FIRST_TREE_CODEX_HANDLER_ENGINE = "sdk";
    createCodexHandler({ workspaceRoot: "/tmp/x", runtimeProvider: "codex" });
    expect(sdkHandlers.length).toBeGreaterThan(0);

    sdkHandlers.length = 0;
    appServerHandlers.length = 0;
    process.env.FIRST_TREE_CODEX_HANDLER_ENGINE = "not-a-real-engine";
    createCodexHandler({ workspaceRoot: "/tmp/x", runtimeProvider: "codex" });
    // vitest sets VITEST, so invalid env falls back to sdk in tests
    expect(sdkHandlers.length).toBeGreaterThan(0);
  });
});
