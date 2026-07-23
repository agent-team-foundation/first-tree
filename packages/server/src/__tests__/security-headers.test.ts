import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CSP_CONNECT_ORIGINS,
  DEFAULT_CSP_IMG_ORIGINS,
  DEFAULT_CSP_SCRIPT_ORIGINS,
} from "@first-tree/shared/config";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import type { Config } from "../config.js";
import { buildContentSecurityPolicy, buildSecurityHeaders } from "../security-headers.js";

/**
 * App-wide browser security headers (issue #1541).
 *
 * Unit tests pin the exact header values as pure functions of config;
 * integration tests prove the `onSend` layer actually reaches every reply
 * shape the server produces — SPA shell, SPA deep-link fallback, API JSON,
 * API 404, and asset 404 — and that the config kill switch removes it.
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
  cronJobs: { enabled: false },
  database: { url: process.env.DATABASE_URL ?? "", provider: "external" },
  server: { port: 0, host: "127.0.0.1", publicUrl: undefined },
  workspace: { root: "/tmp/first-tree-test-workspaces" },
  secrets: {
    jwtSecret: "test-jwt-secret-key-for-vitest",
    encryptionKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  },
  auth: { accessTokenExpiry: "30m", refreshTokenExpiry: "30d", connectTokenExpiry: "10m" },
  security: {
    headersEnabled: true,
    cspScriptOrigins: [...DEFAULT_CSP_SCRIPT_ORIGINS],
    cspConnectOrigins: [...DEFAULT_CSP_CONNECT_ORIGINS],
    cspImgOrigins: [...DEFAULT_CSP_IMG_ORIGINS],
  },
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

const EXPECTED_STATIC_HEADERS: Record<string, string> = {
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "x-frame-options": "DENY",
};

function cspDirectives(csp: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const chunk of csp.split(";")) {
    const [name, ...sources] = chunk.trim().split(/\s+/);
    if (name) map.set(name, sources.join(" "));
  }
  return map;
}

describe("buildSecurityHeaders / buildContentSecurityPolicy", () => {
  it("emits the complete issue-mandated header set", () => {
    const headers = buildSecurityHeaders(baseConfig);
    expect(headers).toMatchObject(EXPECTED_STATIC_HEADERS);
    expect(headers["content-security-policy"]).toBe(buildContentSecurityPolicy(baseConfig));
    expect(Object.keys(headers)).toHaveLength(6);
  });

  it("builds a least-privilege CSP from the default origin lists", () => {
    const directives = cspDirectives(buildContentSecurityPolicy(baseConfig));

    expect(directives.get("default-src")).toBe("'self'");
    expect(directives.get("base-uri")).toBe("'self'");
    expect(directives.get("object-src")).toBe("'none'");
    expect(directives.get("frame-ancestors")).toBe("'none'");
    expect(directives.get("form-action")).toBe("'self'");
    expect(directives.get("font-src")).toBe("'self'");
    expect(directives.get("script-src")).toBe(`'self' ${DEFAULT_CSP_SCRIPT_ORIGINS.join(" ")}`);
    expect(directives.get("style-src")).toBe("'self' 'unsafe-inline'");
    expect(directives.get("img-src")).toBe(`'self' data: blob: ${DEFAULT_CSP_IMG_ORIGINS.join(" ")}`);
    // No publicUrl configured — no explicit ws(s) source; 'self' still covers
    // the same-origin WebSocket in CSP3-era browsers.
    expect(directives.get("connect-src")).toBe(`'self' ${DEFAULT_CSP_CONNECT_ORIGINS.join(" ")}`);
  });

  it("never allows unsafe-inline or unsafe-eval in script directives", () => {
    const directives = cspDirectives(
      buildContentSecurityPolicy({
        ...baseConfig,
        security: {
          ...baseConfig.security,
          // Even a hostile-looking origin list cannot smuggle keyword sources:
          // the shared config schema rejects non-origin entries before they
          // reach this builder; here we just pin the builder's own output.
          cspScriptOrigins: ["https://cdn.example.com"],
        },
      }),
    );
    expect(directives.get("script-src")).toBe("'self' https://cdn.example.com");
    for (const [name, sources] of directives) {
      if (name.startsWith("script-")) {
        expect(sources).not.toContain("unsafe-inline");
        expect(sources).not.toContain("unsafe-eval");
      }
    }
  });

  it("derives the same-origin WebSocket source from server.publicUrl", () => {
    const https = buildContentSecurityPolicy({
      ...baseConfig,
      server: { ...baseConfig.server, publicUrl: "https://cloud.first-tree.ai" },
    });
    expect(cspDirectives(https).get("connect-src")).toContain("wss://cloud.first-tree.ai");

    const http = buildContentSecurityPolicy({
      ...baseConfig,
      server: { ...baseConfig.server, publicUrl: "http://localhost:9017" },
    });
    expect(cspDirectives(http).get("connect-src")).toContain("ws://localhost:9017");

    const invalid = buildContentSecurityPolicy({
      ...baseConfig,
      server: { ...baseConfig.server, publicUrl: "not a url" },
    });
    expect(cspDirectives(invalid).get("connect-src")).not.toMatch(/\bwss?:\/\//);
  });

  it("reflects per-environment origin overrides in the emitted policy", () => {
    const directives = cspDirectives(
      buildContentSecurityPolicy({
        ...baseConfig,
        security: {
          headersEnabled: true,
          cspScriptOrigins: [],
          cspConnectOrigins: ["https://*.ingest.sentry.io"],
          cspImgOrigins: ["https://cdn.example.com"],
        },
      }),
    );
    expect(directives.get("script-src")).toBe("'self'");
    expect(directives.get("connect-src")).toBe("'self' https://*.ingest.sentry.io");
    expect(directives.get("img-src")).toBe("'self' data: blob: https://cdn.example.com");
  });
});

describe("buildApp — security headers on every reply path", () => {
  async function withSpaApp(config: Config, run: (app: FastifyInstance) => Promise<void>): Promise<void> {
    const webRoot = await mkdtemp(join(tmpdir(), "first-tree-web-"));
    await writeFile(join(webRoot, "index.html"), "<!doctype html><html><body>App shell</body></html>", "utf8");
    let app: FastifyInstance | undefined;
    try {
      app = await buildApp({ ...config, webDistPath: webRoot });
      await run(app);
    } finally {
      if (app) await app.close();
      await rm(webRoot, { recursive: true, force: true });
    }
  }

  it("applies the full header set to SPA shell, SPA fallback, API JSON, and 404 replies", async () => {
    const expectedCsp = buildContentSecurityPolicy(baseConfig);
    await withSpaApp(baseConfig, async (app) => {
      const responses = await Promise.all([
        app.inject({ method: "GET", url: "/" }), // SPA shell
        app.inject({ method: "GET", url: "/workspace/deep-link" }), // SPA not-found fallback
        app.inject({ method: "GET", url: "/healthz" }), // API JSON route
        app.inject({ method: "GET", url: "/api/missing" }), // API 404 JSON
        app.inject({ method: "GET", url: "/assets/missing.js" }), // asset 404
      ]);
      for (const res of responses) {
        expect(res.headers["content-security-policy"]).toBe(expectedCsp);
        for (const [name, value] of Object.entries(EXPECTED_STATIC_HEADERS)) {
          expect(res.headers[name]).toBe(value);
        }
      }
      expect(responses[0]?.statusCode).toBe(200);
      expect(responses[1]?.statusCode).toBe(200);
      expect(responses[3]?.statusCode).toBe(404);
      expect(responses[4]?.statusCode).toBe(404);
    });
  });

  it("omits the header layer when the config kill switch disables it", async () => {
    await withSpaApp(
      {
        ...baseConfig,
        security: { ...baseConfig.security, headersEnabled: false },
      },
      async (app) => {
        const res = await app.inject({ method: "GET", url: "/" });
        expect(res.statusCode).toBe(200);
        expect(res.headers["content-security-policy"]).toBeUndefined();
        expect(res.headers["strict-transport-security"]).toBeUndefined();
        expect(res.headers["x-frame-options"]).toBeUndefined();
      },
    );
  });
});
