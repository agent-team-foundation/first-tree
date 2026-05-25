import type { Command } from "commander";
import { success } from "../../../cli/output.js";
import { createSdk, handleSdkError } from "../../_shared/local-agent.js";

export function registerAgentDebugRegisterCommand(debugCmd: Command): void {
  debugCmd
    .command("register")
    .description("Register this agent and return identity info")
    .option("--agent <name>", "Agent name on the Hub (default: first configured on this client)")
    .action(async (options: { agent?: string }) => {
      try {
        const sdk = createSdk(options.agent);
        const result = await sdk.register();
        success(result);
      } catch (error) {
        handleSdkError(error);
      }
    });
}
