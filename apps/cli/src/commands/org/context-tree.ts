import type { Command } from "commander";
import { fail, success } from "../../cli/output.js";
import { ContextTreeUnreadableError, readAgentContextTreeBinding } from "../../core/context-tree-binding.js";
import { print } from "../../core/output.js";
import { createSdk } from "../_shared/local-agent.js";

type ContextTreeOptions = {
  agent?: string;
};

export function registerOrgContextTreeCommand(org: Command): void {
  org
    .command("context-tree")
    .description("Read the Context Tree binding for the current agent's organization")
    .option("--agent <name>", "Agent name on this client (default: environment or the only configured agent)")
    .action(async (options: ContextTreeOptions) => {
      // Keep local-agent resolution outside the read error boundary so its
      // established selection errors and exit code 2 remain unchanged.
      const sdk = createSdk(options.agent);

      try {
        const binding = await readAgentContextTreeBinding(sdk, { agent: options.agent });

        if (binding.status === "bound") {
          print.status("Context Tree", "Bound");
          print.status("Repository", binding.repo);
          print.status("Branch", binding.branch);
        } else {
          print.status("Context Tree", "Unbound");
          print.line(
            "  Ask an administrator for this agent's organization to bind an existing Context Tree or initialize a new one.\n",
          );
        }

        success(binding);
      } catch (error) {
        if (error instanceof ContextTreeUnreadableError) {
          print.status("Context Tree", "Unreadable");
          fail(error.code, error.message, error.exitCode, { status: error.status });
        }
        throw error;
      }
    });
}
