import type { Command } from "commander";
import { fail, success } from "../../../cli/output.js";
import { ensureFreshAccessToken, resolveServerUrl } from "../../../core/bootstrap.js";
import { bindFeishuBot } from "../../../core/feishu.js";
import { print } from "../../../core/output.js";
import { resolveLocalAgent } from "../../_shared/local-agent.js";

export function registerAgentBindBotCommand(bind: Command): void {
  bind
    .command("bot")
    .description("Bind a Feishu bot to this agent (self-service)")
    .requiredOption("--platform <platform>", "Platform: feishu")
    .requiredOption("--app-id <id>", "Feishu bot App ID")
    .requiredOption("--app-secret <secret>", "Feishu bot App Secret")
    .option("--agent <name>", "Agent name on the Hub (default: first configured on this client)")
    .option("--server <url>", "Hub server URL")
    .action(
      async (options: { platform: string; appId: string; appSecret: string; agent?: string; server?: string }) => {
        try {
          if (options.platform !== "feishu") {
            fail("UNSUPPORTED_PLATFORM", `Platform "${options.platform}" is not supported. Use "feishu".`);
          }

          const serverUrl = resolveServerUrl(options.server);
          const { agentId } = resolveLocalAgent(options.agent);
          const accessToken = await ensureFreshAccessToken();
          await bindFeishuBot(serverUrl, accessToken, agentId, options.appId, options.appSecret);
          print.line("Feishu bot bound successfully.\n");
          success({ platform: "feishu", bound: true });
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          fail("BIND_BOT_ERROR", msg);
        }
      },
    );
}
