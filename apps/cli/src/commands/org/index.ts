import type { Command } from "commander";
import { registerOrgBindTreeCommand } from "./bind-tree.js";
import { registerOrgContextTreeCommand } from "./context-tree.js";

/**
 * `first-tree org` — organization-level operations.
 *
 * `bind-tree` preserves the legacy user/default-org write path, while
 * `context-tree` reads or updates the organization selected by a local agent.
 */
export function registerOrgCommands(program: Command): void {
  const org = program.command("org").description("Organization-level operations");
  registerOrgBindTreeCommand(org);
  registerOrgContextTreeCommand(org);
}
