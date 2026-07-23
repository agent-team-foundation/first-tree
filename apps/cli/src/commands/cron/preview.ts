import type { Command } from "commander";
import { success } from "../../cli/output.js";
import { createSdk } from "../_shared/local-agent.js";
import { handleCronSdkError, requireCronChatId } from "./_shared.js";

interface PreviewOptions {
  schedule: string;
  timezone: string;
  agent?: string;
}

export function registerCronPreviewCommand(cron: Command): void {
  cron
    .command("preview")
    .description("Preview a five-field cron schedule and the next five occurrences (no side effects).")
    .requiredOption("--schedule <expr>", "Five-field cron expression")
    .requiredOption("--timezone <iana>", "IANA timezone, e.g. Asia/Taipei")
    .option("--agent <name>", "Agent name on the First Tree server (default: first configured on this client)")
    .action(async (options: PreviewOptions) => {
      try {
        const chatId = requireCronChatId();
        const sdk = createSdk(options.agent);
        const result = await sdk.previewCronJob(chatId, {
          schedule: options.schedule,
          timezone: options.timezone,
        });
        success(result);
      } catch (error) {
        handleCronSdkError(error);
      }
    });
}
