import type { Command } from "commander";
import { success } from "../../cli/output.js";
import { createSdk } from "../_shared/local-agent.js";
import { handleCronSdkError, requireCronChatId } from "./_shared.js";

type ListOptions = {};

export function registerCronListCommand(cron: Command): void {
  cron
    .command("list")
    .description("List scheduled jobs for the current agent in this chat.")
    .action(async (options: ListOptions) => {
      try {
        const chatId = requireCronChatId();
        const sdk = createSdk();
        const result = await sdk.listCronJobs(chatId);
        success(result);
      } catch (error) {
        handleCronSdkError(error);
      }
    });
}
