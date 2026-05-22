import type { Command } from "commander";

import type { CommandAction, CommandContext, GlobalOptions } from "./types.js";

type DebugQuietMode = "debug" | "quiet";

type RawGlobalOptions = Partial<Record<keyof GlobalOptions, unknown>>;

type CommandWithRawArgs = Command & {
  rawArgs?: string[];
};

function isCommandToken(command: Command, token: string): boolean {
  return command.commands.some((childCommand) => {
    return childCommand.name() === token || childCommand.aliases().includes(token);
  });
}

function getUserArgv(rootCommand: Command): string[] {
  const rawArgs = (rootCommand as CommandWithRawArgs).rawArgs ?? [];

  if (rawArgs.length === 0) {
    return [];
  }

  const firstArg = rawArgs[0];

  if (firstArg === "--" || firstArg.startsWith("-") || isCommandToken(rootCommand, firstArg)) {
    return rawArgs;
  }

  return rawArgs.slice(2);
}

function getRootCommand(command: Command): Command {
  let currentCommand = command;

  while (currentCommand.parent !== null) {
    currentCommand = currentCommand.parent;
  }

  return currentCommand;
}

function findLastDebugQuietMode(argv: string[]): DebugQuietMode | undefined {
  let mode: DebugQuietMode | undefined;

  for (const token of argv) {
    if (token === "--") {
      break;
    }

    if (token === "--debug") {
      mode = "debug";
      continue;
    }

    if (token === "--quiet") {
      mode = "quiet";
      continue;
    }

    if (token.startsWith("--") || !token.startsWith("-") || token === "-") {
      continue;
    }

    for (const optionName of token.slice(1)) {
      if (optionName === "d") {
        mode = "debug";
      }

      if (optionName === "q") {
        mode = "quiet";
      }
    }
  }

  return mode;
}

export function createCommandContext(command: Command): CommandContext {
  const rawOptions = command.optsWithGlobals() as RawGlobalOptions;
  const options: GlobalOptions = {
    json: rawOptions.json === true,
    debug: rawOptions.debug === true,
    quiet: rawOptions.quiet === true,
  };
  const mode = findLastDebugQuietMode(getUserArgv(getRootCommand(command)));

  if (mode === "debug") {
    options.debug = true;
    options.quiet = false;
  }

  if (mode === "quiet") {
    options.debug = false;
    options.quiet = true;
  }

  return {
    options,
    command,
  };
}

export function withCommandContext(
  action: CommandAction,
): (this: Command, ...args: unknown[]) => void | Promise<void> {
  return function wrappedCommandAction(this: Command): void | Promise<void> {
    return action(createCommandContext(this));
  };
}
