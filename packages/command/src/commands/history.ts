import type { Command } from "commander";
import { success } from "../cli/output.js";
import { createSdk, handleError, parseLimit } from "../cli/util.js";

export function registerHistoryCommand(program: Command): void {
  program
    .command("history <chatId>")
    .description("View message history in a chat")
    .option("-l, --limit <number>", "Maximum messages to return (1-100)", "20")
    .option("--cursor <cursor>", "Pagination cursor from previous response")
    .action(async (chatId: string, options: { limit: string; cursor?: string }) => {
      try {
        const limit = parseLimit(options.limit, 100);
        const sdk = createSdk();
        const result = await sdk.listMessages(chatId, { limit, cursor: options.cursor });
        success(result);
      } catch (error) {
        handleError(error);
      }
    });
}
