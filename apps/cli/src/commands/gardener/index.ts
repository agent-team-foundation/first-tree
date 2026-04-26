import type { Command } from "commander";

import type { CommandModule } from "../types.js";

const gardenerSubcommands = [
  {
    name: "sync",
    description: "Sync gardener-managed state.",
  },
  {
    name: "status",
    description: "Show gardener-managed state status.",
  },
  {
    name: "install",
    description: "Install gardener workflow support.",
  },
] as const;

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
