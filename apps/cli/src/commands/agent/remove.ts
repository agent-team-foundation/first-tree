import { existsSync } from "node:fs";
import { join } from "node:path";
import { defaultConfigDir } from "@first-tree/shared/config";
import type { Command } from "commander";
import { assertRemovableAgentName, removeLocalAgent } from "../../core/index.js";
import { print } from "../../core/output.js";

export function registerAgentRemoveCommand(agent: Command): void {
  agent
    .command("remove <name>")
    .description(
      "Remove an agent from this client and delete its local runtime data (config dir, workspace, session state)",
    )
    .action((name: string) => {
      // Validate before any filesystem access: an invalid name must fail
      // closed as a clean CLI error instead of reaching path construction.
      try {
        assertRemovableAgentName(name);
      } catch (error) {
        print.line(`  ${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
      }
      const agentDir = join(defaultConfigDir(), "agents", name);
      if (!existsSync(agentDir)) {
        print.line(`  Agent "${name}" not found.\n`);
        process.exit(1);
      }
      removeLocalAgent(name);
      print.line(`  Agent "${name}" removed.\n`);
    });
}
