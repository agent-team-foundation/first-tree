import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { defaultConfigDir, setConfigValue } from "@first-tree/shared/config";
import type { Command } from "commander";
import { fail } from "../../cli/output.js";
import { promptAddAgent } from "../../core/index.js";
import { print } from "../../core/output.js";

export function registerAgentAddCommand(agent: Command): void {
  agent
    .command("add")
    .description("Register an existing Hub agent on this client (uses the agent name from the Hub)")
    .option("--agent-id <id>", "Agent UUID on the Hub")
    .action(async (options?: { agentId?: string }) => {
      try {
        // Phase 3 of the agent-naming refactor retired the free-form local
        // alias — the local config dir is always keyed by the server-side
        // `agent.name`. The prompt helper fetches that name from the Hub
        // given the agent UUID.
        const { name: agentName, agentId } = await promptAddAgent({ agentId: options?.agentId });
        if (!agentName || !agentId) {
          fail("MISSING_AGENT_ARGS", "Agent UUID (and a hub name for that UUID) are required.", 2);
        }

        const agentDir = join(defaultConfigDir(), "agents", agentName);
        mkdirSync(agentDir, { recursive: true, mode: 0o700 });
        setConfigValue(join(agentDir, "agent.yaml"), "agentId", agentId);

        print.line(`  Agent "${agentName}" added.\n`);
        print.line(`  Config: ${join(agentDir, "agent.yaml")}\n`);
      } catch (error) {
        if ((error as { name?: string }).name === "ExitPromptError") {
          print.line("\n  Cancelled.\n");
          return;
        }
        const msg = error instanceof Error ? error.message : String(error);
        print.line(`  Error: ${msg}\n`);
        process.exit(1);
      }
    });
}
