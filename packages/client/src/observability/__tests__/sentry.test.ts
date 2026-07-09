import type { Event } from "@sentry/node";
import { afterEach, describe, expect, it, vi } from "vitest";

const sentryMocks = vi.hoisted(() => ({
  init: vi.fn(),
  setTag: vi.fn(),
  isEnabled: vi.fn(() => false),
  withScope: vi.fn((cb: (scope: { setContext: ReturnType<typeof vi.fn> }) => unknown) =>
    cb({ setContext: vi.fn() }),
  ),
  captureException: vi.fn(() => "event-id"),
  flush: vi.fn(async () => true),
}));

vi.mock("@sentry/node", () => ({
  init: sentryMocks.init,
  setTag: sentryMocks.setTag,
  isEnabled: sentryMocks.isEnabled,
  withScope: sentryMocks.withScope,
  captureException: sentryMocks.captureException,
  flush: sentryMocks.flush,
}));

import {
  captureClientException,
  flushClientSentry,
  initClientSentry,
  resolveClientSentryConfig,
  sanitizeClientSentryEvent,
} from "../sentry.js";

describe("resolveClientSentryConfig", () => {
  it("defaults to enabled when a client DSN is configured", () => {
    const config = resolveClientSentryConfig({
      FIRST_TREE_CLIENT_SENTRY_DSN: "https://public@example.ingest.sentry.io/1",
      FIRST_TREE_GIT_SHA: "abc123",
    });

    expect(config.enabled).toBe(true);
    expect(config.release).toBe("first-tree-client@abc123");
    expect(config.gitSha).toBe("abc123");
  });

  it("honors the explicit client disable switch", () => {
    const config = resolveClientSentryConfig({
      FIRST_TREE_CLIENT_SENTRY_DSN: "https://public@example.ingest.sentry.io/1",
      FIRST_TREE_CLIENT_SENTRY_ENABLED: "off",
      FIRST_TREE_GIT_SHA: "abc123",
    });

    expect(config.enabled).toBe(false);
  });

  it("uses the release-baked DSN when operator env does not override it", () => {
    const config = resolveClientSentryConfig(
      {
        FIRST_TREE_GIT_SHA: "abc123",
      },
      { defaultDsn: "https://public@example.ingest.sentry.io/2" },
    );

    expect(config.enabled).toBe(true);
    expect(config.dsn).toBe("https://public@example.ingest.sentry.io/2");
  });
});

