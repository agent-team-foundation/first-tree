import { afterEach, describe, expect, it, vi } from "vitest";

type SentryMock = {
  init: ReturnType<typeof vi.fn>;
  setTag: ReturnType<typeof vi.fn>;
  isEnabled: ReturnType<typeof vi.fn<() => boolean>>;
  withScope: ReturnType<typeof vi.fn>;
  captureException: ReturnType<typeof vi.fn>;
  flush: ReturnType<typeof vi.fn>;
};

type MockScope = { setContext: ReturnType<typeof vi.fn> };

const ORIGINAL_ENV = { ...process.env };

function installSentryMocks(options: { enabled?: boolean; flushResult?: boolean } = {}): {
  logger: { info: ReturnType<typeof vi.fn> };
  scope: MockScope;
  sentry: SentryMock;
} {
  const logger = { info: vi.fn() };
  const scope: MockScope = { setContext: vi.fn() };
  const sentry: SentryMock = {
    init: vi.fn(),
    setTag: vi.fn(),
    isEnabled: vi.fn(() => options.enabled ?? false),
    withScope: vi.fn((callback: (scopeArg: MockScope) => string | undefined) => callback(scope)),
    captureException: vi.fn(() => "event-id"),
    flush: vi.fn(async () => options.flushResult ?? true),
  };

  vi.doMock("@sentry/node", () => sentry);
  vi.doMock("../logger.js", () => ({ createLogger: () => logger }));
  vi.doMock("@first-tree/shared/config", () => ({
    defaultDataDir: () => "/var/first-tree",
    defaultHome: () => "/home/first-tree",
  }));
  return { logger, scope, sentry };
}

describe("initClientSentry", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.doUnmock("@sentry/node");
    vi.doUnmock("../logger.js");
    vi.doUnmock("@first-tree/shared/config");
    vi.resetModules();
  });

  it("logs a configuration skip when Sentry is explicitly enabled without a DSN", async () => {
    process.env = { ...ORIGINAL_ENV, FIRST_TREE_CLIENT_SENTRY_ENABLED: "1" };
    delete process.env.FIRST_TREE_CLIENT_SENTRY_DSN;
    delete process.env.SENTRY_DSN;
    const { logger, sentry } = installSentryMocks();
    const { initClientSentry } = await import("../sentry.js");

    initClientSentry();

    expect(sentry.init).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      { enabled: true, hasDsn: false },
      "client sentry skipped by configuration",
    );
  });

  it("initializes Sentry with sanitized event hooks and release tags", async () => {
    process.env = {
      ...ORIGINAL_ENV,
      FIRST_TREE_CLIENT_SENTRY_DSN: "https://public@example.ingest.sentry.io/1",
      FIRST_TREE_CLIENT_SENTRY_ENVIRONMENT: "production",
      FIRST_TREE_CLIENT_SENTRY_TRACES_SAMPLE_RATE: "0.25",
    };
    const { logger, sentry } = installSentryMocks();
    const { initClientSentry } = await import("../sentry.js");

    initClientSentry({ gitSha: "abc123", version: "1.2.3" });

    expect(sentry.init).toHaveBeenCalledTimes(1);
    const config = sentry.init.mock.calls[0]?.[0];
    expect(config).toMatchObject({
      dsn: "https://public@example.ingest.sentry.io/1",
      environment: "production",
      release: "first-tree-client@abc123",
      tracesSampleRate: 0.25,
      sendDefaultPii: false,
      maxBreadcrumbs: 0,
    });
    expect(config.beforeSend({ transaction: "/home/first-tree/work?token=secret" })).toMatchObject({
      transaction: "[LOCAL_PATH]/work?token=[REDACTED]",
      tags: {
        "first_tree.surface": "client",
        "first_tree.git_sha": "abc123",
      },
    });
    expect(config.beforeSendTransaction({ request: { url: "not a url?secret=1" } }).request.url).toBe("not a url");
    expect(sentry.setTag).toHaveBeenCalledWith("first_tree.surface", "client");
    expect(sentry.setTag).toHaveBeenCalledWith("first_tree.git_sha", "abc123");
    expect(sentry.setTag).toHaveBeenCalledWith("first_tree.cli_version", "1.2.3");
    expect(logger.info).toHaveBeenCalledWith(
      { environment: "production", release: "first-tree-client@abc123" },
      "client sentry initialized",
    );
  });
});

describe("captureClientException / flushClientSentry", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.doUnmock("@sentry/node");
    vi.doUnmock("../logger.js");
    vi.doUnmock("@first-tree/shared/config");
    vi.resetModules();
  });

  it("does not capture when Sentry is disabled and treats disabled flush as successful", async () => {
    const { sentry } = installSentryMocks({ enabled: false });
    const { captureClientException, flushClientSentry } = await import("../sentry.js");

    expect(captureClientException(new Error("boom"))).toBeUndefined();
    await expect(flushClientSentry()).resolves.toBe(true);
    expect(sentry.withScope).not.toHaveBeenCalled();
    expect(sentry.flush).not.toHaveBeenCalled();
  });

  it("captures with sanitized context and forwards flush timeouts when enabled", async () => {
    const { scope, sentry } = installSentryMocks({ enabled: true, flushResult: false });
    const { captureClientException, flushClientSentry } = await import("../sentry.js");

    expect(
      captureClientException(new Error("boom"), {
        accessToken: "secret",
        path: "/var/first-tree/workspaces/acme",
        nested: { prompt: "private prompt", status: "safe" },
      }),
    ).toBe("event-id");
    await expect(flushClientSentry(50)).resolves.toBe(false);

    const callbackScope = sentry.withScope.mock.calls[0]?.[0];
    expect(typeof callbackScope).toBe("function");
    expect(scope.setContext).toHaveBeenCalledWith("first_tree", {
      accessToken: "[REDACTED]",
      path: "[LOCAL_PATH]/workspaces/acme",
      nested: { prompt: "[REDACTED]", status: "safe" },
    });
    expect(sentry.captureException).toHaveBeenCalledWith(expect.any(Error));
    expect(sentry.flush).toHaveBeenCalledWith(50);
  });

  it("captures without context when none is provided", async () => {
    const { sentry } = installSentryMocks({ enabled: true });
    const { captureClientException } = await import("../sentry.js");

    expect(captureClientException("string failure")).toBe("event-id");

    expect(sentry.captureException).toHaveBeenCalledWith("string failure");
  });
});
