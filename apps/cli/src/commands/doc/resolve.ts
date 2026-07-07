import type { Command } from "commander";
import { success } from "../../cli/output.js";
import { createSdk, handleSdkError } from "../_shared/local-agent.js";

interface ResolveOptions {
  reopen?: boolean;
  agent?: string;
}

export function registerDocResolveCommand(doc: Command): void {
  doc
    .command("resolve <commentId>")
    .description("Resolve a comment thread (or reopen it with --reopen)")
    .option("--reopen", "Reopen a previously resolved thread")
    .option("--agent <name>", "Agent name on the First Tree server (default: first configured on this client)")
    .action(async (commentId: string, options: ResolveOptions) => {
      try {
        const sdk = createSdk(options.agent);
        success(await sdk.setDocCommentStatus(commentId, options.reopen === true ? "open" : "resolved"));
      } catch (error) {
        handleSdkError(error);
      }
    });
}
