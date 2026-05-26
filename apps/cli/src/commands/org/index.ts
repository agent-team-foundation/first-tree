import type { Command } from "commander";
import { registerOrgBindTreeCommand } from "./bind-tree.js";

/**
 * `first-tree org` — organization-level operations.
 *
 * Today this only ships `bind-tree`, called by onboarding agents after they
 * create a fresh context-tree GitHub repo so the Hub records the binding in
 * the org's `context_tree` settings namespace. The verb mirrors first-tree
 * CLI's own `tree bind` vocabulary so agents reading "bind-tree" know what
 * it means without translation. See first-tree-context:agent-hub/onboarding.md §7.4
 * (Path B).
 */
export function registerOrgCommands(program: Command): void {
  const org = program.command("org").description("Organization-level operations");
  registerOrgBindTreeCommand(org);
}
