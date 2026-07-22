import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerConfig } from "@first-tree/shared/config";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertBootConfigValid } from "../boot-guards.js";
import { shouldAutoGenerateServerSecrets, startServer } from "../bootstrap-server.js";
import { bootstrapState, markReady, markStage } from "../bootstrap-state.js";
import { runStage, withTimeout } from "../bootstrap-utils.js";
import { runMigrations } from "../db/migrate.js";
import { useTestApp } from "./helpers.js";

/**
 * Bootstrap state is process-scoped and persists across `it`s (vitest reuses
 * worker processes via `isolate: false`). Clear the stage map between tests
 * so a write in one case doesn't leak into another suite's readyz check.
 */
function resetBootstrapState(): void {
  for (const key of Object.keys(bootstrapState.stages)) {
    delete bootstrapState.stages[key];
  }
  bootstrapState.readyAt = null;
}

const tempDirs: string[] = [];

function makeTempConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "first-tree-bootstrap-config-"));
  tempDirs.push(dir);
  return dir;
}

const baseServerConfig: ServerConfig = {
  channel: "dev",
  growth: {
    landingPagesEnabled: false,
    landingCampaignMaxAgentTurns: 1,
    landingCampaignMaxEstimatedTokens: 120_000,
    landingCampaignMaxTrialsPerUserPer24Hours: 5,
  },
  docs: { enabled: false },
  database: { url: process.env.DATABASE_URL ?? "", provider: "external" },
  server: { port: 0, host: "127.0.0.1", authority: undefined, publicUrl: "https://first-tree.example" },
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
};

