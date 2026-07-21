import type { Command } from "commander";
import { registerSubcommands } from "../groups.js";
import type { CommandModule } from "../types.js";
import { initCommand } from "./init.js";
import { treeReadCommand } from "./read.js";
import { treeReviewCommand } from "./review.js";
import { treeSeedCommand } from "./seed.js";
import { treeTreeCommand } from "./tree.js";
import { verifyCommand } from "./verify.js";
import { treeWriteCommand } from "./write.js";

/**
 * The `first-tree tree` namespace was retired in 2026-06 except for:
 * - `verify`, because tree-side CI workflows and humans inspecting a tree
 *   by hand still need a structure validator.
 * - `tree`, because agents and scripted consumers need a lightweight
 *   Context Tree hierarchy browser.
 * - `read`, because BYO working agents need one strict Team authority check,
 *   one fetch, and one exact task snapshot before hierarchy or file reads.
 * - `write`, because a clean source-backed writer must revalidate that exact
 *   snapshot against Server current Team, Reviewer, binding, and GitHub
 *   identity before authoring and immediately before its first remote write.
 * - `review`, because a trusted Context Reviewer run needs a narrow GitHub App
 *   publication command bound to its current chat, runtime session, and head.
 * - `seed`, because a clean setup agent needs a stateless read of one explicit
 *   Team's current Admin authority and binding before every Seed mutation.
 *
 * `init` was reintroduced in 2026-07 in a different shape than the deleted
 * one: instead of onboarding a local workspace root, it creates a new team
 * Context Tree *repo* with the user's local `gh` (create + seed + push + add
 * to the App installation + bind). This keeps the current App permission and
 * legacy provisioning surfaces intact while moving the preferred setup path
 * onto the user's agent.
 *
 * The rest — `migrate` / `upgrade` / `status` / `codeowners` / `claude-hook` /
 * `inject` / `automation` / `skill` groups — stays deleted (cloud
 * owns those, or the agent runtime inlines its own skill payload install).
 */
export function registerTreeCommands(program: Command): void {
  treeCommand.register(program);
}

export const treeCommand: CommandModule = {
  name: "tree",
  description: "Activate, preflight, validate, or browse a Context Tree.",
  register(program: Command): void {
    const command = program
      .command("tree")
      .description("Activate, preflight, validate, or browse a Context Tree.")
      .helpCommand(false)
      .allowExcessArguments(false)
      .action(() => {
        command.outputHelp();
      });

    registerSubcommands(command, [
      verifyCommand,
      treeTreeCommand,
      treeReadCommand,
      treeWriteCommand,
      treeReviewCommand,
      treeSeedCommand,
      initCommand,
    ]);
  },
};
