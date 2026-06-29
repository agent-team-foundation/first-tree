import type { Event } from "@sentry/node";
import { describe, expect, it } from "vitest";
import { resolveClientSentryConfig, sanitizeClientSentryEvent } from "../sentry.js";

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
});
