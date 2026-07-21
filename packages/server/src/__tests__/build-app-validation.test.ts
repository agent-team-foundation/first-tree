import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.js";
import type { Config } from "../config.js";
import { PERMISSIONS_POLICY } from "../security-headers.js";
import * as resourcesMigration from "../services/resources-migration.js";

/**
 * Boot-time gate: a typo in `FIRST_TREE_AUTH_*_EXPIRY` must fail the
 * server boot, not the first `/connect-tokens` call hours later.
 *
 * The parser itself is covered by `auth-expiry-parse.test.ts`; this test
 * guards that the validation *call site* still lives in the buildApp boot
 * path so a config typo trips the assertion before listen() returns.
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
  security: { csp: { scriptOrigins: [], connectOrigins: [], imageOrigins: [] } },
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

async function safeClose(app: FastifyInstance | undefined) {
  if (app) await app.close();
}

type InjectResponse = Awaited<ReturnType<FastifyInstance["inject"]>>;

function expectEmbeddedAppSecurityHeaders(response: InjectResponse): void {
  expect(response.headers["strict-transport-security"]).toBe("max-age=31536000; includeSubDomains");
  expect(response.headers["x-content-type-options"]).toBe("nosniff");
  expect(response.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  expect(response.headers["permissions-policy"]).toBe(PERMISSIONS_POLICY);
  expect(response.headers["x-frame-options"]).toBe("DENY");
  expect(response.headers["content-security-policy-report-only"]).toBeUndefined();

  const csp = response.headers["content-security-policy"];
  expect(csp).toBeTypeOf("string");
  if (typeof csp !== "string") throw new Error("missing Content-Security-Policy");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain("connect-src 'self' wss://first-tree.example");
  const scriptDirective = csp
    .split(";")
    .map((directive) => directive.trim())
    .find((directive) => directive.startsWith("script-src "));
  expect(scriptDirective).toBe("script-src 'self'");
  expect(scriptDirective).not.toContain("'unsafe-inline'");
  expect(scriptDirective).not.toContain("'unsafe-eval'");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("buildApp — token-lifetime config validation", () => {
  it("rejects a malformed refresh token expiry", async () => {
    const cfg: Config = { ...baseConfig, auth: { ...baseConfig.auth, refreshTokenExpiry: "30x" } };
    let app: FastifyInstance | undefined;
    try {
      await expect(async () => {
        app = await buildApp(cfg);
      }).rejects.toThrow(/Invalid expiry "30x"/);
    } finally {
      await safeClose(app);
    }
  });

  it("rejects a malformed access token expiry", async () => {
    const cfg: Config = { ...baseConfig, auth: { ...baseConfig.auth, accessTokenExpiry: "abc" } };
    let app: FastifyInstance | undefined;
    try {
      await expect(async () => {
        app = await buildApp(cfg);
      }).rejects.toThrow(/Invalid expiry "abc"/);
    } finally {
      await safeClose(app);
    }
  });

  it("rejects a malformed connect token expiry", async () => {
    const cfg: Config = { ...baseConfig, auth: { ...baseConfig.auth, connectTokenExpiry: "" } };
    let app: FastifyInstance | undefined;
    try {
      await expect(async () => {
        app = await buildApp(cfg);
      }).rejects.toThrow(/Invalid expiry/);
    } finally {
      await safeClose(app);
    }
  });

  it("includes all three configured values in the error so the operator can spot the typo", async () => {
    const cfg: Config = {
      ...baseConfig,
      auth: { accessTokenExpiry: "30m", refreshTokenExpiry: "bogus", connectTokenExpiry: "10m" },
    };
    let app: FastifyInstance | undefined;
    try {
      await expect(async () => {
        app = await buildApp(cfg);
      }).rejects.toThrow(/access=30m, refresh=bogus, connect=10m/);
    } finally {
      await safeClose(app);
    }
  });
});

describe("buildApp — server secret validation", () => {
  const productionServer = { ...baseConfig.server, publicUrl: "https://first-tree.example" };

  it("rejects a blank JWT secret before startup", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const cfg: Config = {
      ...baseConfig,
      server: productionServer,
      secrets: { ...baseConfig.secrets, jwtSecret: "" },
    };
    let app: FastifyInstance | undefined;
    try {
      await expect(async () => {
        app = await buildApp(cfg);
      }).rejects.toThrow(/FIRST_TREE_JWT_SECRET/);
    } finally {
      await safeClose(app);
    }
  });

  it("rejects a blank encryption key before startup", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const cfg: Config = {
      ...baseConfig,
      server: productionServer,
      secrets: { ...baseConfig.secrets, encryptionKey: "" },
    };
    let app: FastifyInstance | undefined;
    try {
      await expect(async () => {
        app = await buildApp(cfg);
      }).rejects.toThrow(/FIRST_TREE_ENCRYPTION_KEY/);
    } finally {
      await safeClose(app);
    }
  });

  it("rejects an encryption key with an unsupported encoding before startup", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const cfg: Config = {
      ...baseConfig,
      server: productionServer,
      secrets: { ...baseConfig.secrets, encryptionKey: "short" },
    };
    let app: FastifyInstance | undefined;
    try {
      await expect(async () => {
        app = await buildApp(cfg);
      }).rejects.toThrow(/FIRST_TREE_ENCRYPTION_KEY must be 32 bytes/);
    } finally {
      await safeClose(app);
    }
  });
});

describe("buildApp — retired feedback route boundary", () => {
  it("returns a 410 tombstone for /feedback/* instead of the SPA shell", async () => {
    const webRoot = await mkdtemp(join(tmpdir(), "first-tree-web-"));
    const buildId = "build-app-validation-web";
    await writeFile(join(webRoot, "index.html"), "<!doctype html><html><body>App shell</body></html>", "utf8");
    await mkdir(join(webRoot, "assets"));
    await writeFile(join(webRoot, "assets", "app.js"), "export const app = true;", "utf8");
    await writeFile(
      join(webRoot, "browser-security-manifest.json"),
      JSON.stringify({ schemaVersion: 1, buildId, integrations: [] }),
      "utf8",
    );
    await writeFile(join(webRoot, "version.json"), JSON.stringify({ buildId }), "utf8");

    let app: FastifyInstance | undefined;
    try {
      app = await buildApp({
        ...baseConfig,
        server: { ...baseConfig.server, publicUrl: "https://first-tree.example" },
        oauth: {
          githubApp: {
            appId: "test-app-id",
            clientId: "test-app-client-id",
            clientSecret: "test-app-client-secret",
            privateKeyPem: "-----BEGIN PRIVATE KEY-----\nstub\n-----END PRIVATE KEY-----\n",
            webhookSecret: "test-app-webhook-secret",
            slug: undefined,
          },
        },
        webDistPath: webRoot,
      });

      const spa = await app.inject({ method: "GET", url: "/workspace/deep-link" });
      expect(spa.statusCode).toBe(200);
      expect(spa.body).toContain("App shell");

      const apiSuccess = await app.inject({ method: "GET", url: "/api/v1/health" });
      expect(apiSuccess.statusCode).toBe(200);
      const apiHead = await app.inject({ method: "HEAD", url: "/api/v1/health" });
      expect(apiHead.statusCode).toBe(200);
      expect(apiHead.body).toBe("");

      const spaHead = await app.inject({ method: "HEAD", url: "/workspace/deep-link" });
      expect(spaHead.statusCode).toBe(200);
      expect(spaHead.body).toBe("");

      const preflight = await app.inject({
        method: "OPTIONS",
        url: "/api/v1/health",
        headers: {
          origin: "https://browser.example",
          "access-control-request-method": "GET",
        },
      });
      expect(preflight.statusCode).toBe(204);

      const redirect = await app.inject({ method: "GET", url: "/api/v1/auth/github/start" });
      expect(redirect.statusCode).toBe(302);
      expect(redirect.headers.location).toMatch(/^https:\/\/github\.com\//u);

      const asset = await app.inject({ method: "GET", url: "/assets/app.js" });
      expect(asset.statusCode).toBe(200);
      expect(asset.headers.etag).toBeTypeOf("string");
      const assetHead = await app.inject({ method: "HEAD", url: "/assets/app.js" });
      expect(assetHead.statusCode).toBe(200);
      expect(assetHead.body).toBe("");
      const assetNotModified = await app.inject({
        method: "GET",
        url: "/assets/app.js",
        headers: { "if-none-match": String(asset.headers.etag) },
      });
      expect(assetNotModified.statusCode).toBe(304);

      const feedback = await app.inject({ method: "POST", url: "/feedback/chat" });
      expect(feedback.statusCode).toBe(410);
      expect(feedback.headers["content-type"]).toContain("application/json");
      expect(feedback.json()).toEqual({ error: "Feedback has been removed" });
      expect(feedback.body).not.toContain("App shell");

      const apiMiss = await app.inject({ method: "GET", url: "/api/missing" });
      expect(apiMiss.statusCode).toBe(404);
      expect(apiMiss.json()).toEqual({ error: "Not found" });

      const assetMiss = await app.inject({ method: "GET", url: "/assets/missing.js" });
      expect(assetMiss.statusCode).toBe(404);
      expect(assetMiss.json()).toEqual({ error: "Not found" });

      for (const response of [
        spa,
        spaHead,
        apiSuccess,
        apiHead,
        preflight,
        redirect,
        asset,
        assetHead,
        assetNotModified,
        feedback,
        apiMiss,
        assetMiss,
      ]) {
        expectEmbeddedAppSecurityHeaders(response);
      }
    } finally {
      await safeClose(app);
      await rm(webRoot, { recursive: true, force: true });
    }
  });
});

describe("buildApp — boot-time edge branches", () => {
  it("boots with package-version fallback, trusted proxy logging, trace attrs, and backfill failure tolerance", async () => {
    const backfill = vi.spyOn(resourcesMigration, "backfillResourcesPhase1").mockRejectedValueOnce(new Error("down"));
    let app: FastifyInstance | undefined;
    try {
      app = await buildApp({
        ...baseConfig,
        trustProxy: true,
        observability: {
          ...baseConfig.observability,
          tracing: {
            endpoint: "",
            headers: "",
            exporter: "otlp-http",
            serviceName: "first-tree-test",
            environment: "test",
            sampleRate: 1,
            captureClientIp: true,
          },
        },
        update: { ...baseConfig.update, commandVersion: undefined },
      });
      await app.ready();

      expect(app.commandVersion()).toBe("0.1.0");
      expect(backfill).toHaveBeenCalledTimes(1);

      const res = await app.inject({
        method: "GET",
        url: "/healthz?token=secret",
        headers: {
          referer: "https://example.test/workspace",
          "user-agent": "first-tree-test",
          "x-forwarded-for": "203.0.113.10",
        },
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await safeClose(app);
    }
  });
});
