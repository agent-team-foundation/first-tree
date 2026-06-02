import type { Command } from "commander";
import { registerCommandGroup, registerSubcommands } from "../groups.js";
import type { CommandModule, SubcommandModule } from "../types.js";
import { automationSubcommands } from "./automation.js";
import { bindCommand } from "./bind.js";
import { bootstrapCommand } from "./bootstrap.js";
import { claudeHookCommand } from "./claude-hook.js";
import { codeownersCommand } from "./codeowners.js";
import { initCommand } from "./init.js";
import { injectCommand } from "./inject.js";
import { inspectCommand } from "./inspect.js";
import { integrateCommand } from "./integrate.js";
import { migrateCommand } from "./migrate.js";
import { publishCommand } from "./publish.js";
import { reviewCommand } from "./review.js";
import { skillSubcommands } from "./skill.js";
import { statusCommand } from "./status.js";
import { upgradeCommand } from "./upgrade.js";
import { verifyCommand } from "./verify.js";
import { workspaceSyncCommand } from "./workspace-sync.js";

type CommandWithUnknownCommand = Command & {
  unknownCommand(): void;
};

const TREE_ONBOARDING_GUIDE = `first-tree tree help onboarding

1. Run \`first-tree tree inspect --json\` to classify the current folder.
2. Decide whether you need a new dedicated tree repo or an existing shared tree.
3. Use \`first-tree tree init\` for the high-level onboarding flow.
4. If this root is a workspace, follow with \`first-tree tree workspace sync\`.
5. Before starting \`first-tree github scan\`, make sure a binding exists in
   the managed First Tree integration block in \`AGENTS.md\` or \`CLAUDE.md\`,
   or pass \`--tree-repo <owner/repo>\`.
`;

const treeSubcommands: SubcommandModule[] = [
  inspectCommand,
  statusCommand,
  initCommand,
  bootstrapCommand,
  bindCommand,
  integrateCommand,
  migrateCommand,
  verifyCommand,
  upgradeCommand,
  publishCommand,
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

    registerCommandGroup(command, "workspace", "Run workspace tree helpers.", [workspaceSyncCommand]);

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
