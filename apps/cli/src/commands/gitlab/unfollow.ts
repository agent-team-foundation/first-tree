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
      "Stop this chat's GitLab follow using the current URL shown by `gitlab following`. " +
        "Removes automatic and manual bindings; a future directed personnel event may route the entity again.",
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
            ? "No binding matched — terminal success; do not retry-loop on removed: 0."
            : `Removed ${removed} binding${removed === 1 ? "" : "s"} from this chat.`;
        success({
          removed,
          hint: `${hint} A future explicit reviewer, assignee, or mention event may create a new route.`,
        });
      } catch (error) {
        handleGitlabSdkError(error);
      }
    });
}
