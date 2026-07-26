import type { Command } from "commander";
import { success } from "../../cli/output.js";
import { createSdk } from "../_shared/local-agent.js";
import { handleCronSdkError, requireCronChatId } from "./_shared.js";

type ResumeOptions = {};

export function registerCronResumeCommand(cron: Command): void {
  cron
    .command("resume <jobId>")
    .description("Resume a paused scheduled job from the next future occurrence.")
    .action(async (jobId: string, options: ResumeOptions) => {
      try {
        const chatId = requireCronChatId();
        const sdk = createSdk();
        const current = await sdk.getCronJob(chatId, jobId);
        const job = await sdk.updateCronJob(chatId, jobId, { state: "active" }, current.revision);
        success(job);
      } catch (error) {
        handleCronSdkError(error);
      }
    });
}
