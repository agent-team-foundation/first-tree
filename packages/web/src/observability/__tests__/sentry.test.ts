import type { Event } from "@sentry/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureReactRootError, initWebSentry, resolveWebSentryConfig, sanitizeWebSentryEvent } from "../sentry.js";

const sentryMocks = vi.hoisted(() => ({
  captureException: vi.fn(),
  init: vi.fn(),
  isEnabled: vi.fn(),
  setTag: vi.fn(),
  withScope: vi.fn(),
}));

vi.mock("@sentry/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@sentry/react")>()),
  captureException: sentryMocks.captureException,
  init: sentryMocks.init,
  isEnabled: sentryMocks.isEnabled,
  setTag: sentryMocks.setTag,
  withScope: sentryMocks.withScope,
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("resolveWebSentryConfig", () => {
  it("defaults to enabled when a DSN is configured", () => {
    const config = resolveWebSentryConfig({
      MODE: "production",
      VITE_SENTRY_DSN: "https://public@example.ingest.sentry.io/1",
    } as ImportMetaEnv);

    expect(config.enabled).toBe(true);
    expect(config.release).toBe("first-tree-web@test");
    expect(config.buildId).toBe("test");
  });

  it("honors an explicit disable switch", () => {
    const config = resolveWebSentryConfig({
      MODE: "production",
      VITE_SENTRY_DSN: "https://public@example.ingest.sentry.io/1",
      VITE_SENTRY_ENABLED: "false",
    } as ImportMetaEnv);

    expect(config.enabled).toBe(false);
  });

  it("normalizes explicit config values and rejects invalid sample rates", () => {
    const config = resolveWebSentryConfig({
      MODE: "development",
      VITE_SENTRY_DSN: "  https://public@example.ingest.sentry.io/1  ",
      VITE_SENTRY_ENABLED: "YES",
      VITE_SENTRY_ENVIRONMENT: "  staging  ",
      VITE_SENTRY_RELEASE: "  first-tree-web@custom  ",
      VITE_SENTRY_TRACES_SAMPLE_RATE: "2",
    } as ImportMetaEnv);

    expect(config).toMatchObject({
      enabled: true,
      dsn: "https://public@example.ingest.sentry.io/1",
      environment: "staging",
      release: "first-tree-web@custom",
      sampleRate: 0.1,
    });
  });

  it("uses production only on the production host and accepts bounded sample rates", () => {
    vi.stubGlobal("window", { location: { hostname: "cloud.first-tree.ai" } });

    const config = resolveWebSentryConfig({
      MODE: "development",
      VITE_SENTRY_ENABLED: "1",
      VITE_SENTRY_TRACES_SAMPLE_RATE: "0.75",
    } as ImportMetaEnv);

    expect(config.environment).toBe("production");
    expect(config.sampleRate).toBe(0.75);
  });
});

describe("initWebSentry", () => {
  it("does not initialize when disabled or missing a DSN", () => {
    vi.stubEnv("VITE_SENTRY_DSN", "");
    vi.stubEnv("VITE_SENTRY_ENABLED", "true");

    initWebSentry();

    expect(sentryMocks.init).not.toHaveBeenCalled();
  });

  it("initializes Sentry with sanitizers and release tags", () => {
    vi.stubEnv("VITE_SENTRY_DSN", "https://public@example.ingest.sentry.io/1");
    vi.stubEnv("VITE_SENTRY_ENABLED", "true");
    vi.stubEnv("VITE_SENTRY_ENVIRONMENT", "staging");
    vi.stubEnv("VITE_SENTRY_RELEASE", "first-tree-web@sha");
    vi.stubEnv("VITE_SENTRY_TRACES_SAMPLE_RATE", "0.5");

    initWebSentry();

    const options = sentryMocks.init.mock.calls[0]?.[0];
    expect(options).toMatchObject({
      dsn: "https://public@example.ingest.sentry.io/1",
      environment: "staging",
      release: "first-tree-web@sha",
      tracesSampleRate: 0.5,
      sendDefaultPii: false,
      maxBreadcrumbs: 0,
    });
    expect(options?.beforeSend?.({ message: "Bearer secret-token" }).message).toBe("Bearer [REDACTED]");
    expect(options?.beforeSendTransaction?.({ transaction: "/invite/raw-token?x=1" }).transaction).toBe(
      "/invite/[token]",
    );
    expect(sentryMocks.setTag).toHaveBeenCalledWith("first_tree.surface", "web");
    expect(sentryMocks.setTag).toHaveBeenCalledWith("first_tree.git_sha", "test");
  });
});

describe("captureReactRootError", () => {
  it("skips disabled Sentry clients", () => {
    sentryMocks.isEnabled.mockReturnValue(false);

    captureReactRootError(new Error("boom"), { componentStack: "stack" });

    expect(sentryMocks.withScope).not.toHaveBeenCalled();
    expect(sentryMocks.captureException).not.toHaveBeenCalled();
  });

  it("captures enabled root errors with the React component stack", () => {
    const setContext = vi.fn();
    const error = new Error("boom");
    sentryMocks.isEnabled.mockReturnValue(true);
    sentryMocks.withScope.mockImplementation((callback: (scope: { setContext: typeof setContext }) => void) => {
      callback({ setContext });
    });

    captureReactRootError(error, { componentStack: "at App" });

    expect(setContext).toHaveBeenCalledWith("react", { componentStack: "at App" });
    expect(sentryMocks.captureException).toHaveBeenCalledWith(error);
  });
});

