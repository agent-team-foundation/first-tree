import type { Command } from "commander";
import { success } from "../../cli/output.js";
import { createSdk } from "../_shared/local-agent.js";
import { readMessageBody } from "../chat/_shared/io.js";
import { handleCronSdkError, requireCronChatId } from "./_shared.js";

interface CreateOptions {
  name: string;
  schedule: string;
  timezone: string;
  F: string;
  agent?: string;
}

export function registerCronCreateCommand(cron: Command): void {
  cron
    .command("create")
    .description("Create an active scheduled job in the current chat.")
    .requiredOption("--name <name>", "Job name (unique per agent in this chat)")
    .requiredOption("--schedule <expr>", "Five-field cron expression")
    .requiredOption("--timezone <iana>", "IANA timezone")
    .requiredOption("-F <file>", "Prompt body from file or stdin (-)")
    .option("--agent <name>", "Agent name on the First Tree server (default: first configured on this client)")
    .action(async (options: CreateOptions) => {
      try {
        const chatId = requireCronChatId();
        const prompt = await readMessageBody(options.F);
        if (prompt === null || prompt.trim().length === 0) {
          handleCronSdkError(new Error("prompt must be non-empty"));
        }
        const sdk = createSdk(options.agent);
        const job = await sdk.createCronJob(chatId, {
          name: options.name,
          schedule: options.schedule,
          timezone: options.timezone,
          prompt,
        });
        success(job);
      } catch (error) {
        handleCronSdkError(error);
      }
    });
}
