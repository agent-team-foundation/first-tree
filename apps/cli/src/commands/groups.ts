import type { Command } from "commander";

import type { SubcommandModule } from "./types.js";

type CommandWithUnknownCommand = Command & {
  unknownCommand(): void;
};

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

  for (const subcommand of subcommands) {
    command
      .command(subcommand.name)
      .alias(subcommand.alias)
      .summary(subcommand.summary)
      .description(subcommand.description)
      .showHelpAfterError(true)
      .showSuggestionAfterError(true)
      .action(subcommand.action);
  }
}