describe("sanitizeWebSentryEvent", () => {
  it("templates sensitive routes and drops query/hash data", () => {
    const rawEvent: Event = {
      request: {
        url: "https://cloud.first-tree.ai/invite/secret-token?token=abc#fragment",
        headers: { authorization: "Bearer secret", accept: "application/json" },
        cookies: { session: "secret" },
        query_string: "token=abc",
        data: { token: "secret" },
      },
      transaction: "/auth/github/complete?code=secret#access=secret",
    };
    const event = sanitizeWebSentryEvent(rawEvent, {
      enabled: true,
      dsn: "https://public@example.ingest.sentry.io/1",
      environment: "production",
      release: "first-tree-web@test-sha",
      buildId: "test-sha",
      sampleRate: 0.1,
    });

    expect(event.request?.url).toBe("https://cloud.first-tree.ai/invite/[token]");
    expect(event.request?.headers).toEqual({
      authorization: "[REDACTED]",
      accept: "application/json",
    });
    expect(event.request?.cookies).toBeUndefined();
    expect(event.request?.query_string).toBeUndefined();
    expect(event.request?.data).toBeUndefined();
    expect(event.transaction).toBe("/auth/github/complete");
    expect(event.tags).toMatchObject({
      "first_tree.surface": "web",
      "first_tree.git_sha": "test-sha",
    });
  });

  it("drops breadcrumbs and scrubs credentials from event payload fields", () => {
    const rawEvent: Event = {
      message: "failed at /invite/raw-invite-token?token=secret",
      breadcrumbs: [{ message: "navigated to /auth/github/complete#access=secret" }],
      contexts: {
        firstTree: {
          url: "https://cloud.first-tree.ai/invite/context-token?token=secret#fragment",
          authorization: "Bearer secret",
        },
      },
      extra: {
        callback: "/auth/github/complete?code=secret#access=secret",
        nested: {
          note: "open https://cloud.first-tree.ai/invite/extra-token?token=secret",
          refreshToken: "secret",
        },
      },
      exception: {
        values: [
          {
            type: "Error",
            value: "OAuth failed at /auth/github/complete#access=secret",
          },
        ],
      },
    };
    const event = sanitizeWebSentryEvent(rawEvent, {
      enabled: true,
      dsn: "https://public@example.ingest.sentry.io/1",
      environment: "production",
      release: "first-tree-web@test-sha",
      buildId: "test-sha",
      sampleRate: 0.1,
    });

    expect(event.breadcrumbs).toBeUndefined();
    expect(event.message).toBe("failed at /invite/[token]");
    expect(event.contexts?.firstTree).toMatchObject({
      url: "https://cloud.first-tree.ai/invite/[token]",
      authorization: "[REDACTED]",
    });
    expect(event.extra?.callback).toBe("/auth/github/complete");
    expect(event.extra?.nested).toEqual({
      note: "open https://cloud.first-tree.ai/invite/[token]",
      refreshToken: "[REDACTED]",
    });
    expect(event.exception?.values?.[0]?.value).toBe("OAuth failed at /auth/github/complete");
  });

  it("scrubs arrays, non-string headers, relative routes, and invalid URLs", () => {
    const rawEvent: Event = {
      request: {
        url: "/invite/local-token?access_token=secret",
        headers: {
          "x-count": "3",
          "x-api-key": "secret",
          cookie: "session=secret",
        },
      },
      transaction: "not a url /auth/github/complete?code=secret",
      extra: {
        redirects: ["/invite/array-token?token=secret", { password: "secret", value: "Bearer nested-token" }, 42],
      },
      message: "send apiKey=secret and oauth_code=abc",
    };
    const event = sanitizeWebSentryEvent(rawEvent, {
      enabled: true,
      dsn: "https://public@example.ingest.sentry.io/1",
      environment: "production",
      release: "first-tree-web@test-sha",
      buildId: "test-sha",
      sampleRate: 0.1,
    });

    expect(event.request?.url).toBe("/invite/[token]");
    expect(event.request?.headers).toEqual({
      "x-count": "3",
      "x-api-key": "[REDACTED]",
      cookie: "[REDACTED]",
    });
    expect(event.transaction).toBe("/not%20a%20url%20/auth/github/complete");
    expect(event.extra?.redirects).toEqual([
      "/invite/[token]",
      { password: "[REDACTED]", value: "Bearer [REDACTED]" },
      42,
    ]);
    expect(event.message).toBe("send apiKey=[REDACTED] and oauth_code=[REDACTED]");
  });

  it("redacts the generic OAuth completion route and short token keys", () => {
    const event = sanitizeWebSentryEvent(
      {
        message: "OAuth failed at /auth/complete#access=access-secret&refresh=refresh-secret",
        extra: { callback: "/auth/complete#access=access-secret&refresh=refresh-secret" },
      },
      {
        enabled: true,
        dsn: "https://public@example.ingest.sentry.io/1",
        environment: "production",
        release: "first-tree-web@test-sha",
        buildId: "test-sha",
        sampleRate: 0.1,
      },
    );

    expect(event.message).toBe("OAuth failed at /auth/complete");
    expect(event.extra?.callback).toBe("/auth/complete");
    expect(
      sanitizeWebSentryEvent(
        { message: "access=secret&refresh=secret" },
        {
          enabled: true,
          dsn: "https://public@example.ingest.sentry.io/1",
          environment: "production",
          release: "first-tree-web@test-sha",
          buildId: "test-sha",
          sampleRate: 0.1,
        },
      ).message,
    ).toBe("access=[REDACTED]&refresh=[REDACTED]");
  });
});