describe("sanitizeClientSentryEvent", () => {
  it("redacts tokens, local paths, request bodies, and user context", () => {
    const home = process.env.HOME ?? "";
    const rawEvent: Event = {
      user: { id: "user_123", email: "person@example.com" },
      request: {
        url: `file://${home}/workspace/project?token=secret#hash`,
        headers: { authorization: "Bearer secret", accept: "application/json" },
        cookies: { session: "secret" },
        query_string: "token=secret",
        data: { prompt: "do not send" },
      },
      extra: {
        workspacePath: `${home}/workspace/project`,
        bearer: "Bearer secret-token",
        nested: { refreshToken: "secret", output: "model text", status: "safe metadata" },
      },
      breadcrumbs: [{ message: "stdout: secret output" }],
      transaction: `${home}/workspace/project/src/index.ts`,
    };
    const event = sanitizeClientSentryEvent(rawEvent, {
      enabled: true,
      dsn: "https://public@example.ingest.sentry.io/1",
      environment: "production",
      release: "first-tree-client@abc123",
      gitSha: "abc123",
      sampleRate: 0.05,
    });

    expect(event.user).toBeUndefined();
    expect(event.request?.url).not.toContain(home);
    expect(event.request?.url).not.toContain("token=");
    expect(event.request?.url).not.toContain("#hash");
    expect(event.request?.headers).toEqual({
      authorization: "[REDACTED]",
      accept: "application/json",
    });
    expect(event.request?.cookies).toBeUndefined();
    expect(event.request?.data).toBeUndefined();
    expect(event.extra?.workspacePath).toBe("[LOCAL_PATH]/workspace/project");
    expect(event.extra?.bearer).toBe("Bearer [REDACTED]");
    expect(event.extra?.nested).toEqual({
      refreshToken: "[REDACTED]",
      output: "[REDACTED]",
      status: "safe metadata",
    });
    expect(event.breadcrumbs).toBeUndefined();
    expect(event.transaction).toBe("[LOCAL_PATH]/workspace/project/src/index.ts");
    expect(event.tags).toMatchObject({
      "first_tree.surface": "client",
      "first_tree.git_sha": "abc123",
    });
  });

  it("redacts FIRST_TREE_HOME runtime paths outside the OS home and cwd", () => {
    const previousHome = process.env.FIRST_TREE_HOME;
    process.env.FIRST_TREE_HOME = "/mnt/ft";
    try {
      const rawEvent: Event = {
        extra: {
          workspacePath: "/mnt/ft/data/workspaces/acme/repo",
          sessionPath: "/mnt/ft/data/sessions/acme.json",
        },
        exception: {
          values: [
            {
              type: "Error",
              value: "failed opening /mnt/ft/data/workspaces/acme/repo/package.json",
            },
          ],
        },
        transaction: "/mnt/ft/data/workspaces/acme/repo/src/index.ts",
      };
      const event = sanitizeClientSentryEvent(rawEvent, {
        enabled: true,
        dsn: "https://public@example.ingest.sentry.io/1",
        environment: "production",
        release: "first-tree-client@abc123",
        gitSha: "abc123",
        sampleRate: 0.05,
      });

      expect(event.extra?.workspacePath).toBe("[LOCAL_PATH]/data/workspaces/acme/repo");
      expect(event.extra?.sessionPath).toBe("[LOCAL_PATH]/data/sessions/acme.json");
      expect(event.exception?.values?.[0]?.value).toBe(
        "failed opening [LOCAL_PATH]/data/workspaces/acme/repo/package.json",
      );
      expect(event.transaction).toBe("[LOCAL_PATH]/data/workspaces/acme/repo/src/index.ts");
    } finally {
      if (previousHome === undefined) {
        delete process.env.FIRST_TREE_HOME;
      } else {
        process.env.FIRST_TREE_HOME = previousHome;
      }
    }
  });

  it("strips URL suffixes from fallback URL parsing without regular expression backtracking", () => {
    const rawEvent: Event = {
      request: {
        url: `${"#".repeat(10_000)}?token=secret`,
      },
    };
    const event = sanitizeClientSentryEvent(rawEvent, {
      enabled: true,
      dsn: "https://public@example.ingest.sentry.io/1",
      environment: "production",
      release: "first-tree-client@abc123",
      gitSha: "abc123",
      sampleRate: 0.05,
    });

    expect(event.request?.url).toBe("");
  });

  it("ignores empty and short path redaction roots", () => {
    const event = sanitizeClientSentryEvent(
      {
        transaction: "/x",
        extra: { path: "/" },
      },
      {
        enabled: true,
        dsn: "https://public@example.ingest.sentry.io/1",
        environment: "production",
        release: "first-tree-client@abc123",
        gitSha: "abc123",
        sampleRate: 0.05,
      },
    );
    expect(event.transaction).toBe("/x");
  });
});

describe("resolveClientSentryConfig edge branches", () => {
  it("falls back sample rate and git sha sources", () => {
    expect(
      resolveClientSentryConfig({
        FIRST_TREE_CLIENT_SENTRY_DSN: "https://public@example.ingest.sentry.io/1",
        FIRST_TREE_CLIENT_SENTRY_TRACES_SAMPLE_RATE: "not-a-number",
      }).sampleRate,
    ).toBe(0.05);
    expect(
      resolveClientSentryConfig({
        FIRST_TREE_CLIENT_SENTRY_DSN: "https://public@example.ingest.sentry.io/1",
        FIRST_TREE_CLIENT_SENTRY_TRACES_SAMPLE_RATE: "2",
      }).sampleRate,
    ).toBe(0.05);
    expect(
      resolveClientSentryConfig({
        FIRST_TREE_CLIENT_SENTRY_DSN: "https://public@example.ingest.sentry.io/1",
        FIRST_TREE_CLIENT_SENTRY_TRACES_SAMPLE_RATE: "0.25",
        FIRST_TREE_CLIENT_GIT_SHA: "client-sha",
      }).gitSha,
    ).toBe("client-sha");
    expect(
      resolveClientSentryConfig({
        FIRST_TREE_CLIENT_SENTRY_DSN: "https://public@example.ingest.sentry.io/1",
        GITHUB_SHA: "github-sha",
      }).gitSha,
    ).toBe("github-sha");
    expect(resolveClientSentryConfig({}).release).toBe("first-tree-client@unknown");
    expect(
      resolveClientSentryConfig({
        FIRST_TREE_CLIENT_SENTRY_DSN: "https://public@example.ingest.sentry.io/1",
        FIRST_TREE_CLIENT_SENTRY_ENABLED: "yes",
        FIRST_TREE_CLIENT_SENTRY_ENVIRONMENT: "staging",
        FIRST_TREE_CLIENT_SENTRY_RELEASE: "custom-release",
        FIRST_TREE_GIT_SHA: "abc",
      }),
    ).toMatchObject({
      enabled: true,
      environment: "staging",
      release: "custom-release",
    });
  });
});

