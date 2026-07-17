import { fail } from "../../cli/output.js";

/** Resolve a chat-scoped provider command target from the flag or agent session. */
export function resolveTargetChatId(chatOption: string | undefined): string {
  const chatId = chatOption ?? process.env.FIRST_TREE_CHAT_ID;
  if (!chatId) {
    fail(
      "NO_CHAT_CONTEXT",
      "Following is chat-scoped: run from within an agent session (FIRST_TREE_CHAT_ID) or pass --chat <chatId>.",
      2,
    );
  }
  return chatId;
}
