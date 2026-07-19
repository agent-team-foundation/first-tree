import type { Command } from "commander";
import { registerSubcommands } from "../groups.js";
import type { CommandModule } from "../types.js";
import { initCommand } from "./init.js";
import { treeReadCommand } from "./read.js";
import { treeTreeCommand } from "./tree.js";
import { verifyCommand } from "./verify.js";

/**
 * The `first-tree tree` namespace was retired in 2026-06 except for:
 * - `verify`, because tree-side CI workflows and humans inspecting a tree
 *   by hand still need a structure validator.
 * - `tree`, because agents and scripted consumers need a lightweight
 *   Context Tree hierarchy browser.
 * - `read`, because BYO working agents need one strict Team authority check,
 *   one fetch, and one exact task snapshot before hierarchy or file reads.
 *
 * `init` was reintroduced in 2026-07 in a different shape than the deleted
 * one: instead of onboarding a local workspace root, it creates a new team
 * Context Tree *repo* with the user's local `gh` (create + seed + push + add
 * to the App installation + bind). This moves new-tree provisioning off the
 * server GitHub App and onto the user's agent — the App no longer needs
 * `administration/contents/workflows: write`, and personal-account trees stop
 * needing a special server user-token path.
 *
 * The rest — `migrate` / `upgrade` / `status` / `codeowners` / `claude-hook` /
 * `inject` / `review` / `automation` / `skill` groups — stays deleted (cloud
 * owns those, or the agent runtime inlines its own skill payload install).
 */
export function registerTreeCommands(program: Command): void {
  treeCommand.register(program);
}

export const treeCommand: CommandModule = {
  name: "tree",
  description: "Activate, validate, or browse a Context Tree.",
  register(program: Command): void {
    const command = program
      .command("tree")
      .description("Activate, validate, or browse a Context Tree.")
      .helpCommand(false)
      .allowExcessArguments(false)
      .action(() => {
        command.outputHelp();
      });

    registerSubcommands(command, [verifyCommand, treeTreeCommand, treeReadCommand, initCommand]);
  },
};
