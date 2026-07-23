import type { Command } from "commander";
import { success } from "../../cli/output.js";
import { createSdk } from "../_shared/local-agent.js";
import { readMessageBody } from "../chat/_shared/io.js";
import { handleCronSdkError, requireCronChatId } from "./_shared.js";

interface UpdateOptions {
  name?: string;
  schedule?: string;
  timezone?: string;
  F?: string;
  agent?: string;
}

export function registerCronUpdateCommand(cron: Command): void {
  cron
    .command("update <jobId>")
    .description("Update a scheduled job (requires current revision from show).")
    .option("--name <name>", "New display name")
    .option("--schedule <expr>", "New five-field cron expression")
    .option("--timezone <iana>", "New IANA timezone")
    .option("-F <file>", "Replace prompt from file or stdin (-)")
    .option("--agent <name>", "Agent name on the First Tree server (default: first configured on this client)")
    .action(async (jobId: string, options: UpdateOptions) => {
      try {
        const chatId = requireCronChatId();
        const sdk = createSdk(options.agent);
        const current = await sdk.getCronJob(chatId, jobId);
        const body: Record<string, string> = {};
        if (options.name !== undefined) body.name = options.name;
        if (options.schedule !== undefined) body.schedule = options.schedule;
        if (options.timezone !== undefined) body.timezone = options.timezone;
        if (options.F !== undefined) {
          const prompt = await readMessageBody(options.F);
          if (prompt === null || prompt.trim().length === 0) {
            handleCronSdkError(new Error("prompt must be non-empty"));
          }
          body.prompt = prompt;
        }
        if (Object.keys(body).length === 0) {
          handleCronSdkError(new Error("at least one of --name, --schedule, --timezone, or -F is required"));
        }
        const job = await sdk.updateCronJob(chatId, jobId, body, current.revision);
        success(job);
      } catch (error) {
        handleCronSdkError(error);
      }
    });
}
