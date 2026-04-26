import type { Command } from "commander";

import type { CommandModule } from "../types.js";

const treeSubcommands = [
  {
    name: "inspect",
    description: "Inspect the first-tree workspace.",
  },
  {
    name: "status",
    description: "Show first-tree workspace status.",
  },
  {
    name: "generate-codeowners",
    description: "Generate CODEOWNERS entries from first-tree ownership data.",
  },
  {
    name: "install-claude-code-hook",
    description: "Install the Claude Code hook for first-tree workflows.",
  },
] as const;

export const treeCommand: CommandModule = {
  name: "tree",
  description: "Work with first-tree context tree commands.",
  register(program: Command): void {
    const command = program
      .command("tree")
      .description("Work with first-tree context tree commands.")
      .action(() => {
        command.outputHelp();
      });

    for (const subcommand of treeSubcommands) {
      command
        .command(subcommand.name)
        .description(subcommand.description)
        .action(() => {
          console.log(`first-tree tree ${subcommand.name} is not implemented yet.`);
        });
    }
  },
};
