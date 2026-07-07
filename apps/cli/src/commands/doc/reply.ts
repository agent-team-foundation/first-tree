import type { Command } from "commander";
import { success } from "../../cli/output.js";
import { createSdk, handleSdkError } from "../_shared/local-agent.js";

interface ReplyOptions {
  agent?: string;
}

export function registerDocReplyCommand(doc: Command): void {
  doc
    .command("reply <commentId> <body>")
    .description("Reply in a comment thread (comment ids come from `doc comments`)")
    .option("--agent <name>", "Agent name on the First Tree server (default: first configured on this client)")
    .action(async (commentId: string, body: string, options: ReplyOptions) => {
      try {
        const sdk = createSdk(options.agent);
        success(await sdk.replyDocComment(commentId, body));
      } catch (error) {
        handleSdkError(error);
      }
    });
}
