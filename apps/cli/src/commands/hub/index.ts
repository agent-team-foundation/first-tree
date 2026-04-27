import type { Command } from "commander";

import type { CommandModule, SubcommandModule } from "../types.js";
import { doctorCommand } from "./doctor.js";
import { startCommand } from "./start.js";
import { statusCommand } from "./status.js";
import { stopCommand } from "./stop.js";

const hubSubcommands: SubcommandModule[] = [
  startCommand,
  stopCommand,
  doctorCommand,
  statusCommand,
];

export const hubCommand: CommandModule = {
  name: "hub",
  description: "Work with hub workflow commands.",
  register(program: Command): void {
    const command = program
      .command("hub")
      .description("Work with hub workflow commands.")
      .action(() => {
        command.outputHelp();
      });

    for (const subcommand of hubSubcommands) {
      command
        .command(subcommand.name)
        .description(subcommand.description)
        .action(subcommand.action);
    }
  },
};
