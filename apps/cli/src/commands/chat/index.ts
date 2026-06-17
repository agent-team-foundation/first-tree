import type { Command } from "commander";
import { registerChatAskCommand } from "./ask.js";
import { registerChatCreateCommand } from "./create.js";
import { registerChatHistoryCommand } from "./history.js";
import { registerChatInviteCommand } from "./invite.js";
import { registerChatListCommand } from "./list.js";
import { registerChatOpenCommand } from "./open.js";
import { registerChatSendCommand } from "./send.js";
import { registerChatSetTopicCommand } from "./set-topic.js";
import { registerChatUpdateCommand } from "./update.js";

export function registerChatCommands(program: Command): void {
  const chat = program
    .command("chat")
    .description("Chats and messaging — create, send, ask, invite, list, history, update, open");
  registerChatCreateCommand(chat);
  registerChatSendCommand(chat);
  registerChatAskCommand(chat);
  registerChatInviteCommand(chat);
  registerChatListCommand(chat);
  registerChatHistoryCommand(chat);
  registerChatUpdateCommand(chat);
  // Deprecated alias of `chat update`, hidden from help; kept for transition.
  registerChatSetTopicCommand(chat);
  registerChatOpenCommand(chat);
}
