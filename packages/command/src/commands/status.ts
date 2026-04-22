import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  agentConfigSchema,
  DEFAULT_CONFIG_DIR,
  loadAgents,
  readConfigFile,
} from "@agent-team-foundation/first-tree-hub-shared/config";
import type { Command } from "commander";
import { print } from "../core/output.js";

export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description("Global overview — server health + configured agents")
    .action(async () => {
      print.line("\n");

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
          print.line(`  Server:     ✓ running (${serverUrl}, uptime: ${uptime})\n`);
        } else {
          print.line(`  Server:     ✗ unhealthy (${res.status})\n`);
        }
      } catch {
        print.line(`  Server:     ✗ not running (${serverUrl})\n`);
      }

      // Database status
      const dbProvider = getNestedValue(serverConfig, "database.provider") ?? "unknown";
      const hasDbUrl = getNestedValue(serverConfig, "database.url") !== undefined;
      print.line(`  Database:   ${hasDbUrl ? "✓ configured" : "✗ not configured"} (${dbProvider})\n`);

      // Agents (client side)
      const agentsDir = join(DEFAULT_CONFIG_DIR, "agents");
      if (existsSync(agentsDir)) {
        try {
          const agents = loadAgents({ schema: agentConfigSchema, agentsDir });
          print.line(`  Agents:     ${agents.size} configured\n`);
        } catch {
          print.line("  Agents:     error reading config\n");
        }
      } else {
        print.line("  Agents:     0 configured\n");
      }

      // Client config
      const clientConfigPath = join(DEFAULT_CONFIG_DIR, "client.yaml");
      if (existsSync(clientConfigPath)) {
        const clientConfig = readConfigFile(clientConfigPath);
        const clientServerUrl = getNestedValue(clientConfig, "server.url");
        print.line(`  Client:     configured → ${clientServerUrl}\n`);
      } else {
        print.line("  Client:     not configured\n");
      }

      print.line("\n");
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
