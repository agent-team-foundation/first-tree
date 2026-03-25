import type { Command } from "commander";
import { success } from "../cli/output.js";
import { createSdk, handleError, parseLimit } from "../cli/util.js";

export function registerChatsCommand(program: Command): void {
  program
    .command("chats")
    .description("List chats this agent participates in")
    .option("-l, --limit <number>", "Maximum chats to return (1-100)", "20")
    .option("--cursor <cursor>", "Pagination cursor from previous response")
    .action(async (options: { limit: string; cursor?: string }) => {
      try {
        const limit = parseLimit(options.limit, 100);
        const sdk = createSdk();
        const result = await sdk.listChats({ limit, cursor: options.cursor });
        success(result);
      } catch (error) {
        handleError(error);
      }
    });
}
