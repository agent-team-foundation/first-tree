import type { Command } from "commander";
import { success } from "../../cli/output.js";
import { createSdk } from "../_shared/local-agent.js";
import { handleCronSdkError, requireCronChatId } from "./_shared.js";

interface ListOptions {
  agent?: string;
}

export function registerCronListCommand(cron: Command): void {
  cron
    .command("list")
    .description("List scheduled jobs for the current agent in this chat.")
    .option("--agent <name>", "Agent name on the First Tree server (default: first configured on this client)")
    .action(async (options: ListOptions) => {
      try {
        const chatId = requireCronChatId();
        const sdk = createSdk(options.agent);
        const result = await sdk.listCronJobs(chatId);
        success(result);
      } catch (error) {
        handleCronSdkError(error);
      }
    });
}
