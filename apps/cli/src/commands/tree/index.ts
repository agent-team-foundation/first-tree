import type { Command } from "commander";
import { registerSubcommands } from "../groups.js";
import type { CommandModule } from "../types.js";
import { treeTreeCommand } from "./tree.js";
import { verifyCommand } from "./verify.js";

/**
 * The `first-tree tree` namespace was retired in 2026-06 except for:
 * - `verify`, because tree-side CI workflows and humans inspecting a tree
 *   by hand still need a structure validator.
 * - `tree`, because agents and scripted consumers need a lightweight
 *   Context Tree hierarchy browser.
 *
 * Everything else — `init` / `migrate` / `upgrade` / `status` /
 * `codeowners` / `claude-hook` / `inject` / `review` / `automation` /
 * `skill` groups — was deleted because the cloud now owns workspace + tree
 * provisioning, agent runtime now inlines its own skill payload install (PR
 * #844), and the deleted commands had no remaining caller. See PR following
 * #844 for the deletion commit.
 */
export function registerTreeCommands(program: Command): void {
  treeCommand.register(program);
}

export const treeCommand: CommandModule = {
  name: "tree",
  description: "Validate or browse a Context Tree.",
  register(program: Command): void {
    const command = program
      .command("tree")
      .description("Validate or browse a Context Tree.")
      .helpCommand(false)
      .allowExcessArguments(false)
      .action(() => {
        command.outputHelp();
      });

    registerSubcommands(command, [verifyCommand, treeTreeCommand]);
  },
};
