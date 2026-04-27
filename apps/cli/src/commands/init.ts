import type { Command } from "commander";

import { withCommandContext } from "./context.js";
import type { CommandAction, CommandContext, CommandModule } from "./types.js";

type InitCommandModule = CommandModule & {
  action: CommandAction;
};

export function runInitCommand(_context: CommandContext): void {
  console.log("first-tree init is not implemented yet.");
}

export const initCommand: InitCommandModule = {
  name: "init",
  description: "Initialize first-tree in a repository.",
  action: runInitCommand,
  register(program: Command): void {
    program
      .command("init")
      .description("Initialize first-tree in a repository.")
      .action(withCommandContext(initCommand.action));
  },
};