describe("server bootstrap", () => {
  it("allows generated server secrets only for the dev channel", () => {
    const configDir = makeTempConfigDir();

    expect(shouldAutoGenerateServerSecrets(configDir)).toBe(true);

    writeFileSync(join(configDir, "server.yaml"), "channel: staging\n");
    expect(shouldAutoGenerateServerSecrets(configDir)).toBe(false);

    writeFileSync(join(configDir, "server.yaml"), "channel: prod\n");
    expect(shouldAutoGenerateServerSecrets(configDir)).toBe(false);

    vi.stubEnv("FIRST_TREE_CHANNEL", "dev");
    expect(shouldAutoGenerateServerSecrets(configDir)).toBe(true);

    vi.stubEnv("FIRST_TREE_CHANNEL", "staging");
    expect(shouldAutoGenerateServerSecrets(configDir)).toBe(false);
  });

  it("does not generate server secrets in production even when the channel defaults to dev", () => {
    const configDir = makeTempConfigDir();

    vi.stubEnv("NODE_ENV", "production");

    expect(shouldAutoGenerateServerSecrets(configDir)).toBe(false);
  });

  it("validates boot config before telemetry and migrations", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const initTelemetryFn = vi.fn(async () => undefined);
    const runMigrationsFn = vi.fn(async () => 0);
    const markReadyFn = vi.fn();
    const shutdownTelemetryFn = vi.fn(async () => undefined);

    await expect(
      startServer({
        initServerConfig: async () => ({
          ...baseServerConfig,
          secrets: { ...baseServerConfig.secrets, encryptionKey: "short" },
        }),
        randomUUID: () => "12345678-1234-1234-1234-123456789abc",
        initTelemetry: initTelemetryFn,
        runMigrations: runMigrationsFn,
        markReady: markReadyFn,
        shutdownTelemetry: shutdownTelemetryFn,
      }),
    ).rejects.toThrow(/FIRST_TREE_ENCRYPTION_KEY must be 32 bytes/);

    expect(initTelemetryFn).not.toHaveBeenCalled();
    expect(runMigrationsFn).not.toHaveBeenCalled();
    expect(markReadyFn).not.toHaveBeenCalled();
    expect(shutdownTelemetryFn).not.toHaveBeenCalled();
  });

  it("starts the server through telemetry, migrations, app build, listen, and ready stages", async () => {
    const initTelemetryFn = vi.fn(async () => undefined);
    const runMigrationsFn = vi.fn(async () => 12);
    const listenFn = vi.fn(async () => "http://127.0.0.1:0");
    const closeFn = vi.fn(async () => undefined);
    const buildAppFn = vi.fn(async () => ({ listen: listenFn, close: closeFn }));
    const markReadyFn = vi.fn();
    const shutdownTelemetryFn = vi.fn(async () => undefined);
    const processOn = vi.spyOn(process, "on").mockReturnValue(process);

    await startServer({
      initServerConfig: async () => baseServerConfig,
      randomUUID: () => "12345678-1234-4234-9234-123456789abc",
      webDistPath: "/srv/web",
      initTelemetry: initTelemetryFn,
      runMigrations: runMigrationsFn,
      buildApp: buildAppFn as never,
      markReady: markReadyFn,
      shutdownTelemetry: shutdownTelemetryFn,
    });

    expect(initTelemetryFn).toHaveBeenCalledWith(baseServerConfig.observability.tracing, "srv_12345678");
    expect(runMigrationsFn).toHaveBeenCalledWith(baseServerConfig.database.url);
    expect(buildAppFn).toHaveBeenCalledWith(
      expect.objectContaining({
        instanceId: "srv_12345678",
        webDistPath: "/srv/web",
      }),
    );
    expect(listenFn).toHaveBeenCalledWith({ host: "127.0.0.1", port: 0 });
    expect(markReadyFn).toHaveBeenCalledTimes(1);
    expect(processOn).toHaveBeenCalledWith("SIGINT", expect.any(Function));
    expect(processOn).toHaveBeenCalledWith("SIGTERM", expect.any(Function));
    expect(closeFn).not.toHaveBeenCalled();
    expect(shutdownTelemetryFn).not.toHaveBeenCalled();
  });

  it("runs app and telemetry shutdown from registered process signal handlers", async () => {
    const initTelemetryFn = vi.fn(async () => undefined);
    const runMigrationsFn = vi.fn(async () => 0);
    const listenFn = vi.fn(async () => "http://127.0.0.1:0");
    const closeFn = vi.fn(async () => undefined);
    const buildAppFn = vi.fn(async () => ({ listen: listenFn, close: closeFn }));
    const markReadyFn = vi.fn();
    const shutdownTelemetryFn = vi.fn(async () => undefined);
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const processOn = vi.fn((event: string | symbol, handler: (...args: unknown[]) => void) => {
      handlers.set(String(event), handler as (...args: unknown[]) => void);
      return fakeProcess;
    });
    const processExit = vi.fn();
    const fakeProcess = Object.assign(Object.create(process), {
      on: processOn,
      exit: processExit,
    }) as NodeJS.Process;

    try {
      vi.stubGlobal("process", fakeProcess);
      await startServer({
        initServerConfig: async () => baseServerConfig,
        randomUUID: () => "87654321-1234-4234-9234-123456789abc",
        initTelemetry: initTelemetryFn,
        runMigrations: runMigrationsFn,
        buildApp: buildAppFn as never,
        markReady: markReadyFn,
        shutdownTelemetry: shutdownTelemetryFn,
      });

      handlers.get("SIGTERM")?.();

      await vi.waitFor(() => expect(closeFn).toHaveBeenCalledTimes(1));
      expect(shutdownTelemetryFn).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => expect(processExit).toHaveBeenCalledWith(0));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("runs shutdown from the registered SIGINT handler", async () => {
    const initTelemetryFn = vi.fn(async () => undefined);
    const runMigrationsFn = vi.fn(async () => 0);
    const listenFn = vi.fn(async () => "http://127.0.0.1:0");
    const closeFn = vi.fn(async () => undefined);
    const buildAppFn = vi.fn(async () => ({ listen: listenFn, close: closeFn }));
    const markReadyFn = vi.fn();
    const shutdownTelemetryFn = vi.fn(async () => undefined);
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const processOn = vi.fn((event: string | symbol, handler: (...args: unknown[]) => void) => {
      handlers.set(String(event), handler as (...args: unknown[]) => void);
      return fakeProcess;
    });
    const processExit = vi.fn();
    const fakeProcess = Object.assign(Object.create(process), {
      on: processOn,
      exit: processExit,
    }) as NodeJS.Process;

    try {
      vi.stubGlobal("process", fakeProcess);
      await startServer({
        initServerConfig: async () => baseServerConfig,
        randomUUID: () => "97654321-1234-4234-9234-123456789abc",
        initTelemetry: initTelemetryFn,
        runMigrations: runMigrationsFn,
        buildApp: buildAppFn as never,
        markReady: markReadyFn,
        shutdownTelemetry: shutdownTelemetryFn,
      });

      handlers.get("SIGINT")?.();

      await vi.waitFor(() => expect(closeFn).toHaveBeenCalledTimes(1));
      expect(shutdownTelemetryFn).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => expect(processExit).toHaveBeenCalledWith(0));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  describe("boot config guards", () => {
    it("rejects missing required secrets", () => {
      expect(() =>
        assertBootConfigValid({
          ...baseServerConfig,
          instanceId: "srv_test",
          secrets: { ...baseServerConfig.secrets, jwtSecret: "   " },
        }),
      ).toThrow("Missing required server secret env vars: FIRST_TREE_JWT_SECRET");
    });

    it("requires a public URL in production", () => {
      vi.stubEnv("NODE_ENV", "production");

      expect(() =>
        assertBootConfigValid({
          ...baseServerConfig,
          instanceId: "srv_test",
          server: { ...baseServerConfig.server, publicUrl: undefined },
        }),
      ).toThrow("FIRST_TREE_PUBLIC_URL is required in production");
    });

    it("rejects half-configured, empty, and malformed GitHub App blocks", () => {
      const validGithubApp = {
        appId: "app-id",
        clientId: "client-id",
        clientSecret: "client-secret",
        privateKeyPem: "-----BEGIN PRIVATE KEY-----\nstub\n-----END PRIVATE KEY-----\n",
        slug: undefined,
        webhookSecret: "webhook-secret",
      };

      expect(() =>
        assertBootConfigValid({
          ...baseServerConfig,
          instanceId: "srv_test",
          oauth: { githubApp: { ...validGithubApp, webhookSecret: "" } },
        }),
      ).toThrow("GitHub App is half-configured");

      expect(() =>
        assertBootConfigValid({
          ...baseServerConfig,
          instanceId: "srv_test",
          oauth: {
            githubApp: {
              appId: "",
              clientId: "",
              clientSecret: "",
              privateKeyPem: "",
              slug: undefined,
              webhookSecret: "",
            },
          },
        }),
      ).toThrow("GitHub App env block is present but every value is empty");

      expect(() =>
        assertBootConfigValid({
          ...baseServerConfig,
          instanceId: "srv_test",
          oauth: { githubApp: { ...validGithubApp, privateKeyPem: "literal\\nbody" } },
        }),
      ).toThrow("FIRST_TREE_GITHUB_APP_PRIVATE_KEY does not look like a PKCS#8 PEM");

      expect(() =>
        assertBootConfigValid({
          ...baseServerConfig,
          instanceId: "srv_test",
          oauth: { githubApp: validGithubApp },
        }),
      ).not.toThrow();
    });
  });

  it("runMigrations resolves the drizzle folder and applies migrations idempotently", async () => {
    const databaseUrl = process.env.DATABASE_URL;
    expect(databaseUrl, "DATABASE_URL must be set by global setup").toBeTruthy();

    const tableCount = await runMigrations(databaseUrl ?? "");
    expect(tableCount).toBeGreaterThan(0);
  });

  describe("/healthz", () => {
    const getApp = useTestApp();
    it("returns 200 from a built app", async () => {
      const res = await getApp().inject({ method: "GET", url: "/healthz" });
      expect(res.statusCode).toBe(200);
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetBootstrapState();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("withTimeout", () => {
    it("resolves when the inner promise resolves first", async () => {
      const result = await withTimeout(Promise.resolve(42), 1_000, "fast");
      expect(result).toBe(42);
    });

    it("rejects with a stage-tagged message when the inner promise hangs", async () => {
      const neverResolves = new Promise<number>(() => {});
      await expect(withTimeout(neverResolves, 50, "stuck")).rejects.toThrow(
        /bootstrap stage "stuck" timed out after 50ms/,
      );
    });

    it("clears the timer when the inner promise rejects fast", async () => {
      // Regression guard: a leaked setTimeout would keep the event loop alive.
      // We don't directly observe the timer, but the rejection must propagate
      // without waiting for the timeout fire.
      const t0 = Date.now();
      await expect(withTimeout(Promise.reject(new Error("boom")), 5_000, "early-fail")).rejects.toThrow("boom");
      expect(Date.now() - t0).toBeLessThan(500);
    });
  });

  describe("runStage", () => {
    it("records done status with duration on success", async () => {
      const result = await runStage("test-success", async () => "ok", 1_000);
      expect(result).toBe("ok");
      const stage = bootstrapState.stages["test-success"];
      expect(stage?.status).toBe("done");
      expect(stage?.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("records failed status with error message on throw", async () => {
      await expect(
        runStage(
          "test-throw",
          async () => {
            throw new Error("boom");
          },
          1_000,
        ),
      ).rejects.toThrow("boom");
      const stage = bootstrapState.stages["test-throw"];
      expect(stage?.status).toBe("failed");
      expect(stage?.error).toBe("boom");
    });

    it("records failed status with timeout error when stage hangs", async () => {
      await expect(runStage("test-hang", () => new Promise(() => {}), 30)).rejects.toThrow(
        /bootstrap stage "test-hang" timed out after 30ms/,
      );
      const stage = bootstrapState.stages["test-hang"];
      expect(stage?.status).toBe("failed");
      expect(stage?.error).toMatch(/timed out/);
    });
  });

  describe("bootstrap-state", () => {
    it("markStage merges patches onto existing entries", () => {
      markStage("merge-test", { status: "in_progress" });
      markStage("merge-test", { durationMs: 12 });
      const stage = bootstrapState.stages["merge-test"];
      expect(stage?.status).toBe("in_progress");
      expect(stage?.durationMs).toBe(12);
    });

    it("markReady sets readyAt", () => {
      bootstrapState.readyAt = null;
      markReady();
      expect(bootstrapState.readyAt).toBeInstanceOf(Date);
    });
  });
});
