import { existsSync } from "node:fs";
import { join } from "node:path";
import { defaultConfigDir } from "@first-tree/shared/config";
import type { Command } from "commander";
import { isSafeLocalAgentName, removeLocalAgent } from "../../core/index.js";
import { print } from "../../core/output.js";

export function registerAgentRemoveCommand(agent: Command): void {
  agent
    .command("remove <name>")
    .description(
      "Remove an agent from this client and delete its local runtime data (config dir, workspace, session state)",
    )
    .action((name: string) => {
      // Gate BEFORE any filesystem use: the name is joined into recursively
      // deleted paths, so traversal input must never reach existsSync or
      // removeLocalAgent (SEC-030).
      if (!isSafeLocalAgentName(name)) {
        print.line(`  Invalid agent name "${name}". Names are lowercase slugs like "my-agent".\n`);
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
