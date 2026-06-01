import type { Command } from "commander";
import { success } from "../../cli/output.js";
import { cancelAttention } from "../../core/attention/index.js";
import { createSdk, handleSdkError } from "../_shared/local-agent.js";

interface CancelOptions {
  reason?: string;
  agent?: string;
}

export function registerAttentionCancelCommand(parent: Command): void {
  parent
    .command("cancel <id>")
    .description("Cancel an open attention you raised")
    .option("--reason <text>", "Optional cancellation reason recorded on the closed record (max 500 chars)")
    .option("--agent <name>", "Agent name on the First Tree server (default: first configured on this client)")
    .action(async (id: string, options: CancelOptions) => {
      try {
        const sdk = createSdk(options.agent);
        const attention = await cancelAttention(sdk, { id, reason: options.reason });
        success(attention);
      } catch (error) {
        handleSdkError(error);
      }
    });
}
