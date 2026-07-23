import type { Command } from "commander";
import { success } from "../../cli/output.js";
import { createSdk } from "../_shared/local-agent.js";
import { handleCronSdkError, requireCronChatId } from "./_shared.js";

interface DeleteOptions {
  agent?: string;
}

export function registerCronDeleteCommand(cron: Command): void {
  cron
    .command("delete <jobId>")
    .description("Hard-delete a scheduled job configuration (does not cancel in-flight triggers).")
    .option("--agent <name>", "Agent name on the First Tree server (default: first configured on this client)")
    .action(async (jobId: string, options: DeleteOptions) => {
      try {
        const chatId = requireCronChatId();
        const sdk = createSdk(options.agent);
        const current = await sdk.getCronJob(chatId, jobId);
        const result = await sdk.deleteCronJob(chatId, jobId, current.revision);
        success(result);
      } catch (error) {
        handleCronSdkError(error);
      }
    });
}
