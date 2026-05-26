import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import type { Config } from "../config.js";

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
  database: { url: process.env.DATABASE_URL ?? "", provider: "external" },
  server: { port: 0, host: "127.0.0.1", publicUrl: undefined },
  workspace: { root: "/tmp/first-tree-test-workspaces" },
  secrets: {
    jwtSecret: "test-jwt-secret-key-for-vitest",
    encryptionKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  },
  auth: { accessTokenExpiry: "30m", refreshTokenExpiry: "30d", connectTokenExpiry: "10m" },
  trustProxy: false,
  observability: { logging: { level: "error", format: "json", bridgeToSpanLevel: "off" } },
  runtime: {
    inboxTimeoutSeconds: 300,
    maxRetryCount: 3,
    pollingIntervalSeconds: 5,
    presenceCleanupSeconds: 60,
    archiveSweepIntervalSeconds: 0,
    archiveMappedIdleSeconds: 60 * 60,
    archiveUnmappedIdleSeconds: 12 * 60 * 60,
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
