import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { initConfig, serverConfigSchema } from "@agent-team-foundation/first-tree-hub-shared/config";
import { buildApp } from "@first-tree-hub/server";
import type { Config } from "@first-tree-hub/server/config";
import { ensurePostgres, isDockerAvailable } from "./docker-postgres.js";
import { runMigrations } from "./migrate.js";
import { blank, print, status } from "./output.js";
import { promptMissingFields } from "./prompt.js";
import { COMMAND_VERSION } from "./version.js";

export type StartOptions = {
  port?: number;
  host?: string;
  databaseUrl?: string;
  noInteractive?: boolean;
};

/**
 * Full server start orchestration:
 * 1. Prompt for missing required config (schema-driven)
 * 2. Load config (CLI args > env > YAML > auto-gen > defaults)
 * 3. Provision PostgreSQL if needed
 * 4. Run database migrations
 * 5. Create default admin if none exists
 * 6. Resolve web dist
 * 7. Start Fastify server
 */
export async function startServer(options: StartOptions): Promise<void> {
  print.line(`\n  First Tree Hub v${COMMAND_VERSION}\n\n`);

  // 1. Build CLI args
  const cliArgs: Record<string, unknown> = {};
  if (options.port !== undefined) cliArgs.server = { port: options.port };
  if (options.host !== undefined) {
    cliArgs.server = { ...(cliArgs.server as Record<string, unknown> | undefined), host: options.host };
  }
  if (options.databaseUrl !== undefined) {
    cliArgs.database = { url: options.databaseUrl, provider: "external" };
  }

  // 2. Schema-driven interactive prompts for missing required fields
  await promptMissingFields({
    schema: serverConfigSchema as Record<string, unknown>,
    role: "server",
    cliArgs,
    noInteractive: options.noInteractive,
  });

  // 3. docker-pg auto generator
  const autoGenerators = {
    "docker-pg": async () => {
      if (!isDockerAvailable()) {
        throw new Error(
          "Docker is not available.\n\n" +
            "  First Tree Hub needs PostgreSQL. Two options:\n\n" +
            "  1. Install Docker → https://docs.docker.com/get-docker/\n" +
            "     Then re-run: first-tree-hub server start\n\n" +
            "  2. Provide an existing PostgreSQL URL:\n" +
            "     first-tree-hub server start --database-url postgresql://user:pass@host:5432/db",
        );
      }
      status("PostgreSQL", "starting via Docker...");
      const result = ensurePostgres(undefined);
      if (result.containerCreated) {
        status("PostgreSQL", `container created (port ${result.port})`);
      } else {
        status("PostgreSQL", `reusing existing container (port ${result.port})`);
      }
      return result.url;
    },
  };

  const serverConfig = await initConfig({
    schema: serverConfigSchema,
    role: "server",
    cliArgs,
    autoGenerators,
  });

  status("PostgreSQL", "ready");

  // 4. Run migrations
  status("Database", "running migrations...");
  const tableCount = await runMigrations(serverConfig.database.url);
  status("Database", `initialized (${tableCount} tables)`);

  // 5. Resolve web dist (build if needed)
  const webDistPath = resolveWebDist();
  if (webDistPath) {
    status("Web", `serving from ${webDistPath}`);
  } else {
    status("Web", "not available (web package not found)");
  }

  // 7. Start Fastify
  const config: Config = {
    ...serverConfig,
    webDistPath: webDistPath ?? undefined,
    instanceId: `srv_${randomUUID().slice(0, 8)}`,
    commandVersion: COMMAND_VERSION,
  };

  // Initialize telemetry from resolved config before server bootstrap, so that
  // spans emitted during migrations / hot-reload are captured. instanceId is
  // passed as service.instance.id so replicas of the same service are
  // distinguishable in the trace backend.
  const { initTelemetry, shutdownTelemetry } = await import("@first-tree-hub/server/observability");
  await initTelemetry(serverConfig.observability.tracing, config.instanceId);

  const app = await buildApp(config);

  // Graceful shutdown — bounded to keep Docker / k8s from having to SIGKILL.
  //
  // Default Docker `--time` is 10s and the typical k8s `terminationGracePeriodSeconds`
  // is 30s; if `app.close()` (waiting on in-flight HTTP / WS / PG queries) or
  // `shutdownTelemetry()` (flushing OTel spans over HTTP to the logfire
  // endpoint) hangs, the orchestrator escalates to SIGKILL — losing in-flight
  // HTTP/WS frames, leaving PG transactions un-rolled-back, dropping the
  // span buffer. The hard ceiling below force-exits the process before that
  // happens, so even a network-stalled telemetry flush can't run past Docker's
  // grace window.
  //
  // Re-entry guard: SIGINT/SIGTERM may fire repeatedly during shutdown
  // (e.g. user mashes ctrl+c). Without the guard, the second invocation
  // races with the first and process.exit(0) lands non-deterministically.
  // The guard makes the second signal a no-op: we are already trying to
  // exit cleanly, and the force-timer covers the worst case.
  const SHUTDOWN_FORCE_EXIT_MS = 8_000;
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    print.line(`\n  Shutting down (${signal})...\n`);

    const forceTimer = setTimeout(() => {
      print.line(`\n  Shutdown exceeded ${SHUTDOWN_FORCE_EXIT_MS}ms — forcing exit.\n`);
      process.exit(1);
    }, SHUTDOWN_FORCE_EXIT_MS);
    forceTimer.unref();

    try {
      await app.close();
    } catch (err) {
      print.line(`  app.close() failed: ${err instanceof Error ? err.message : String(err)}\n`);
    }
    try {
      await shutdownTelemetry();
    } catch {
      // shutdownTelemetry already swallows exporter errors internally; nothing more to do.
    }
    clearTimeout(forceTimer);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ host: config.server.host, port: config.server.port });

  blank();
  status("Server", `running at http://${config.server.host}:${config.server.port}`);
  blank();
  print.line("  Open the URL above in your browser to get started.\n");
  print.line("  Press Ctrl+C to stop.\n\n");
}

/**
 * Resolve web dist path.
 * 1. npm install: embedded at dist/web/ (relative to the built CLI)
 * 2. Monorepo dev: resolved from @first-tree-hub/web package (builds if needed)
 */
function resolveWebDist(): string | undefined {
  // npm publish: web assets are embedded next to the built CLI
  const cliDir = dirname(fileURLToPath(import.meta.url));
  const embeddedPath = join(cliDir, "..", "web");
  if (existsSync(join(embeddedPath, "index.html"))) return embeddedPath;

  // Monorepo dev: resolve from web package
  try {
    const webPkgUrl = import.meta.resolve("@first-tree-hub/web/package.json");
    const webDir = dirname(fileURLToPath(webPkgUrl));
    const distPath = join(webDir, "dist");
    const indexPath = join(distPath, "index.html");

    if (existsSync(indexPath)) {
      return distPath;
    }

    // dist not built — build it
    status("Web", "building...");
    execSync("pnpm --filter @first-tree-hub/web build", {
      stdio: ["ignore", "ignore", "pipe"],
      cwd: join(webDir, "../.."),
    });

    if (existsSync(indexPath)) {
      return distPath;
    }
  } catch {
    // @first-tree-hub/web not available
  }
  return undefined;
}
