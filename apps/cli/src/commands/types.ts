import type { Command } from "commander";

export type GlobalOptions = {
  json: boolean;
  debug: boolean;
  quiet: boolean;
};

export type CommandContext = {
  options: GlobalOptions;
  command: Command;
};

export type CommandAction = (context: CommandContext) => void | Promise<void>;

export type CommandModule = {
  name: string;
  description: string;
  register(program: Command): void;
};

export type SubcommandModule = {
  name: string;
  alias: string;
  summary: string;
  description: string;
  action: CommandAction;
  configure?: (command: Command) => void;
};
