import type { Command } from "commander";

import type { CommandModule, SubcommandModule } from "../types.js";
import { doctorCommand } from "./doctor.js";
import { installCommand } from "./install.js";
import { pollCommand } from "./poll.js";
import { startCommand } from "./start.js";
import { statusCommand } from "./status.js";
import { stopCommand } from "./stop.js";

const breezeSubcommands: SubcommandModule[] = [
  installCommand,
  startCommand,
  stopCommand,
  statusCommand,
  doctorCommand,
  pollCommand,
];

export const breezeCommand: CommandModule = {
  name: "breeze",
  description: "Work with breeze workflow commands.",
  register(program: Command): void {
    const command = program
      .command("breeze")
      .description("Work with breeze workflow commands.")
      .action(() => {
        command.outputHelp();
      });

    for (const subcommand of breezeSubcommands) {
      command
        .command(subcommand.name)
        .description(subcommand.description)
        .action(subcommand.action);
    }
  },
};
