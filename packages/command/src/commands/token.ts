import type { Command } from "commander";
import { fail, success } from "../cli/output.js";
import { bootstrapToken, resolveServerUrl } from "../core/bootstrap.js";

export function registerTokenCommands(program: Command): void {
  const token = program.command("token").description("Agent token management");

  token
    .command("bootstrap <agentId>")
    .description("Bootstrap a token using GitHub identity (requires gh CLI)")
    .option("--save-to <target>", 'Save token to: "agent" (default) or a file path', "agent")
    .option("--server <url>", "Hub server URL")
    .action(async (agentId: string, options: { saveTo: string; server?: string }) => {
      try {
        const serverUrl = resolveServerUrl(options.server);
        const result = await bootstrapToken(serverUrl, agentId, { saveTo: options.saveTo });

        if (options.saveTo === "agent") {
          process.stderr.write(`Token saved to ~/.first-tree-hub/agents/${agentId}/agent.yaml\n`);
        } else {
          process.stderr.write(`Token saved to ${options.saveTo}\n`);
        }

        success({ agentId: result.agentId, tokenSaved: true });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        fail("BOOTSTRAP_ERROR", msg);
      }
    });
}
