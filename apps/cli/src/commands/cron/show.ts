import type { Command } from "commander";
import { success } from "../../cli/output.js";
import { createSdk } from "../_shared/local-agent.js";
import { handleCronSdkError, requireCronChatId } from "./_shared.js";

export function registerCronShowCommand(cron: Command): void {
  cron
    .command("show <jobId>")
    .description("Show one scheduled job by id.")
    .action(async (jobId: string) => {
      try {
        const chatId = requireCronChatId();
        const sdk = createSdk();
        const job = await sdk.getCronJob(chatId, jobId);
        success(job);
      } catch (error) {
        handleCronSdkError(error);
      }
    });
}
