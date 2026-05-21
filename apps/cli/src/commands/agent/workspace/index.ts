import type { Command } from "commander";
import { registerAgentWorkspaceCleanCommand } from "./clean.js";

export function registerAgentWorkspaceCommands(agent: Command): void {
  const workspace = agent.command("workspace").description("Manage agent workspaces");
  registerAgentWorkspaceCleanCommand(workspace);
}
