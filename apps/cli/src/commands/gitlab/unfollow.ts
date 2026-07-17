import type { Command } from "commander";
import { success } from "../../cli/output.js";
import { resolveTargetChatId } from "../_shared/chat-target.js";
import { createSdk } from "../_shared/local-agent.js";
import { handleGitlabSdkError } from "./_shared.js";

type UnfollowOptions = {
  chat?: string;
  agent?: string;
};

export function registerGitlabUnfollowCommand(gitlab: Command): void {
  gitlab
    .command("unfollow <issue-or-mr-url>")
    .description(
      "Stop this chat's explicit GitLab follow using the current URL shown by `gitlab following`. " +
        "This does not remove independent reviewer, assignee, or mention identity routing.",
    )
    .option("--chat <chatId>", "Target chat (default: the session's FIRST_TREE_CHAT_ID)")
    .option("--agent <name>", "Agent name on the First Tree server (default: first configured on this client)")
    .action(async (entityUrl: string, options: UnfollowOptions) => {
      try {
        const chatId = resolveTargetChatId(options.chat);
        const sdk = createSdk(options.agent);
        const { removed } = await sdk.unfollowGitlabEntity(chatId, entityUrl);
        const hint =
          removed === 0
            ? "No explicit declaration matched — terminal success; do not retry-loop on removed: 0."
            : `Removed ${removed} explicit declaration${removed === 1 ? "" : "s"} from this chat.`;
        success({
          removed,
          hint: `${hint} Independent reviewer, assignee, or explicit-mention identity routing remains eligible for future events.`,
        });
      } catch (error) {
        handleGitlabSdkError(error);
      }
    });
}
