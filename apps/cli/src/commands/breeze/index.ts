import type { Command } from "commander";

import type { CommandModule } from "../types.js";

const breezeSubcommands = [
  {
    name: "install",
    description: "Install breeze workflow support.",
  },
  {
    name: "start",
    description: "Start breeze workflow services.",
  },
  {
    name: "stop",
    description: "Stop breeze workflow services.",
  },
  {
    name: "status",
    description: "Show breeze workflow status.",
  },
  {
    name: "doctor",
    description: "Check breeze workflow configuration.",
  },
  {
    name: "poll",
    description: "Poll breeze workflow state.",
  },
] as const;

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
        .action(() => {
          console.log(`first-tree breeze ${subcommand.name} is not implemented yet.`);
        });
    }
  },
};
