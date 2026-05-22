import type { Command } from "commander";
import { registerAgentSessionControlCommands } from "./control.js";
import { registerAgentSessionListCommand } from "./list.js";

export function registerAgentSessionCommands(agent: Command): void {
  const sessionCmd = agent.command("session").description("Session lifecycle commands");
  registerAgentSessionListCommand(sessionCmd);
  registerAgentSessionControlCommands(sessionCmd);
}
