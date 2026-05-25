import { existsSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG_DIR } from "@first-tree/shared/config";
import type { Command } from "commander";
import { removeLocalAgent } from "../../core/index.js";
import { print } from "../../core/output.js";

export function registerAgentRemoveCommand(agent: Command): void {
  agent
    .command("remove <name>")
    .description(
      "Remove an agent from this client and delete its local runtime data (config dir, workspace, session state)",
    )
    .action((name: string) => {
      const agentDir = join(DEFAULT_CONFIG_DIR, "agents", name);
      if (!existsSync(agentDir)) {
        print.line(`  Agent "${name}" not found.\n`);
        process.exit(1);
      }
      removeLocalAgent(name);
      print.line(`  Agent "${name}" removed.\n`);
    });
}
