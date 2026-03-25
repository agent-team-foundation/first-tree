import { initConfig, serverConfigSchema } from "@agent-hub/shared/config";
import type { Command } from "commander";
import { runMigrations } from "../server/migrate.js";

export function registerDbCommands(program: Command): void {
  const db = program.command("db").description("Database management");

  db.command("migrate")
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
}
