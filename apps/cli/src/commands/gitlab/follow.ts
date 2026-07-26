import type { Command } from "commander";
import { success } from "../../cli/output.js";
import { channelConfig } from "../../core/channel.js";
import { resolveTargetChatId } from "../_shared/chat-target.js";
import { createSdk } from "../_shared/local-agent.js";
import { handleGitlabSdkError } from "./_shared.js";

type FollowOptions = {
  chat?: string;
  agent?: string;
  rebind?: boolean;
};

export function registerGitlabFollowCommand(gitlab: Command): void {
  gitlab
    .command("follow <issue-or-mr-url>")
    .description(
      "Follow a full GitLab Issue or Merge Request URL in this chat. First Tree records a local pending " +
        "declaration without calling GitLab; the next matching valid webhook activates it.",
    )
    .option("--chat <chatId>", "Target chat (default: the session's FIRST_TREE_CHAT_ID)")
    .option("--agent <name>", "Agent name on the First Tree server (default: first configured on this client)")
    .option("--rebind", "Move this agent's existing attention line from another chat into the target chat")
    .action(async (entityUrl: string, options: FollowOptions) => {
      try {
        const chatId = resolveTargetChatId(options.chat);
        const sdk = createSdk(options.agent);
        const result = await sdk.followGitlabEntity(chatId, { entityUrl, rebind: options.rebind ?? false });
        const hint =
          result.status === "created"
            ? "Declaration recorded locally. It remains pending until the next matching valid GitLab webhook; " +
              "First Tree has not called GitLab or verified that the entity exists."
            : result.status === "rebound"
              ? "Attention line moved into this chat. A pending line activates on the next matching valid webhook."
              : result.entity.status === "pending"
                ? "Already pending in this chat — idempotent success. Wait for a matching valid webhook; do not retry."
                : "Already active in this chat — idempotent success, do not retry.";
        success({
          ...result,
          hint:
            `${hint} To stop this chat's follow later, use ` +
            `\`${channelConfig.binName} gitlab unfollow ${result.entity.entityUrl}\`.`,
        });
      } catch (error) {
        handleGitlabSdkError(error);
      }
    });
}
