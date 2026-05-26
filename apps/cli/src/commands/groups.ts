import type { Command } from "commander";

import { withCommandContext } from "./context.js";
import type { SubcommandModule } from "./types.js";

type CommandWithUnknownCommand = Command & {
  unknownCommand(): void;
};

export function registerSubcommands(command: Command, subcommands: SubcommandModule[]): void {
  for (const subcommand of subcommands) {
    const childCommand = command.command(subcommand.name);

    if (subcommand.alias.length > 0) {
      childCommand.alias(subcommand.alias);
    }

    if (subcommand.summary.length > 0) {
      childCommand.summary(subcommand.summary);
    }

    childCommand
      .description(subcommand.description)
      .showHelpAfterError(true)
      .showSuggestionAfterError(true)
      .action(withCommandContext(subcommand.action));

    subcommand.configure?.(childCommand);
  }
}

export function registerCommandGroup(
  program: Command,
  name: string,
  description: string,
  subcommands: SubcommandModule[],
): void {
  const command = program
    .command(name)
    .description(description)
    .allowExcessArguments(true)
    .action(() => {
      // Keep bare group invocations as successful help while delegating typos to Commander suggestions.
      if (command.args.length > 0) {
        (command as CommandWithUnknownCommand).unknownCommand();
        return;
      }

      command.outputHelp();
    });

  registerSubcommands(command, subcommands);
}
