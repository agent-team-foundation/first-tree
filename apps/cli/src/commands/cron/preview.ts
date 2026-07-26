import type { Command } from "commander";
import { success } from "../../cli/output.js";
import { createSdk } from "../_shared/local-agent.js";
import { handleCronSdkError, requireCronChatId } from "./_shared.js";

interface PreviewOptions {
  schedule: string;
  timezone: string;
}

export function registerCronPreviewCommand(cron: Command): void {
  cron
    .command("preview")
    .description("Preview a five-field cron schedule and the next five occurrences (no side effects).")
    .requiredOption("--schedule <expr>", "Five-field cron expression")
    .requiredOption("--timezone <iana>", "IANA timezone, e.g. Asia/Taipei")
    .action(async (options: PreviewOptions) => {
      try {
        const chatId = requireCronChatId();
        const sdk = createSdk();
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
