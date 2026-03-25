import { existsSync } from "node:fs";
import { join } from "node:path";
import { agentConfigSchema, DEFAULT_CONFIG_DIR, loadAgents, readConfigFile } from "@agent-hub/shared/config";
import type { Command } from "commander";

export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description("Global overview — server health + configured agents")
    .action(async () => {
      process.stderr.write("\n");

      // Server status
      const serverConfig = readConfigFile(join(DEFAULT_CONFIG_DIR, "server.yaml"));
      const serverPort = getNestedValue(serverConfig, "server.port") ?? 8000;
      const serverHost = getNestedValue(serverConfig, "server.host") ?? "127.0.0.1";
      const serverUrl = `http://${serverHost}:${serverPort}`;

      try {
        const res = await fetch(`${serverUrl}/api/v1/health`);
        if (res.ok) {
          const data = (await res.json()) as { status: string; version?: string; uptime_seconds?: number };
          const uptime = data.uptime_seconds ? formatUptime(data.uptime_seconds) : "unknown";
          process.stderr.write(`  Server:     ✓ running (${serverUrl}, uptime: ${uptime})\n`);
        } else {
          process.stderr.write(`  Server:     ✗ unhealthy (${res.status})\n`);
        }
      } catch {
        process.stderr.write(`  Server:     ✗ not running (${serverUrl})\n`);
      }

      // Database status
      const dbProvider = getNestedValue(serverConfig, "database.provider") ?? "unknown";
      const hasDbUrl = getNestedValue(serverConfig, "database.url") !== undefined;
      process.stderr.write(`  Database:   ${hasDbUrl ? "✓ configured" : "✗ not configured"} (${dbProvider})\n`);

      // Agents (client side)
      const agentsDir = join(DEFAULT_CONFIG_DIR, "agents");
      if (existsSync(agentsDir)) {
        try {
          const agents = loadAgents({ schema: agentConfigSchema, agentsDir });
          process.stderr.write(`  Agents:     ${agents.size} configured\n`);
        } catch {
          process.stderr.write("  Agents:     error reading config\n");
        }
      } else {
        process.stderr.write("  Agents:     0 configured\n");
      }

      // Client config
      const clientConfigPath = join(DEFAULT_CONFIG_DIR, "client.yaml");
      if (existsSync(clientConfigPath)) {
        const clientConfig = readConfigFile(clientConfigPath);
        const clientServerUrl = getNestedValue(clientConfig, "server.url");
        process.stderr.write(`  Client:     configured → ${clientServerUrl}\n`);
      } else {
        process.stderr.write("  Client:     not configured\n");
      }

      process.stderr.write("\n");
    });
}

function getNestedValue(obj: Record<string, unknown>, dotPath: string): unknown {
  const parts = dotPath.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}
