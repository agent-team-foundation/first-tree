import type { Command } from "commander";

import type { CommandModule } from "./types.js";

export const gardenerCommand: CommandModule = {
  name: "gardener",
  description: "Run the gardener command placeholder.",
  register(program: Command): void {
    program
      .command("gardener")
      .description("Run the gardener command placeholder.")
      .action(() => {
        console.log("first-tree gardener is not implemented yet.");
      });
  },
};
