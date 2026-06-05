import type { Command } from "commander";
import { registerCommandGroup, registerSubcommands } from "../groups.js";
import type { CommandModule, SubcommandModule } from "../types.js";
import { automationSubcommands } from "./automation.js";
import { claudeHookCommand } from "./claude-hook.js";
import { codeownersCommand } from "./codeowners.js";
import { initCommand } from "./init.js";
import { injectCommand } from "./inject.js";
import { migrateCommand } from "./migrate.js";
import { reviewCommand } from "./review.js";
import { skillSubcommands } from "./skill.js";
import { statusCommand } from "./status.js";
import { upgradeCommand } from "./upgrade.js";
import { verifyCommand } from "./verify.js";

type CommandWithUnknownCommand = Command & {
  unknownCommand(): void;
};

const TREE_ONBOARDING_GUIDE = `first-tree tree help onboarding

1. Run \`first-tree tree status\` to see the current binding (if any).
2. Run \`first-tree tree init --tree-path <path>\` to onboard a repo or workspace.
3. For pre-W1 layouts, follow with \`first-tree tree migrate-to-w1\`.
4. Use \`first-tree tree verify\` to validate the resulting tree.
`;

const treeSubcommands: SubcommandModule[] = [
  statusCommand,
  initCommand,
  migrateCommand,
  verifyCommand,
  upgradeCommand,
  codeownersCommand,
  claudeHookCommand,
  injectCommand,
  reviewCommand,
];

export function registerTreeCommands(program: Command): void {
  treeCommand.register(program);
}

export const treeCommand: CommandModule = {
  name: "tree",
  description: "Work with Context Tree commands.",
  register(program: Command): void {
    const command = program
      .command("tree")
      .description("Work with Context Tree commands.")
      .helpCommand(false)
      .allowExcessArguments(true)
      .action(() => {
        if (command.args.length > 0) {
          (command as CommandWithUnknownCommand).unknownCommand();
          return;
        }

        command.outputHelp();
      });

    registerSubcommands(command, treeSubcommands);

    registerCommandGroup(command, "automation", "Install or inspect tree GitHub automation.", [
      ...automationSubcommands,
    ]);

    registerCommandGroup(command, "skill", "Install and repair first-tree skill payloads.", skillSubcommands);

    registerCommandGroup(command, "help", "Show Context Tree help topics.", [
      {
        name: "onboarding",
        alias: "",
        summary: "",
        description: "Show the onboarding guide.",
        action: () => {
          console.log(TREE_ONBOARDING_GUIDE.trimEnd());
        },
      },
    ]);
  },
};
