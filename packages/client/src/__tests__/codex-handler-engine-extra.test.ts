import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentHandler, HandlerConfig, SessionContext, SessionMessage } from "../runtime/handler.js";

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

type MockHandler = {
  start: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
  inject: ReturnType<typeof vi.fn>;
  suspend: ReturnType<typeof vi.fn>;
  shutdown: ReturnType<typeof vi.fn>;
};

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
    log: vi.fn(),
    agent: {
      agentId: "agent-1",
      inboxId: "inbox_agent-1",
      displayName: "Trial Agent",
      type: "agent",
      visibility: "organization",
      delegateMention: null,
      metadata,
    },
  } as unknown as SessionContext;
}

function makeMockHandler(overrides: Partial<MockHandler> = {}): MockHandler {
  return {
    start: vi.fn(async () => ({ providerSessionId: "started" })),
    resume: vi.fn(async () => ({ providerSessionId: "resumed" })),
    inject: vi.fn(async () => undefined),
    suspend: vi.fn(async () => undefined),
    shutdown: vi.fn(async () => undefined),
    ...overrides,
  };
}

function handlerConfig(overrides: Partial<HandlerConfig> = {}): HandlerConfig {
  return {
    workspaceRoot: "/tmp/first-tree-codex-handler-test",
    ...overrides,
  };
}

async function importWithMocks(options: { app?: Partial<MockHandler>; sdk?: Partial<MockHandler> } = {}): Promise<{
  createCodexHandler: (config: HandlerConfig) => AgentHandler;
  appHandler: MockHandler;
  sdkHandler: MockHandler;
  StartupError: new (stage: string, message: string) => Error & { stage: string };
}> {
  vi.resetModules();

  class StartupError extends Error {
    stage: string;

    constructor(stage: string, message: string) {
      super(message);
      this.name = "CodexAppServerStartupError";
      this.stage = stage;
    }
  }

  const appHandler = makeMockHandler(options.app);
  const sdkHandler = makeMockHandler(options.sdk);

  vi.doMock("../handlers/codex/app-server/index.js", () => ({
    CodexAppServerStartupError: StartupError,
    createCodexAppServerHandler: vi.fn(() => appHandler),
  }));
  vi.doMock("../handlers/codex/sdk.js", () => ({
    appendGitStatusDeltaRefs: vi.fn(),
    buildCodexAgentBriefing: vi.fn(),
    buildCodexThreadOptions: vi.fn(),
    collectCodexFileChangePaths: vi.fn(),
    computePerTurnUsageDelta: vi.fn(),
    createCodexSdkHandler: vi.fn(() => sdkHandler),
    isTransientCodexErrorMessage: vi.fn(),
    toolFileRefsForTerminalCodexTool: vi.fn(),
    toolFileRefsFromCodexFileChange: vi.fn(),
  }));

  const mod = await import("../handlers/codex/index.js");
  return { createCodexHandler: mod.createCodexHandler, appHandler, sdkHandler, StartupError };
}

describe("codex handler engine delegation branches", () => {
  afterEach(() => {
    vi.doUnmock("../handlers/codex/app-server/index.js");
    vi.doUnmock("../handlers/codex/sdk.js");
    vi.resetModules();
  });

  it("delegates all SDK-engine operations when workspace-only metadata is absent", async () => {
    const { createCodexHandler, sdkHandler } = await importWithMocks();
    const ctx = context();
    const handler = createCodexHandler(handlerConfig({ codexHandlerEngine: "sdk" }));

    await expect(handler.start(message(), ctx)).resolves.toEqual({ providerSessionId: "started" });
    await expect(handler.resume(message(), "session-1", ctx)).resolves.toEqual({ providerSessionId: "resumed" });
    await handler.inject(message());
    await handler.suspend();
    await handler.shutdown("done");

    expect(sdkHandler.start).toHaveBeenCalledWith(message(), ctx, undefined);
    expect(sdkHandler.resume).toHaveBeenCalledWith(message(), "session-1", ctx, undefined);
    expect(sdkHandler.inject).toHaveBeenCalledWith(message(), undefined);
    expect(sdkHandler.suspend).toHaveBeenCalledTimes(1);
    expect(sdkHandler.shutdown).toHaveBeenCalledWith("done");
  });

  it("falls back from app-server start and logs shutdown failures", async () => {
    const { createCodexHandler, appHandler, sdkHandler, StartupError } = await importWithMocks({
      app: {
        start: vi.fn(async () => {
          throw new StartupError("launch", "app server failed");
        }),
        shutdown: vi.fn(async () => {
          throw new Error("shutdown failed");
        }),
      },
    });
    const ctx = context();
    const handler = createCodexHandler(handlerConfig({ codexHandlerEngine: "auto" }));

    await expect(handler.start(message(), ctx)).resolves.toEqual({ providerSessionId: "started" });
    await handler.suspend();
    await handler.shutdown("fallback done");

    expect(appHandler.shutdown).toHaveBeenCalledWith();
    expect(ctx.log).toHaveBeenCalledWith(
      "codex app-server shutdown before fallback failed after launch: shutdown failed",
    );
    expect(ctx.log).toHaveBeenCalledWith("app server failed; falling back to @openai/codex-sdk handler");
    expect(sdkHandler.start).toHaveBeenCalledWith(message(), ctx, undefined);
    expect(sdkHandler.suspend).toHaveBeenCalledTimes(1);
    expect(sdkHandler.shutdown).toHaveBeenCalledWith("fallback done");
  });

  it("falls back from app-server resume and keeps app-server for workspace-only trials", async () => {
    const { createCodexHandler, sdkHandler, StartupError } = await importWithMocks({
      app: {
        resume: vi.fn(async () => {
          throw new StartupError("connect", "resume failed");
        }),
      },
    });

    const handler = createCodexHandler(handlerConfig({ codexHandlerEngine: "auto" }));
    await expect(handler.resume(message(), "session-1", context())).resolves.toEqual({ providerSessionId: "resumed" });
    expect(sdkHandler.resume).toHaveBeenCalledWith(message(), "session-1", expect.any(Object), undefined);

    const trialHandler = createCodexHandler(handlerConfig({ codexHandlerEngine: "auto" }));
    await expect(trialHandler.resume(message(), "session-2", context(trialMetadata))).rejects.toThrow("resume failed");
  });

  it("uses production auto mode when no explicit engine or test env fallback is present", async () => {
    const previousEngine = process.env.FIRST_TREE_CODEX_HANDLER_ENGINE;
    const previousVitest = process.env.VITEST;
    const previousNodeEnv = process.env.NODE_ENV;
    delete process.env.FIRST_TREE_CODEX_HANDLER_ENGINE;
    delete process.env.VITEST;
    delete process.env.NODE_ENV;
    const { createCodexHandler, appHandler } = await importWithMocks();

    try {
      const handler = createCodexHandler(handlerConfig());
      await handler.inject(message());
      expect(appHandler.inject).toHaveBeenCalledWith(message(), undefined);
    } finally {
      if (previousEngine === undefined) delete process.env.FIRST_TREE_CODEX_HANDLER_ENGINE;
      else process.env.FIRST_TREE_CODEX_HANDLER_ENGINE = previousEngine;
      if (previousVitest === undefined) delete process.env.VITEST;
      else process.env.VITEST = previousVitest;
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    }
  });
});
