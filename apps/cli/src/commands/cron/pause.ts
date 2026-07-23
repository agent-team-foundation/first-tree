import type { Command } from "commander";
import { success } from "../../cli/output.js";
import { createSdk } from "../_shared/local-agent.js";
import { handleCronSdkError, requireCronChatId } from "./_shared.js";

type PauseOptions = {};

export function registerCronPauseCommand(cron: Command): void {
  cron
    .command("pause <jobId>")
    .description("Pause a scheduled job (user_paused).")
    .action(async (jobId: string, options: PauseOptions) => {
      try {
        const chatId = requireCronChatId();
        const sdk = createSdk();
        const current = await sdk.getCronJob(chatId, jobId);
        const job = await sdk.updateCronJob(chatId, jobId, { state: "paused" }, current.revision);
        success(job);
      } catch (error) {
        handleCronSdkError(error);
      }
    });
}
