import type { Command } from "commander";
import { fail, success } from "../../cli/output.js";
import { createSdk, handleSdkError } from "../_shared/local-agent.js";

export function registerChatInviteCommand(chat: Command): void {
  chat
    .command("invite <participantName>")
    .description(
      "Add an eligible active same-organization human or agent to the caller's current chat (identified by " +
        "FIRST_TREE_CHAT_ID). This changes membership only: it does not send a message or wake the participant. " +
        "Follow with `chat send <participantName>` when attention is required.",
    )
    .option("--agent <name>", "Agent name on the First Tree server (default: first configured on this client)")
    .action(async (participantName: string, options: { agent?: string }) => {
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
        // `agentName` is the retained wire-field name. The server resolves it
        // against every active participant mirror in the chat's organization,
        // including human members.
        const participants = await sdk.addChatParticipant(chatId, { agentName: participantName });
        success(participants);
      } catch (error) {
        handleSdkError(error);
      }
    });
}
