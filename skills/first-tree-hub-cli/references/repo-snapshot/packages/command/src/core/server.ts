import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "@first-tree-hub/server";
import type { Config } from "@first-tree-hub/server/config";
import { initConfig, serverConfigSchema } from "@first-tree-hub/shared/config";
import { createAdminUser, hasAdminUser } from "./admin.js";
import { ensurePostgres, isDockerAvailable } from "./docker-postgres.js";
import { runMigrations } from "./migrate.js";
import { blank, status } from "./output.js";
import { promptMissingFields } from "./prompt.js";

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
  process.stderr.write("\n  First Tree Hub v0.1.0\n\n");

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

  // 5. Check/create admin
  const hasAdmin = await hasAdminUser(serverConfig.database.url);
  if (!hasAdmin) {
    const envPassword = process.env.FIRST_TREE_HUB_ADMIN_PASSWORD;
    const admin = await createAdminUser(serverConfig.database.url, "admin", envPassword || undefined);
    status("Admin", "created");
    blank();
    status("  Username:", admin.username);
    if (envPassword) {
      status("  Password:", "(set via FIRST_TREE_HUB_ADMIN_PASSWORD)");
    } else {
      status("  Password:", `${admin.password}  (save this — shown only once)`);
    }
    blank();
  } else {
    status("Admin", "exists");
  }

  // 6. Resolve web dist (build if needed)
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
    logger: true,
  };

  const app = await buildApp(config);

  // Graceful shutdown
  const shutdown = async () => {
    process.stderr.write("\n  Shutting down...\n");
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  await app.listen({ host: config.server.host, port: config.server.port });

  blank();
  status("Server", `running at http://${config.server.host}:${config.server.port}`);
  blank();
  process.stderr.write("  Open the URL above in your browser to get started.\n");
  process.stderr.write("  Press Ctrl+C to stop.\n\n");
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
