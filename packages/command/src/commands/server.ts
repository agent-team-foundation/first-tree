import { initConfig, serverConfigSchema } from "@first-tree-hub/shared/config";
import type { Command } from "commander";
import {
  checkContextTreeRepo,
  checkDatabase,
  checkDocker,
  checkGitHubToken,
  checkNodeVersion,
  checkServerConfig,
  checkServerHealth,
  createAdminUser,
  printResults,
  runMigrations,
  startServer,
  stopPostgres,
} from "../core/index.js";

export function registerServerCommands(program: Command): void {
  const server = program.command("server").description("Manage First Tree Hub server");

  server
    .command("start")
    .description("Start the server (auto-provisions PostgreSQL if needed)")
    .option("--port <number>", "Server port (default: 8000)", Number.parseInt)
    .option("--host <address>", "Bind address (default: 127.0.0.1)")
    .option("--database-url <url>", "Use an existing PostgreSQL (skip Docker)")
    .option("--no-interactive", "Skip interactive prompts (for Docker/CI)")
    .action(async (options: { port?: number; host?: string; databaseUrl?: string; interactive?: boolean }) => {
      try {
        await startServer({ ...options, noInteractive: options.interactive === false });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        process.stderr.write(`\n  Error: ${msg}\n\n`);
        process.exit(1);
      }
    });

  server
    .command("stop")
    .description("Stop the managed PostgreSQL container")
    .action(() => {
      const stopped = stopPostgres();
      if (stopped) {
        process.stderr.write("  PostgreSQL container stopped.\n");
      } else {
        process.stderr.write("  No managed PostgreSQL container found.\n");
      }
    });

  server
    .command("doctor")
    .description("Check server environment readiness")
    .action(async () => {
      process.stderr.write("\n  First Tree Hub Server Doctor\n\n");
      const results = [
        checkNodeVersion(),
        checkDocker(),
        checkServerConfig(),
        await checkDatabase(),
        await checkGitHubToken(),
        await checkContextTreeRepo(),
        await checkServerHealth(),
      ];
      printResults(results);
    });

  server
    .command("status")
    .description("Show server health and status")
    .action(async () => {
      // P0: simple health check against local server
      const url = process.env.FIRST_TREE_HUB_SERVER_URL ?? "http://localhost:8000";
      try {
        const res = await fetch(`${url}/api/v1/health`);
        if (res.ok) {
          const data = await res.json();
          console.log(JSON.stringify(data, null, 2));
        } else {
          process.stderr.write(`  Server returned ${res.status}\n`);
          process.exit(1);
        }
      } catch {
        process.stderr.write(`  Cannot connect to ${url}\n`);
        process.exit(1);
      }
    });

  // ── Database management ─────────────────────────────────────────────

  server
    .command("db:migrate")
    .description("Run database migrations")
    .action(async () => {
      try {
        const config = await initConfig({ schema: serverConfigSchema, role: "server" });
        const tableCount = await runMigrations(config.database.url);
        process.stderr.write(`  Migrations complete (${tableCount} tables)\n`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        process.stderr.write(`  Error: ${msg}\n`);
        process.exit(1);
      }
    });

  // ── Admin management ────────────────────────────────────────────────

  server
    .command("admin:create")
    .description("Create an admin user")
    .option("-u, --username <name>", "Admin username", "admin")
    .option("-p, --password <pass>", "Admin password (auto-generated if omitted)")
    .action(async (options: { username: string; password?: string }) => {
      try {
        const config = await initConfig({ schema: serverConfigSchema, role: "server" });
        const result = await createAdminUser(config.database.url, options.username, options.password);

        process.stderr.write(`  Admin user "${result.username}" created.\n`);
        if (!options.password) {
          process.stderr.write(`  Password: ${result.password}  (save this — shown only once)\n`);
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        process.stderr.write(`  Error: ${msg}\n`);
        process.exit(1);
      }
    });
}
