import type { Command } from "commander";

import type { CommandModule } from "./types.js";

export const treeCommand: CommandModule = {
  name: "tree",
  description: "Run the tree command placeholder.",
  register(program: Command): void {
    program
      .command("tree")
      .description("Run the tree command placeholder.")
      .action(() => {
        console.log("first-tree tree is not implemented yet.");
      });
  },
};
