import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { AgentRuntimeConfigPayload } from "@first-tree/shared";

/**
 * Map a payload's MCP server list to the SDK's record type. Handles all three
 * transports (stdio/http/sse) defined in the M1 schema.
 */
export function mapMcpServers(payload: AgentRuntimeConfigPayload): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  for (const s of payload.mcpServers) {
    if (s.transport === "stdio") {
      out[s.name] = { type: "stdio", command: s.command, args: s.args };
    } else if (s.transport === "http") {
      out[s.name] = { type: "http", url: s.url, headers: s.headers };
    } else {
      out[s.name] = { type: "sse", url: s.url, headers: s.headers };
    }
  }
  return out;
}
