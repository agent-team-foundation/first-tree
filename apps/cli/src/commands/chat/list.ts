import type { Command } from "commander";
import { success } from "../../cli/output.js";
import { createSdk, handleSdkError } from "../_shared/local-agent.js";
import { parseLimit } from "./_shared/io.js";

export function registerChatListCommand(chat: Command): void {
  chat
    .command("list")
    .description("List chats this agent participates in")
    .option("-l, --limit <number>", "Maximum chats to return (1-100)", "20")
    .option("--cursor <cursor>", "Pagination cursor from previous response")
    .option("--agent <name>", "Agent name on the First Tree server (default: first configured on this client)")
    .action(async (options: { limit: string; cursor?: string; agent?: string }) => {
      try {
        const limit = parseLimit(options.limit, 100);
        const sdk = createSdk(options.agent);
        const result = await sdk.listChats({ limit, cursor: options.cursor });
        success(result);
      } catch (error) {
        handleSdkError(error);
      }
    });
}
