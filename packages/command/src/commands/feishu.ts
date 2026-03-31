import type { Command } from "commander";
import { fail, success } from "../cli/output.js";
import { resolveServerUrl } from "../core/bootstrap.js";
import { searchFeishuUsers } from "../core/feishu.js";

function resolveAgentToken(): string {
  const token = process.env.FIRST_TREE_HUB_TOKEN;
  if (!token) {
    fail("MISSING_TOKEN", "FIRST_TREE_HUB_TOKEN environment variable is required.", 2);
  }
  return token;
}

export function registerFeishuCommands(program: Command): void {
  const feishu = program.command("feishu").description("Feishu operations");

  feishu
    .command("search <query>")
    .description("Search Feishu users by name, email, or mobile")
    .option("--by <field>", "Search field: name | email | mobile", "name")
    .option("--json", "Output as JSON")
    .option("--server <url>", "Hub server URL")
    .action(async (query: string, options: { by: string; json?: boolean; server?: string }) => {
      try {
        const serverUrl = resolveServerUrl(options.server);
        const token = resolveAgentToken();
        const result = await searchFeishuUsers(serverUrl, token, query, options.by as "name" | "email" | "mobile");

        if (options.json) {
          success(result);
          return;
        }

        if (result.users.length === 0) {
          process.stderr.write(`No users found for "${query}".\n`);
          return;
        }

        process.stderr.write(`Feishu users matching "${query}":\n\n`);
        process.stderr.write("  #  Name                 User ID              Department\n");
        process.stderr.write("  ─  ────                 ───────              ──────────\n");
        for (const [i, u] of result.users.entries()) {
          const num = String(i + 1).padStart(2);
          const name = (u.name ?? "").padEnd(20);
          const id = (u.userId ?? "").padEnd(20);
          process.stderr.write(`  ${num} ${name} ${id} ${u.department ?? ""}\n`);
        }
        process.stderr.write("\n");
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        fail("FEISHU_SEARCH_ERROR", msg);
      }
    });
}
