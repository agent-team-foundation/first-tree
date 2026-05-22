import type { Command } from "commander";
import { registerChatHistoryCommand } from "./history.js";
import { registerChatInviteCommand } from "./invite.js";
import { registerChatListCommand } from "./list.js";
import { registerChatOpenCommand } from "./open.js";
import { registerChatSendCommand } from "./send.js";

export function registerChatCommands(program: Command): void {
  const chat = program.command("chat").description("Chats and messaging — list, history, send, open");
  registerChatSendCommand(chat);
  registerChatInviteCommand(chat);
  registerChatListCommand(chat);
  registerChatHistoryCommand(chat);
  registerChatOpenCommand(chat);
}
