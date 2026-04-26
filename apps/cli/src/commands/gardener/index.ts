import type { Command } from "commander";

import type { CommandModule, SubcommandModule } from "../types.js";
import { installCommand } from "./install.js";
import { statusCommand } from "./status.js";
import { syncCommand } from "./sync.js";

const gardenerSubcommands: SubcommandModule[] = [
  syncCommand,
  statusCommand,
  installCommand,
];

export const gardenerCommand: CommandModule = {
  name: "gardener",
  description: "Work with gardener workflow commands.",
  register(program: Command): void {
    const command = program
      .command("gardener")
      .description("Work with gardener workflow commands.")
      .action(() => {
        command.outputHelp();
      });

    for (const subcommand of gardenerSubcommands) {
      command
        .command(subcommand.name)
        .description(subcommand.description)
        .action(() => {
          console.log(`first-tree gardener ${subcommand.name} is not implemented yet.`);
        });
    }
  },
};
