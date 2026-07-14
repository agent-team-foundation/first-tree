import type { Command } from "commander";
import { registerOrgBindTreeCommand } from "./bind-tree.js";
import { registerOrgContextTreeCommand } from "./context-tree.js";

/**
 * `first-tree org` — organization-level operations.
 *
 * `bind-tree` records an organization binding, while `context-tree` reads the
 * binding selected by the current local agent's server-side organization.
 */
export function registerOrgCommands(program: Command): void {
  const org = program.command("org").description("Organization-level operations");
  registerOrgBindTreeCommand(org);
  registerOrgContextTreeCommand(org);
}
