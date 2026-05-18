import { randomUUID } from "node:crypto";
import { initConfig, serverConfigSchema } from "@agent-team-foundation/first-tree-hub-shared/config";
import { buildApp } from "./app.js";
import { markReady } from "./bootstrap-state.js";
import { runStage } from "./bootstrap-utils.js";
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
  await runStage("initTelemetry", () => initTelemetry(serverConfig.observability.tracing, config.instanceId), 10_000);

  // Bootstrap stages run at the ROOT OTel context — no enclosing span. An
  // earlier version wrapped this block in `withSpan("server.bootstrap", …)`
  // so Logfire would show a single bootstrap flamegraph, but AsyncLocalStorage
  // propagates that span as the active context into every timer / event
  // listener registered during `appListen` (notifier LISTEN handlers,
  // `setInterval` background tasks, the net.Server's `connection` event
  // chain). The result: every HTTP root span, ws.connection span, and
  // background-task span across the process lifetime parents under that one
  // ended span, collapsing the trace UI into a single bootstrap branch.
  // Per-stage signals live in the structured `bootstrap.stage.{start,done,
  // failed}` logs emitted by `runStage`, which are sufficient for boot
  // analysis without dragging a context onto every downstream span.

  // Run Drizzle migrations before the app comes up. Idempotent under
  // multi-replica startup (Drizzle journal table); cold-start cost is a few
  // hundred ms when there's nothing new to apply. The 20s budget matches
  // the Dockerfile HEALTHCHECK start-period so a migration that truly
  // exceeds it fails the boot fast rather than letting docker judge
  // unhealthy mid-migration. If a future migration is known to run longer,
  // raise both this and the HEALTHCHECK start-period together.
  const tableCount = await runStage("runMigrations", () => runMigrations(serverConfig.database.url), 20_000);
  log.info({ tableCount }, "migrations applied");

  const app = await runStage("buildApp", () => buildApp(config), 30_000);
  await runStage("appListen", () => app.listen({ host: config.server.host, port: config.server.port }), 10_000);
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
