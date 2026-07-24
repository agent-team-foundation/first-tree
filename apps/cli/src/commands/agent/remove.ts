import { lstatSync } from "node:fs";
import { join } from "node:path";
import { persistedAgentNameSchema } from "@first-tree/shared";
import { defaultConfigDir } from "@first-tree/shared/config";
import type { Command } from "commander";
import { fail } from "../../cli/output.js";
import {
  INVALID_LOCAL_AGENT_NAME_MESSAGE,
  LocalAgentRemovalError,
  sanitizedFsMessage,
  UNKNOWN_LOCAL_AGENT_REMOVAL_MESSAGE,
} from "../../core/agent-prune.js";
import { removeLocalAgent } from "../../core/index.js";
import { print } from "../../core/output.js";

function isErrno(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

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
      try {
        lstatSync(join(defaultConfigDir(), "agents", safeName));
      } catch (error) {
        if (isErrno(error, "ENOENT")) {
          print.line(`  Agent "${safeName}" not found.\n`);
          process.exit(1);
        }
        fail("REMOVE_ERROR", sanitizedFsMessage("Unable to inspect the local agent configuration safely", error));
      }

      try {
        removeLocalAgent(safeName);
      } catch (error) {
        const message = error instanceof LocalAgentRemovalError ? error.message : UNKNOWN_LOCAL_AGENT_REMOVAL_MESSAGE;
        fail("REMOVE_ERROR", message);
      }

      print.line(`  Agent "${safeName}" removed.\n`);
    });
}
