import type { Command } from "commander";
import { registerChatCreateCommand } from "./create.js";
import { registerChatHistoryCommand } from "./history.js";
import { registerChatInviteCommand } from "./invite.js";
import { registerChatListCommand } from "./list.js";
import { registerChatOpenCommand } from "./open.js";
import { registerChatSendCommand } from "./send.js";
import { registerChatSetTopicCommand } from "./set-topic.js";

export function registerChatCommands(program: Command): void {
  const chat = program
    .command("chat")
    .description("Chats and messaging — create, send, invite, list, history, set-topic, open");
  registerChatCreateCommand(chat);
  registerChatSendCommand(chat);
  registerChatInviteCommand(chat);
  registerChatListCommand(chat);
  registerChatHistoryCommand(chat);
  registerChatSetTopicCommand(chat);
  registerChatOpenCommand(chat);
}
