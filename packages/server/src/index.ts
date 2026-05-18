import { randomUUID } from "node:crypto";
import { initConfig, serverConfigSchema } from "@agent-team-foundation/first-tree-hub-shared/config";
import { buildApp } from "./app.js";
import { markReady } from "./bootstrap-state.js";
import { runStage } from "./bootstrap-utils.js";
import type { Config } from "./config.js";
import { runMigrations } from "./db/migrate.js";
import { applyLoggerConfig, createLogger, initTelemetry, shutdownTelemetry, withSpan } from "./observability/index.js";

const log = createLogger("Bootstrap");

async function main() {
  const serverConfig = await initConfig({
    schema: serverConfigSchema,
    role: "server",
  });

  // Apply logger config first so bootstrap logs use the right level / format.
  applyLoggerConfig({
    level: serverConfig.observability.logging.level,
    format: serverConfig.observability.logging.format,
    bridgeToSpanLevel: serverConfig.observability.logging.bridgeToSpanLevel,
  });

  // Boot-time config validation (publicUrl + GitHub App config shape)
  // lives in `buildApp` / `boot-guards.ts`.

  const webDistPath = process.env.FIRST_TREE_HUB_WEB_DIST_PATH;
  const config: Config = {
    ...serverConfig,
    instanceId: `srv_${randomUUID().slice(0, 8)}`,
    webDistPath: webDistPath && webDistPath.length > 0 ? webDistPath : undefined,
  };

  // Initialize telemetry before anything else — spans emitted during app
  // bootstrap (e.g. notifier.start) will then be captured. instanceId is
  // carried as service.instance.id so replicas are distinguishable in the
  // trace backend.
  await runStage("initTelemetry", () => initTelemetry(serverConfig.observability.tracing, config.instanceId), 10_000);

  // Wrap post-telemetry stages in a `server.bootstrap` root span so Logfire
  // shows a single bootstrap flamegraph. `initTelemetry` itself can't be
  // traced — it's the call that wires up the tracer — and is covered by the
  // stage logs instead. See server-bootstrap-resilience-design.md §3 (T8).
  const app = await withSpan("server.bootstrap", { "service.instance.id": config.instanceId }, async () => {
    // Run Drizzle migrations before the app comes up. Idempotent under
    // multi-replica startup (Drizzle journal table); cold-start cost is
    // a few hundred ms when there's nothing new to apply.
    const tableCount = await runStage("runMigrations", () => runMigrations(serverConfig.database.url), 60_000);
    log.info({ tableCount }, "migrations applied");

    const built = await runStage("buildApp", () => buildApp(config), 30_000);
    await runStage("appListen", () => built.listen({ host: config.server.host, port: config.server.port }), 10_000);
    return built;
  });
  markReady();
  log.info(`server listening on http://${config.server.host}:${config.server.port}`);

  const shutdown = async (signal: string) => {
    log.info(`received ${signal}, shutting down`);
    try {
      await app.close();
    } finally {
      await shutdownTelemetry();
      process.exit(0);
    }
  };
  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

main().catch((err) => {
  const bootLog = createLogger("Bootstrap");
  bootLog.fatal({ err }, "failed to start server");
  process.exit(1);
});
