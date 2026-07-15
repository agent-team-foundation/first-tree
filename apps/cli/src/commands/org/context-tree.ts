import type { Command } from "commander";
import { fail, success } from "../../cli/output.js";
import { ContextTreeUnreadableError, readAgentContextTreeBinding } from "../../core/context-tree-binding.js";
import {
  type ContextTreeBindingInput,
  ContextTreeUpdateFailedError,
  InvalidContextTreeBindingInputError,
  setAgentContextTreeBinding,
  validateContextTreeBindingInput,
} from "../../core/context-tree-binding-write.js";
import { print } from "../../core/output.js";
import { createSdk } from "../_shared/local-agent.js";

type ContextTreeOptions = {
  agent?: string;
};

type SetContextTreeOptions = ContextTreeOptions & {
  branch?: string;
};

export function registerOrgContextTreeCommand(org: Command): void {
  const contextTree = org
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

  const setContextTree = contextTree
    .command("set")
    .description("Set the Context Tree binding for the current agent's organization")
    .argument("<repo>", "HTTPS, ssh://, or scp-like SSH repository URL")
    .option("--branch <branch>", "Set the branch; omit to preserve the existing branch or default to main")
    .option("--agent <name>", "Agent name on this client (default: environment or the only configured agent)")
    .action(async (repo: string) => {
      // Commander may store an option shared with the parent command on the
      // parent even when it appears after `set`; merge both scopes explicitly.
      const options = setContextTree.optsWithGlobals<SetContextTreeOptions>();
      let input: ContextTreeBindingInput;
      try {
        input = validateContextTreeBindingInput({ repo, branch: options.branch });
      } catch (error) {
        if (error instanceof InvalidContextTreeBindingInputError) {
          fail(error.code, error.message, error.exitCode);
        }
        throw error;
      }

      // Keep local-agent resolution outside the update error boundary so its
      // established selection errors and exit code 2 remain unchanged.
      const sdk = createSdk(options.agent);

      try {
        const binding = await setAgentContextTreeBinding(sdk, input, { agent: options.agent });
        print.status("Context Tree", "Bound");
        print.status("Repository", binding.repo);
        print.status("Branch", binding.branch);
        success(binding);
      } catch (error) {
        if (error instanceof ContextTreeUpdateFailedError) {
          print.status("Context Tree", "Update failed");
          fail(error.code, error.message, error.exitCode);
        }
        throw error;
      }
    });
}
