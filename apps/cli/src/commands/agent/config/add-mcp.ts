import type { Command } from "commander";
import { fail } from "../../../cli/output.js";

const LEGACY_MCP_WRITE_DISABLED_MESSAGE =
  "Legacy per-agent MCP config writes are disabled. MCP configuration will be managed by Team MCP Resources.";

export function registerAgentConfigAddMcpCommand(config: Command): void {
  config
    .command("add-mcp <agent>")
    .description("Disabled: legacy per-agent MCP config writes are closed")
    .option("--name <name>", "MCP server name")
    .option("--transport <transport>", "stdio | http | sse")
    .option("--command <command>", "stdio command")
    .option("--args <args...>", "stdio command args")
    .option("--url <url>", "http/sse URL")
    .action(async () => {
      fail("LEGACY_MCP_CONFIG_DISABLED", LEGACY_MCP_WRITE_DISABLED_MESSAGE, 2);
    });
}
