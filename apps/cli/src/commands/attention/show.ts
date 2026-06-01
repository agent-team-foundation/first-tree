import type { Command } from "commander";
import { success } from "../../cli/output.js";
import { showAttention } from "../../core/attention/index.js";
import { createSdk, handleSdkError } from "../_shared/local-agent.js";

interface ShowOptions {
  agent?: string;
}

export function registerAttentionShowCommand(parent: Command): void {
  parent
    .command("show <id>")
    .description("Show a single attention by id")
    .option("--agent <name>", "Agent name on the First Tree server (default: first configured on this client)")
    .action(async (id: string, options: ShowOptions) => {
      try {
        const sdk = createSdk(options.agent);
        const attention = await showAttention(sdk, id);
        success(attention);
      } catch (error) {
        handleSdkError(error);
      }
    });
}
