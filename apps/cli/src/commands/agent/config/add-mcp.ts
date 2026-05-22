import type { AgentRuntimeConfigPayload } from "@first-tree/shared";
import type { Command } from "commander";
import { fail, success } from "../../../cli/output.js";
import { ensureFreshAdminToken, resolveServerUrl } from "../../../core/bootstrap.js";
import { getCurrent, patchConfig, resolveAgentRecord } from "./_shared/fetchers.js";

export function registerAgentConfigAddMcpCommand(config: Command): void {
  config
    .command("add-mcp <agent>")
    .description("Add or replace an MCP server (replace-by-name semantics)")
    .requiredOption("--name <name>", "MCP server name")
    .requiredOption("--transport <transport>", "stdio | http | sse")
    .option("--command <command>", "stdio command")
    .option("--args <args...>", "stdio command args")
    .option("--url <url>", "http/sse URL")
    .action(
      async (
        agentName: string,
        opts: { name: string; transport: string; command?: string; args?: string[]; url?: string },
      ) => {
        const serverUrl = resolveServerUrl(process.env.FIRST_TREE_SERVER_URL);
        const adminToken = await ensureFreshAdminToken();
        const { uuid } = await resolveAgentRecord(serverUrl, adminToken, agentName);
        const current = await getCurrent(serverUrl, adminToken, uuid);

        let server: AgentRuntimeConfigPayload["mcpServers"][number];
        if (opts.transport === "stdio") {
          if (!opts.command) fail("MISSING_COMMAND", "stdio transport requires --command", 2);
          server = { name: opts.name, transport: "stdio", command: opts.command, args: opts.args };
        } else if (opts.transport === "http" || opts.transport === "sse") {
          if (!opts.url) fail("MISSING_URL", `${opts.transport} transport requires --url`, 2);
          server = { name: opts.name, transport: opts.transport, url: opts.url };
        } else {
          fail("BAD_TRANSPORT", `transport must be stdio|http|sse, got ${opts.transport}`, 2);
        }

        const remaining = current.payload.mcpServers.filter((s) => s.name !== opts.name);
        const updated = await patchConfig(serverUrl, adminToken, uuid, current.version, {
          mcpServers: [...remaining, server],
        });
        success({ agentId: updated.agentId, version: updated.version, mcpServer: opts.name });
      },
    );
}
