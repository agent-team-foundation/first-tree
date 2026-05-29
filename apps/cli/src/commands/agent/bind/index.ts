import type { Command } from "commander";
import { registerAgentBindClientCommand } from "./client.js";

export function registerAgentBindCommands(agent: Command): void {
  const bind = agent.command("bind").description("Bind an agent to a client machine");
  registerAgentBindClientCommand(bind);
}
