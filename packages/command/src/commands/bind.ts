import type { Command } from "commander";
import { fail, success } from "../cli/output.js";
import { resolveAgentToken, resolveServerUrl } from "../core/bootstrap.js";
import { bindFeishuBot, bindFeishuUser } from "../core/feishu.js";

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
    .requiredOption("--feishu-id <id>", "Feishu user ID (ou_xxx)")
    .option("--server <url>", "Hub server URL")
    .action(async (humanAgentId: string, options: { platform: string; feishuId: string; server?: string }) => {
      try {
        if (options.platform !== "feishu") {
          fail("UNSUPPORTED_PLATFORM", `Platform "${options.platform}" is not supported. Use "feishu".`);
        }

        const serverUrl = resolveServerUrl(options.server);
        const token = resolveAgentToken();
        await bindFeishuUser(serverUrl, token, humanAgentId, options.feishuId);
        process.stderr.write(`Feishu user ${options.feishuId} bound to ${humanAgentId}.\n`);
        success({ platform: "feishu", humanAgentId, feishuUserId: options.feishuId });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        fail("BIND_USER_ERROR", msg);
      }
    });
}