describe("initClientSentry / captureClientException / flushClientSentry", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.clearAllMocks();
    sentryMocks.isEnabled.mockReturnValue(false);
  });

  it("skips init when disabled and logs configuration skip when explicit flag set", () => {
    process.env.FIRST_TREE_CLIENT_SENTRY_ENABLED = "off";
    process.env.FIRST_TREE_CLIENT_SENTRY_DSN = "https://public@example.ingest.sentry.io/1";
    initClientSentry();
    expect(sentryMocks.init).not.toHaveBeenCalled();
  });

  it("skips init when no DSN is available", () => {
    delete process.env.FIRST_TREE_CLIENT_SENTRY_DSN;
    delete process.env.SENTRY_DSN;
    initClientSentry({ defaultDsn: undefined });
    expect(sentryMocks.init).not.toHaveBeenCalled();
  });

  it("initializes Sentry with sanitizing beforeSend hooks and optional version tag", () => {
    process.env.FIRST_TREE_CLIENT_SENTRY_DSN = "https://public@example.ingest.sentry.io/9";
    process.env.FIRST_TREE_GIT_SHA = "deadbeef";
    process.env.FIRST_TREE_CLIENT_SENTRY_ENVIRONMENT = "test";
    delete process.env.FIRST_TREE_CLIENT_SENTRY_ENABLED;

    initClientSentry({ version: "1.2.3", gitSha: "deadbeef" });

    expect(sentryMocks.init).toHaveBeenCalledOnce();
    const initArg = sentryMocks.init.mock.calls[0]?.[0] as {
      dsn: string;
      beforeSend: (event: Event) => Event;
      beforeSendTransaction: (event: Event) => Event;
    };
    expect(initArg.dsn).toBe("https://public@example.ingest.sentry.io/9");
    const sanitized = initArg.beforeSend({
      user: { id: "u" },
      request: { url: "https://example.com/?token=secret" },
    });
    expect(sanitized.user).toBeUndefined();
    expect(sanitized.request?.url).not.toContain("token=");
    expect(initArg.beforeSendTransaction({ transaction: "/tmp/x" }).transaction).toBeDefined();
    expect(sentryMocks.setTag).toHaveBeenCalledWith("first_tree.surface", "client");
    expect(sentryMocks.setTag).toHaveBeenCalledWith("first_tree.git_sha", "deadbeef");
    expect(sentryMocks.setTag).toHaveBeenCalledWith("first_tree.cli_version", "1.2.3");
  });

  it("capture and flush no-op when Sentry is disabled", async () => {
    sentryMocks.isEnabled.mockReturnValue(false);
    expect(captureClientException(new Error("x"), { token: "secret" })).toBeUndefined();
    await expect(flushClientSentry(10)).resolves.toBe(true);
    expect(sentryMocks.captureException).not.toHaveBeenCalled();
    expect(sentryMocks.flush).not.toHaveBeenCalled();
  });

  it("capture and flush when Sentry is enabled", async () => {
    sentryMocks.isEnabled.mockReturnValue(true);
    const setContext = vi.fn();
    sentryMocks.withScope.mockImplementationOnce((cb) => cb({ setContext }));
    expect(captureClientException(new Error("boom"), { workspacePath: "/tmp/ws", token: "secret" })).toBe(
      "event-id",
    );
    expect(setContext).toHaveBeenCalledWith(
      "first_tree",
      expect.objectContaining({
        token: "[REDACTED]",
      }),
    );
    expect(sentryMocks.captureException).toHaveBeenCalledOnce();
    await expect(flushClientSentry(123)).resolves.toBe(true);
    expect(sentryMocks.flush).toHaveBeenCalledWith(123);
  });

  it("capture without context still scopes the exception", () => {
    sentryMocks.isEnabled.mockReturnValue(true);
    expect(captureClientException("plain")).toBe("event-id");
  });
});
