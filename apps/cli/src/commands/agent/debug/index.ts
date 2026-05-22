import type { Command } from "commander";
import { registerAgentDebugRegisterCommand } from "./register.js";

export function registerAgentDebugCommands(agent: Command): void {
  const debugCmd = agent.command("debug", { hidden: true }).description("Low-level SDK debug commands");
  registerAgentDebugRegisterCommand(debugCmd);
}
