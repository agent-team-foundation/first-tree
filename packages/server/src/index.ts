import { randomUUID } from "node:crypto";
import { initConfig, serverConfigSchema } from "@agent-team-foundation/first-tree-hub-shared/config";
import { buildApp } from "./app.js";
import type { Config } from "./config.js";
import { runMigrations } from "./db/migrate.js";
import { applyLoggerConfig, createLogger, initTelemetry, shutdownTelemetry } from "./observability/index.js";

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
  await initTelemetry(serverConfig.observability.tracing, config.instanceId);

  // Run Drizzle migrations before the app comes up. Idempotent under
  // multi-replica startup (Drizzle journal table); cold-start cost is
  // a few hundred ms when there's nothing new to apply.
  const tableCount = await runMigrations(serverConfig.database.url);
  log.info({ tableCount }, "migrations applied");

  const app = await buildApp(config);
  await app.listen({ host: config.server.host, port: config.server.port });
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
