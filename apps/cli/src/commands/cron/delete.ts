import type { Command } from "commander";
import { success } from "../../cli/output.js";
import { createSdk } from "../_shared/local-agent.js";
import { handleCronSdkError, requireCronChatId } from "./_shared.js";

type DeleteOptions = {};

export function registerCronDeleteCommand(cron: Command): void {
  cron
    .command("delete <jobId>")
    .description("Hard-delete a scheduled job configuration (does not cancel in-flight triggers).")
    .action(async (jobId: string, options: DeleteOptions) => {
      try {
        const chatId = requireCronChatId();
        const sdk = createSdk();
        const current = await sdk.getCronJob(chatId, jobId);
        const result = await sdk.deleteCronJob(chatId, jobId, current.revision);
        success(result);
      } catch (error) {
        handleCronSdkError(error);
      }
    });
}
