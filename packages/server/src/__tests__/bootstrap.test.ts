import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerConfig } from "@first-tree/shared/config";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  growth: { landingPagesEnabled: false },
  database: { url: process.env.DATABASE_URL ?? "", provider: "external" },
  server: { port: 0, host: "127.0.0.1", publicUrl: "https://first-tree.example" },
  workspace: { root: "/tmp/first-tree-test-workspaces" },
  secrets: {
    jwtSecret: "test-jwt-secret-key-for-vitest",
    encryptionKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  },
  auth: { accessTokenExpiry: "30m", refreshTokenExpiry: "30d", connectTokenExpiry: "10m" },
  trustProxy: false,
  connectBootstrap: {
    method: "npm",
    portableDownloadBaseUrl: "https://downloads.first-tree.ai",
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
