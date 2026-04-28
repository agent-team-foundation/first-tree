import type { Command } from "commander";

import { autoCommand } from "./auto/index.js";
import { hubCommand } from "./hub/index.js";
import { initCommand } from "./init.js";
import { treeCommand } from "./tree/index.js";
import type { CommandModule } from "./types.js";

export const commands: CommandModule[] = [initCommand, treeCommand, hubCommand, autoCommand];

export function registerCommands(program: Command): void {
  for (const command of commands) {
    command.register(program);
  }
}
