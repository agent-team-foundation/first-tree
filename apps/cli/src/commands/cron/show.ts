import type { Command } from "commander";
import { success } from "../../cli/output.js";
import { createSdk } from "../_shared/local-agent.js";
import { handleCronSdkError, requireCronChatId } from "./_shared.js";

interface ShowOptions {
  agent?: string;
}

export function registerCronShowCommand(cron: Command): void {
  cron
    .command("show <jobId>")
    .description("Show one scheduled job by id.")
    .option("--agent <name>", "Agent name on the First Tree server (default: first configured on this client)")
    .action(async (jobId: string, options: ShowOptions) => {
      try {
        const chatId = requireCronChatId();
        const sdk = createSdk(options.agent);
        const job = await sdk.getCronJob(chatId, jobId);
        success(job);
      } catch (error) {
        handleCronSdkError(error);
      }
    });
}
