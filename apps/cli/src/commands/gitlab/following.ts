import type { Command } from "commander";
import { success } from "../../cli/output.js";
import { resolveTargetChatId } from "../_shared/chat-target.js";
import { createSdk } from "../_shared/local-agent.js";
import { handleGitlabSdkError } from "./_shared.js";

type FollowingOptions = {
  chat?: string;
  agent?: string;
};

export function registerGitlabFollowingCommand(gitlab: Command): void {
  gitlab
    .command("following")
    .description(
      "List this chat's GitLab Issue/MR bindings and their pending or active webhook status, including " +
        "automatic reviewer, assignee, or mention routing.",
    )
    .option("--chat <chatId>", "Target chat (default: the session's FIRST_TREE_CHAT_ID)")
    .option("--agent <name>", "Agent name on the First Tree server (default: first configured on this client)")
    .action(async (options: FollowingOptions) => {
      try {
        const chatId = resolveTargetChatId(options.chat);
        const sdk = createSdk(options.agent);
        success(await sdk.listChatGitlabEntities(chatId));
      } catch (error) {
        handleGitlabSdkError(error);
      }
    });
}
