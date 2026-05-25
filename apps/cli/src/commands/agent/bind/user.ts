import type { Command } from "commander";
import { fail, success } from "../../../cli/output.js";
import { ensureFreshAccessToken, resolveServerUrl } from "../../../core/bootstrap.js";
import { bindFeishuUser } from "../../../core/feishu.js";
import { print } from "../../../core/output.js";
import { resolveLocalAgent } from "../../_shared/local-agent.js";

export function registerAgentBindUserCommand(bind: Command): void {
  bind
    .command("user <humanAgentId>")
    .description("Bind a Feishu user to a human agent (via delegate_mention)")
    .requiredOption("--platform <platform>", "Platform: feishu")
    .requiredOption("--feishu-id <id>", "Feishu user ID (ou_xxx)")
    .option("--agent <name>", "Agent name on the Hub (default: first configured on this client)")
    .option("--server <url>", "Hub server URL")
    .action(
      async (
        humanAgentId: string,
        options: { platform: string; feishuId: string; agent?: string; server?: string },
      ) => {
        try {
          if (options.platform !== "feishu") {
            fail("UNSUPPORTED_PLATFORM", `Platform "${options.platform}" is not supported. Use "feishu".`);
          }

          const serverUrl = resolveServerUrl(options.server);
          const { agentId } = resolveLocalAgent(options.agent);
          const accessToken = await ensureFreshAccessToken();
          await bindFeishuUser(serverUrl, accessToken, agentId, humanAgentId, options.feishuId);
          print.line(`Feishu user ${options.feishuId} bound to ${humanAgentId}.\n`);
          success({ platform: "feishu", humanAgentId, feishuUserId: options.feishuId });
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          fail("BIND_USER_ERROR", msg);
        }
      },
    );
}
