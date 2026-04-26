import type { Command } from "commander";

import type { CommandModule } from "./types.js";

export const hubCommand: CommandModule = {
  name: "hub",
  description: "Run the hub command placeholder.",
  register(program: Command): void {
    program
      .command("hub")
      .description("Run the hub command placeholder.")
      .action(() => {
        console.log("first-tree hub is not implemented yet.");
      });
  },
};
