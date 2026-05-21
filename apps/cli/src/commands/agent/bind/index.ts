import type { Command } from "commander";
import { registerAgentBindBotCommand } from "./bot.js";
import { registerAgentBindClientCommand } from "./client.js";
import { registerAgentBindUserCommand } from "./user.js";

export function registerAgentBindCommands(agent: Command): void {
  const bind = agent.command("bind").description("Bind an agent to a client machine or external IM account");
  registerAgentBindClientCommand(bind);
  registerAgentBindBotCommand(bind);
  registerAgentBindUserCommand(bind);
}
