import { initConfig, serverConfigSchema } from "@first-tree-core/shared/config";
import type { Command } from "commander";
import { createAdminUser } from "../server/admin.js";

export function registerAdminCommands(program: Command): void {
  const admin = program.command("admin").description("Admin user management");

  admin
    .command("create")
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
