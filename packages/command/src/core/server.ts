import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerConfig } from "@agent-team-foundation/first-tree-hub-shared/config";
import { initConfig, serverConfigSchema } from "@agent-team-foundation/first-tree-hub-shared/config";
import { buildApp } from "@first-tree-hub/server";
import type { Config } from "@first-tree-hub/server/config";
import type { FastifyInstance } from "fastify";
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

export type ServerBootstrapResult = {
  app: FastifyInstance;
  config: Config;
  shutdownTelemetry: () => Promise<void>;
};

/**
 * Run install-time orchestration (Pattern B / Q11):
 *
 *   1. Schema-driven prompts for missing required fields
 *   2. Provision Postgres (or reuse) via the docker-pg auto-generator
 *   3. Apply Drizzle migrations
 *
 * Used by `start --service` (Phase 1b), which hands off binding/listening
 * to the daemon — and by `bootstrapServer`, which wraps this and adds the
 * fastify build for foreground / `server start` callers.
 */
export async function prepareInstallTime(options: StartOptions): Promise<ServerConfig> {
  const cliArgs: Record<string, unknown> = {};
  if (options.port !== undefined) cliArgs.server = { port: options.port };
  if (options.host !== undefined) {
    cliArgs.server = { ...(cliArgs.server as Record<string, unknown> | undefined), host: options.host };
  }
  if (options.databaseUrl !== undefined) {
    cliArgs.database = { url: options.databaseUrl, provider: "external" };
  }

  await promptMissingFields({
    schema: serverConfigSchema as Record<string, unknown>,
    role: "server",
    cliArgs,
    noInteractive: options.noInteractive,
  });

  const autoGenerators = {
    "docker-pg": async () => {
      if (!isDockerAvailable()) {
        throw new Error(
          "Docker is not available.\n\n" +
            "  First Tree Hub needs PostgreSQL. Two options:\n\n" +
            "  1. Install Docker → https://docs.docker.com/get-docker/\n" +
            "     Then re-run: first-tree-hub start\n\n" +
            "  2. Provide an existing PostgreSQL URL:\n" +
            "     first-tree-hub start --database-url postgresql://user:pass@host:5432/db",
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

  status("Database", "running migrations...");
  const tableCount = await runMigrations(serverConfig.database.url);
  status("Database", `initialized (${tableCount} tables)`);

  return serverConfig;
}

/**
 * Build the server up to the point of `app.listen()` without actually
 * binding the port.
 *
 * The new `first-tree-hub start` command needs to perform the same
 * orchestration the legacy `server start` did (Docker, Postgres, migrations,
 * Web dist resolution, telemetry init, fastify build), but it also wants to
 * embed its own `ClientRuntime` against the same process before yielding to
 * `app.listen()`. Splitting the two phases lets the caller insert that step
 * cleanly — and lets a future daemon caller skip re-running install-time
 * work entirely (Pattern B / Q11). `startServer` below is now a thin wrapper
 * preserved for backward compatibility with the existing `server start`
 * command and external Hub consumers (e.g. context-tree).
 */
export async function bootstrapServer(options: StartOptions): Promise<ServerBootstrapResult> {
  const serverConfig = await prepareInstallTime(options);

  const webDistPath = resolveWebDist();
  if (webDistPath) {
    status("Web", `serving from ${webDistPath}`);
  } else {
    status("Web", "not available (web package not found)");
  }

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

  return { app, config, shutdownTelemetry };
}

/**
 * Full server start orchestration:
 * 1. bootstrapServer: prompts, Postgres, migrations, telemetry, buildApp
 * 2. Wire SIGINT/SIGTERM
 * 3. app.listen()
 */
export async function startServer(options: StartOptions): Promise<void> {
  print.line(`\n  First Tree Hub v${COMMAND_VERSION}\n\n`);

  const { app, config, shutdownTelemetry } = await bootstrapServer(options);

  // Graceful shutdown
  const shutdown = async () => {
    print.line("\n  Shutting down...\n");
    try {
      await app.close();
    } finally {
      await shutdownTelemetry();
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

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
