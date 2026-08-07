import type { Command } from "commander";
import { registerSubcommands } from "../groups.js";
import type { CommandModule } from "../types.js";
import { contextActivateCommand } from "./activate.js";
import { contextAdapterSyncCommand } from "./adapter-sync.js";
import { contextDisableCommand } from "./disable.js";
import { contextEnableCommand } from "./enable.js";
import { legacyContextReadCommand } from "./legacy-read.js";
import { contextObserveLoadedCommand } from "./observe-loaded.js";
import { contextReadCommand } from "./read.js";
import { contextRepairCommand } from "./repair.js";
import { contextRouteCommand } from "./route.js";
import { contextSkillCommand } from "./skill.js";
import { contextStatusCommand } from "./status.js";
import { contextWriteCommand } from "./write.js";
import { contextWriteFinishCommand, contextWriteStatusCommand, contextWriteWorktreeCommand } from "./write-worktree.js";

export function registerContextCommands(program: Command): void {
  contextCommand.register(program);
}

const contextCommand: CommandModule = {
  name: "context",
  description: "Manage external coding-agent access to First Tree Context.",
  register(program: Command): void {
    const command = program
      .command("context")
      .description("Manage external coding-agent access to First Tree Context.")
      .helpCommand(false)
      .allowExcessArguments(false)
      .action(() => command.outputHelp());
    registerSubcommands(command, [
      contextEnableCommand,
      contextStatusCommand,
      contextRepairCommand,
      contextDisableCommand,
      contextActivateCommand,
      contextAdapterSyncCommand,
      contextObserveLoadedCommand,
      contextRouteCommand,
      contextSkillCommand,
      contextReadCommand,
      contextWriteCommand,
      contextWriteWorktreeCommand,
      contextWriteStatusCommand,
      contextWriteFinishCommand,
      legacyContextReadCommand,
    ]);
  },
};
