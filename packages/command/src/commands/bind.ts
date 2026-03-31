import type { Command } from "commander";
import { fail, success } from "../cli/output.js";
import { resolveServerUrl } from "../core/bootstrap.js";
import { bindFeishuBot, bindFeishuUser, searchFeishuUsers } from "../core/feishu.js";

function resolveAgentToken(): string {
  const token = process.env.FIRST_TREE_HUB_TOKEN;
  if (!token) {
    fail("MISSING_TOKEN", "FIRST_TREE_HUB_TOKEN environment variable is required.", 2);
  }
  return token;
}

export function registerBindCommands(program: Command): void {
  // bind-bot: self-service Feishu bot binding
  program
    .command("bind-bot")
    .description("Bind a Feishu bot to this agent (self-service)")
    .requiredOption("--platform <platform>", "Platform: feishu")
    .requiredOption("--app-id <id>", "Feishu bot App ID")
    .requiredOption("--app-secret <secret>", "Feishu bot App Secret")
    .option("--server <url>", "Hub server URL")
    .action(async (options: { platform: string; appId: string; appSecret: string; server?: string }) => {
      try {
        if (options.platform !== "feishu") {
          fail("UNSUPPORTED_PLATFORM", `Platform "${options.platform}" is not supported. Use "feishu".`);
        }

        const serverUrl = resolveServerUrl(options.server);
        const token = resolveAgentToken();
        await bindFeishuBot(serverUrl, token, options.appId, options.appSecret);
        process.stderr.write("Feishu bot bound successfully.\n");
        success({ platform: "feishu", bound: true });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        fail("BIND_BOT_ERROR", msg);
      }
    });

  // bind-user: delegate Feishu user binding
  program
    .command("bind-user <humanAgentId>")
    .description("Bind a Feishu user to a human agent (via delegate_mention)")
    .requiredOption("--platform <platform>", "Platform: feishu")
    .option("--feishu-id <id>", "Feishu user ID (ou_xxx) — direct binding")
    .option("--search <name>", "Search Feishu user by name")
    .option("--select <n>", "Select from search results", Number)
    .option("--server <url>", "Hub server URL")
    .action(
      async (
        humanAgentId: string,
        options: { platform: string; feishuId?: string; search?: string; select?: number; server?: string },
      ) => {
        try {
          if (options.platform !== "feishu") {
            fail("UNSUPPORTED_PLATFORM", `Platform "${options.platform}" is not supported. Use "feishu".`);
          }

          const serverUrl = resolveServerUrl(options.server);
          const token = resolveAgentToken();

          if (options.feishuId) {
            // Direct binding
            await bindFeishuUser(serverUrl, token, humanAgentId, options.feishuId);
            process.stderr.write(`Feishu user ${options.feishuId} bound to ${humanAgentId}.\n`);
            success({ platform: "feishu", humanAgentId, feishuUserId: options.feishuId });
            return;
          }

          if (options.search) {
            // Search and optionally select
            const result = await searchFeishuUsers(serverUrl, token, options.search);
            if (result.users.length === 0) {
              fail("NO_RESULTS", `No Feishu users found for "${options.search}".`);
            }

            if (options.select !== undefined) {
              const idx = options.select - 1;
              const selected = result.users[idx];
              if (!selected) {
                fail("INVALID_SELECT", `Invalid selection: ${options.select}. Available: 1-${result.users.length}`);
              }
              await bindFeishuUser(serverUrl, token, humanAgentId, selected.userId, selected.name);
              process.stderr.write(`Feishu user bound: ${selected.name} (${selected.userId}) → ${humanAgentId}\n`);
              success({ platform: "feishu", humanAgentId, feishuUserId: selected.userId, name: selected.name });
              return;
            }

            // Print results for user/agent to pick
            process.stderr.write(`Feishu user search results for "${options.search}":\n`);
            for (const [i, u] of result.users.entries()) {
              process.stderr.write(`  ${i + 1}. ${u.name} (${u.userId}) ${u.department ?? ""}\n`);
            }
            process.stderr.write("\nUse --select <n> to confirm binding.\n");
            success({ platform: "feishu", humanAgentId, searchResults: result.users });
            return;
          }

          fail("MISSING_PARAMS", "Provide --feishu-id <id> or --search <name> to bind a Feishu user.");
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          fail("BIND_USER_ERROR", msg);
        }
      },
    );
}
