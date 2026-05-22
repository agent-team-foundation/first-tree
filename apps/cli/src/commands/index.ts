import type { Command } from "commander";

import { githubCommand } from "./github/index.js";
import { treeCommand } from "./tree/index.js";
import type { CommandModule } from "./types.js";

export const commands: CommandModule[] = [treeCommand, githubCommand];

export function registerCommands(program: Command): void {
  for (const command of commands) {
    command.register(program);
  }
}
