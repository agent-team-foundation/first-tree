import type { Command } from "commander";
import { success } from "../../cli/output.js";
import { createSdk } from "../_shared/local-agent.js";
import { handleGithubSdkError, resolveTargetChatId } from "./_shared.js";

interface UnfollowOptions {
  chat?: string;
  agent?: string;
}

export function registerGithubUnfollowCommand(github: Command): void {
  github
    .command("unfollow <entity>")
    .description(
      "Unfollow a GitHub entity when the human wants this chat to stop tracking it. Severs EVERY line wired " +
        "into this chat for the entity, however it was created (follow, mention, Fixes #N). An explicit " +
        "@mention of a team member still reaches them afterwards — in a NEW chat, never back into this one.",
    )
    .option("--chat <chatId>", "Target chat (default: the session's FIRST_TREE_CHAT_ID)")
    .option("--agent <name>", "Agent name on the First Tree server (default: first configured on this client)")
    .action(async (entity: string, options: UnfollowOptions) => {
      try {
        const chatId = resolveTargetChatId(options.chat);
        const sdk = createSdk(options.agent);
        const { removed } = await sdk.unfollowGithubEntity(chatId, entity);
        const hint =
          removed === 0
            ? "Wasn't following — terminal success, nothing to do (never retry-loop on removed: 0)."
            : `Severed ${removed} line${removed > 1 ? "s" : ""} — events stop from the next one (an in-flight delivery may still land once).`;
        success({ removed, hint });
      } catch (error) {
        handleGithubSdkError(error);
      }
    });
}
