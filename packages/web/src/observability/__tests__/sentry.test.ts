import type { Event } from "@sentry/react";
import { describe, expect, it } from "vitest";
import { resolveWebSentryConfig, sanitizeWebSentryEvent } from "../sentry.js";

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
});
