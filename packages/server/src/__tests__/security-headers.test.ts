import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import type { Config } from "../config.js";
import { buildSecurityHeaders } from "../security-headers.js";
import { useTestApp } from "./helpers.js";

/**
 * App-wide browser security headers (issue #1541).
 *
 * Two layers under test:
 *   1. `buildSecurityHeaders` — pure composition of the header values
 *      (enforced CSP + HSTS + nosniff + Referrer-Policy + Permissions-Policy
 *      + frame protection), including config-driven CSP origins.
 *   2. The root `onSend` hook — headers present on API success, API error,
 *      rate-limit, and SPA-fallback responses alike.
 */

const baseConfig: Config = {
  channel: "dev",
  growth: {
    landingPagesEnabled: false,
    landingCampaignMaxAgentTurns: 1,
    landingCampaignMaxEstimatedTokens: 120_000,
    landingCampaignMaxTrialsPerUserPer24Hours: 5,
  },
  docs: { enabled: false },
  database: { url: process.env.DATABASE_URL ?? "", provider: "external" },
  server: { port: 0, host: "127.0.0.1", publicUrl: undefined },
  workspace: { root: "/tmp/first-tree-test-workspaces" },
  secrets: {
    jwtSecret: "test-jwt-secret-key-for-vitest",
    encryptionKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  },
  auth: { accessTokenExpiry: "30m", refreshTokenExpiry: "30d", connectTokenExpiry: "10m" },
  trustProxy: false,
  connectBootstrap: {
    portableDownloadBaseUrl: "https://download.first-tree.ai/releases",
  },
  observability: { logging: { level: "error", format: "json", bridgeToSpanLevel: "off" } },
  runtime: {
    agentHttpTokenEnforcement: false,
    runtimeSwitchFaultInjection: false,
    pollingIntervalSeconds: 5,
    presenceCleanupSeconds: 60,
    archiveSweepIntervalSeconds: 0,
    archiveMappedIdleSeconds: 60 * 60,
    notificationWebhookUrl: undefined,
  },
  update: {
    commandVersion: "test.version",
    pollIntervalMinutes: 1440,
    registryUrl: "https://localhost.invalid",
  },
  instanceId: "test-instance",
};

const DEFAULT_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://avatars.githubusercontent.com https://lh3.googleusercontent.com",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const STATIC_HEADERS: Record<string, string> = {
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "x-frame-options": "DENY",
};

function expectSecurityHeaders(headers: Record<string, unknown>, csp = DEFAULT_CSP) {
  expect(headers["content-security-policy"]).toBe(csp);
  for (const [name, value] of Object.entries(STATIC_HEADERS)) {
    expect(headers[name]).toBe(value);
  }
}

/** The security group type requires all three keys; default the unset ones. */
function securityConfig(partial: {
  cspAnalyticsOrigins?: string;
  cspAvatarOrigins?: string;
  cspExtraConnectSrcOrigins?: string;
}): NonNullable<Config["security"]> {
  return {
    cspAnalyticsOrigins: undefined,
    cspAvatarOrigins: undefined,
    cspExtraConnectSrcOrigins: undefined,
    ...partial,
  };
}

