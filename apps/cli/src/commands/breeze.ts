import type { Command } from "commander";

import type { CommandModule } from "./types.js";

export const breezeCommand: CommandModule = {
  name: "breeze",
  description: "Run the breeze command placeholder.",
  register(program: Command): void {
    program
      .command("breeze")
      .description("Run the breeze command placeholder.")
      .action(() => {
        console.log("first-tree breeze is not implemented yet.");
      });
  },
};
