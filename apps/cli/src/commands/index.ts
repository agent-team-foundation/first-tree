import type { Command } from "commander";

import { breezeCommand } from "./breeze/index.js";
import { gardenerCommand } from "./gardener/index.js";
import { hubCommand } from "./hub.js";
import { initCommand } from "./init.js";
import { treeCommand } from "./tree/index.js";
import type { CommandModule } from "./types.js";

export const commands: CommandModule[] = [
  initCommand,
  treeCommand,
  hubCommand,
  breezeCommand,
  gardenerCommand,
];

export function registerCommands(program: Command): void {
  for (const command of commands) {
    command.register(program);
  }
}