describe("buildSecurityHeaders — header composition", () => {
  it("emits the full header set with the default CSP when no security config is set", () => {
    const headers = buildSecurityHeaders(baseConfig);
    expect(headers).toEqual({ "content-security-policy": DEFAULT_CSP, ...STATIC_HEADERS });
    // Acceptance invariants: enforced (not Report-Only), no unsafe-inline /
    // unsafe-eval in script directives, framing denied two ways.
    expect(headers["content-security-policy-report-only"]).toBeUndefined();
    expect(headers["content-security-policy"]).not.toMatch(/script-src[^;]*unsafe-(inline|eval)/);
    expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  });

  it("adds analytics origins to script-src, connect-src, and img-src", () => {
    const headers = buildSecurityHeaders({
      ...baseConfig,
      security: securityConfig({ cspAnalyticsOrigins: "https://www.googletagmanager.com, https://www.clarity.ms" }),
    });
    const csp = headers["content-security-policy"];
    expect(csp).toContain("script-src 'self' https://www.googletagmanager.com https://www.clarity.ms");
    expect(csp).toContain("connect-src 'self' https://www.googletagmanager.com https://www.clarity.ms");
    expect(csp).toContain(
      "img-src 'self' data: blob: https://avatars.githubusercontent.com https://lh3.googleusercontent.com https://www.googletagmanager.com https://www.clarity.ms",
    );
  });

  it("replaces the built-in avatar origins when cspAvatarOrigins is set", () => {
    const headers = buildSecurityHeaders({
      ...baseConfig,
      security: securityConfig({ cspAvatarOrigins: "https://avatars.example-cdn.com" }),
    });
    const csp = headers["content-security-policy"];
    expect(csp).toContain("img-src 'self' data: blob: https://avatars.example-cdn.com");
    expect(csp).not.toContain("avatars.githubusercontent.com");
  });

  it("adds extra connect-src origins without touching other directives", () => {
    const headers = buildSecurityHeaders({
      ...baseConfig,
      security: securityConfig({ cspExtraConnectSrcOrigins: "https://example.ingest.sentry.io" }),
    });
    const csp = headers["content-security-policy"];
    expect(csp).toContain("connect-src 'self' https://example.ingest.sentry.io");
    expect(csp).toContain("script-src 'self';");
    expect(csp).not.toContain("img-src 'self' data: blob: https://example.ingest.sentry.io");
  });

  it("rejects invalid CSP origins loudly", () => {
    for (const bad of [
      "not-a-url",
      "ftp://example.com",
      "https://example.com/path",
      "https://example.com/",
      "https://example.com?q=1",
    ]) {
      expect(() =>
        buildSecurityHeaders({ ...baseConfig, security: securityConfig({ cspExtraConnectSrcOrigins: bad }) }),
      ).toThrow(/FIRST_TREE_CSP_EXTRA_CONNECT_SRC/);
    }
  });
});

describe("security headers — app-wide onSend hook", () => {
  const getApp = useTestApp();

  it("sets all headers on an API response", async () => {
    const res = await getApp().inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expectSecurityHeaders(res.headers);
  });

  it("sets all headers on an API 404 JSON response", async () => {
    const res = await getApp().inject({ method: "GET", url: "/api/v1/does-not-exist" });
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toContain("application/json");
    expectSecurityHeaders(res.headers);
  });
});

describe("security headers — rate-limit responses", () => {
  const getApp = useTestApp({ rateLimit: { max: 1 } });

  it("sets all headers on a 429 response", async () => {
    const app = getApp();
    const first = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(first.statusCode).toBe(200);
    const limited = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(limited.statusCode).toBe(429);
    expectSecurityHeaders(limited.headers);
  });
});

describe("security headers — SPA responses", () => {
  it("sets all headers on static assets and the SPA fallback", async () => {
    const webRoot = await mkdtemp(join(tmpdir(), "first-tree-web-"));
    await writeFile(join(webRoot, "index.html"), "<!doctype html><html><body>App shell</body></html>", "utf8");

    let app: FastifyInstance | undefined;
    try {
      app = await buildApp({ ...baseConfig, webDistPath: webRoot });

      const shell = await app.inject({ method: "GET", url: "/" });
      expect(shell.statusCode).toBe(200);
      expectSecurityHeaders(shell.headers);

      const fallback = await app.inject({ method: "GET", url: "/workspace/deep-link" });
      expect(fallback.statusCode).toBe(200);
      expect(fallback.body).toContain("App shell");
      expectSecurityHeaders(fallback.headers);

      // With the SPA served, /api/* misses are JSON 404s from the not-found
      // handler — the production API error shape.
      const apiMiss = await app.inject({ method: "GET", url: "/api/missing" });
      expect(apiMiss.statusCode).toBe(404);
      expect(apiMiss.json()).toEqual({ error: "Not found" });
      expectSecurityHeaders(apiMiss.headers);
    } finally {
      if (app) await app.close();
      await rm(webRoot, { recursive: true, force: true });
    }
  });

  it("applies configured CSP origins to served responses", async () => {
    const webRoot = await mkdtemp(join(tmpdir(), "first-tree-web-"));
    await writeFile(join(webRoot, "index.html"), "<!doctype html><html><body>App shell</body></html>", "utf8");

    let app: FastifyInstance | undefined;
    try {
      app = await buildApp({
        ...baseConfig,
        webDistPath: webRoot,
        security: securityConfig({ cspAnalyticsOrigins: "https://www.googletagmanager.com" }),
      });

      const res = await app.inject({ method: "GET", url: "/" });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-security-policy"]).toContain("script-src 'self' https://www.googletagmanager.com");
    } finally {
      if (app) await app.close();
      await rm(webRoot, { recursive: true, force: true });
    }
  });
});
