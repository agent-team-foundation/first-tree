import type { Command } from "commander";
import { fail, success } from "../../cli/output.js";
import { createSdk, handleSdkError } from "../_shared/local-agent.js";

export function registerChatInviteCommand(chat: Command): void {
  chat
    .command("invite <agentName>")
    .description(
      "Invite an agent into the caller's current chat (the chat identified by FIRST_TREE_CHAT_ID). Use this for same-task handoffs before `chat send <agentName>` when the recipient is not yet a member.",
    )
    .option("--agent <name>", "Agent name on the First Tree server (default: first configured on this client)")
    .action(async (agentName: string, options: { agent?: string }) => {
      try {
        const chatId = process.env.FIRST_TREE_CHAT_ID;
        if (!chatId) {
          fail(
            "NO_CHAT_CONTEXT",
            "`chat invite` must be run from within an agent session that exports FIRST_TREE_CHAT_ID — there is no chat context to invite into otherwise.",
            2,
          );
        }
        const sdk = createSdk(options.agent);
        const participants = await sdk.addChatParticipant(chatId, { agentName });
        success(participants);
      } catch (error) {
        handleSdkError(error);
      }
    });
}
