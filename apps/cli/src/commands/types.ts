import type { Command } from "commander";

export type CommandModule = {
  name: string;
  description: string;
  register(program: Command): void;
};

export type SubcommandModule = {
  name: string;
  description: string;
};
