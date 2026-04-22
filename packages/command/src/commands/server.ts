import { initConfig, serverConfigSchema } from "@agent-team-foundation/first-tree-hub-shared/config";
import type { Command } from "commander";
import {
  checkDatabase,
  checkDocker,
  checkNodeVersion,
  checkServerConfig,
  checkServerHealth,
  createOwner,
  printResults,
  runMigrations,
  startServer,
  stopPostgres,
} from "../core/index.js";
import { print } from "../core/output.js";

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
        print.line(`\n  Error: ${msg}\n\n`);
        process.exit(1);
      }
    });

  server
    .command("stop")
    .description("Stop the managed PostgreSQL container")
    .action(() => {
      try {
        const stopped = stopPostgres();
        if (stopped) {
          print.line("  PostgreSQL container stopped.\n");
        } else {
          print.line("  No managed PostgreSQL container found.\n");
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        print.line(`  Error stopping PostgreSQL: ${msg}\n`);
        process.exit(1);
      }
    });

  server
    .command("doctor")
    .description("Check server environment readiness")
    .action(async () => {
      print.line("\n  First Tree Hub Server Doctor\n\n");
      const results = [
        checkNodeVersion(),
        checkDocker(),
        checkServerConfig(),
        await checkDatabase(),
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
          // Emit the raw /api/v1/health payload — existing scripts consume
          // `first-tree-hub server status | jq '.status'` and would break if
          // we wrapped it in the `{ok, data}` envelope. The body is already
          // JSON, so this is safe for both human and `--json` consumers.
          process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
        } else {
          print.line(`  Server returned ${res.status}\n`);
          process.exit(1);
        }
      } catch {
        print.line(`  Cannot connect to ${url}\n`);
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
        print.line(`  Migrations complete (${tableCount} tables)\n`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        print.line(`  Error: ${msg}\n`);
        process.exit(1);
      }
    });

  // ── Admin management ────────────────────────────────────────────────

  server
    .command("admin:create")
    .description("Create an admin user with organization")
    .option("-u, --username <name>", "Admin username", "admin")
    .option("-n, --name <name>", "Display name", "Admin")
    .option("-o, --org <org>", "Organization slug", "default")
    .option("-p, --password <pass>", "Password (auto-generated if omitted)")
    .action(async (options: { username: string; name: string; org: string; password?: string }) => {
      try {
        const config = await initConfig({ schema: serverConfigSchema, role: "server" });
        const result = await createOwner(
          config.database.url,
          options.username,
          options.org,
          options.name,
          options.password,
        );

        print.line(`  Admin user "${result.username}" created.\n`);
        if (!options.password) {
          print.line(`  Password: ${result.password}  (save this — shown only once)\n`);
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        print.line(`  Error: ${msg}\n`);
        process.exit(1);
      }
    });
}
