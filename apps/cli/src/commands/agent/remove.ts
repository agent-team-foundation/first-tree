import { persistedAgentNameSchema } from "@first-tree/shared";
import type { Command } from "commander";
import { fail } from "../../cli/output.js";
import {
  INVALID_LOCAL_AGENT_NAME_MESSAGE,
  LocalAgentRemovalError,
  UNKNOWN_LOCAL_AGENT_REMOVAL_MESSAGE,
} from "../../core/agent-prune.js";
import { removeLocalAgent } from "../../core/index.js";
import { print } from "../../core/output.js";

export function registerAgentRemoveCommand(agent: Command): void {
  agent
    .command("remove <name>")
    .description(
      "Remove an agent from this client and delete its local runtime data (config dir, workspace, session state)",
    )
    .action((name: string) => {
      const parsedName = persistedAgentNameSchema.safeParse(name);
      if (!parsedName.success) {
        fail("INVALID_AGENT_NAME", INVALID_LOCAL_AGENT_NAME_MESSAGE, 2);
      }

      const safeName = parsedName.data;
      let configurationFound: boolean;
      try {
        configurationFound = removeLocalAgent(safeName);
      } catch (error) {
        const message = error instanceof LocalAgentRemovalError ? error.message : UNKNOWN_LOCAL_AGENT_REMOVAL_MESSAGE;
        fail("REMOVE_ERROR", message);
      }

      if (!configurationFound) {
        print.line(`  Agent "${safeName}" not found.\n`);
        process.exit(1);
      }
      print.line(`  Agent "${safeName}" removed.\n`);
    });
}
