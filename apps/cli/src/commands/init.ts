import type { Command } from "commander";

import type { CommandModule } from "./types.js";

export const initCommand: CommandModule = {
  name: "init",
  description: "Initialize first-tree in a repository.",
  register(program: Command): void {
    program
      .command("init")
      .description("Initialize first-tree in a repository.")
      .action(() => {
        console.log("first-tree init is not implemented yet.");
      });
  },
};
