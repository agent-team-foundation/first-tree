import type { Command } from "commander";
import { success } from "../../cli/output.js";
import { createSdk, handleSdkError } from "../_shared/local-agent.js";
import { parseLimit } from "./_shared/io.js";

export function registerChatHistoryCommand(chat: Command): void {
  chat
    .command("history <chatId>")
    .description("View message history in a chat")
    .option("-l, --limit <number>", "Maximum messages to return (1-100)", "20")
    .option("--cursor <cursor>", "Pagination cursor from previous response")
    .option("--agent <name>", "Agent name on the First Tree server (default: first configured on this client)")
    .action(async (chatId: string, options: { limit: string; cursor?: string; agent?: string }) => {
      try {
        const limit = parseLimit(options.limit, 100);
        const sdk = createSdk(options.agent);
        const result = await sdk.listMessages(chatId, { limit, cursor: options.cursor });
        success(result);
      } catch (error) {
        handleSdkError(error);
      }
    });
}
