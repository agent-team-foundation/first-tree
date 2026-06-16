import type { Command } from "commander";
import { success } from "../../cli/output.js";
import { createSdk } from "../_shared/local-agent.js";
import { handleGithubSdkError, resolveTargetChatId } from "./_shared.js";

interface FollowingOptions {
  chat?: string;
  agent?: string;
}

export function registerGithubFollowingCommand(github: Command): void {
  github
    .command("following")
    .description(
      "List the GitHub entities whose events route into the current chat. " +
        "Run this before following when unsure — re-following an already-wired entity is a no-op.",
    )
    .option("--chat <chatId>", "Target chat (default: the session's FIRST_TREE_CHAT_ID)")
    .option("--agent <name>", "Agent name on the First Tree server (default: first configured on this client)")
    .action(async (options: FollowingOptions) => {
      try {
        const chatId = resolveTargetChatId(options.chat);
        const sdk = createSdk(options.agent);
        const result = await sdk.listChatGithubEntities(chatId);
        success(result);
      } catch (error) {
        handleGithubSdkError(error);
      }
    });
}
