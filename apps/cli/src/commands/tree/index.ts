import type { Command } from "commander";

import type { CommandModule, SubcommandModule } from "../types.js";
import { generateCodeownersCommand } from "./generate-codeowners.js";
import { inspectCommand } from "./inspect.js";
import { installClaudeCodeHookCommand } from "./install-claude-code-hook.js";
import { statusCommand } from "./status.js";

const treeSubcommands: SubcommandModule[] = [
  inspectCommand,
  statusCommand,
  generateCodeownersCommand,
  installClaudeCodeHookCommand,
];

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
