import { join } from "node:path";
import {
  agentConfigSchema,
  clientConfigSchema,
  DEFAULT_CONFIG_DIR,
  initConfig,
  loadAgents,
  resetConfig,
  resetConfigMeta,
} from "@agent-team-foundation/first-tree-hub-shared/config";
import type { Command } from "commander";
import { fail } from "../cli/output.js";
import {
  ClientRuntime,
  checkAgentConfigs,
  checkClientConfig,
  checkNodeVersion,
  checkServerReachable,
  checkWebSocket,
  ensureFreshAccessToken,
  printResults,
  promptMissingFields,
  resolveServerUrl,
} from "../core/index.js";

export function registerClientCommands(program: Command): void {
  const client = program.command("client").description("Client runtime — connect agents to the server");

  client
    .command("start")
    .description("Start client — connect all configured agents to the server")
    .option("--no-interactive", "Skip interactive prompts (for Docker/CI)")
    .action(async (options: { interactive?: boolean }) => {
      try {
        // Schema-driven prompts for missing required fields
        await promptMissingFields({
          schema: clientConfigSchema as Record<string, unknown>,
          role: "client",
          noInteractive: options.interactive === false,
        });

        const config = await initConfig({
          schema: clientConfigSchema,
          role: "client",
        });

        // Load agents (may be empty — client can start without agents)
        const agentsDir = join(DEFAULT_CONFIG_DIR, "agents");
        const agents = loadAgents({ schema: agentConfigSchema, agentsDir });

        process.stderr.write(`\n  Connecting to ${config.server.url}...\n`);

        const runtime = new ClientRuntime(config.server.url);
        for (const [name, agentConfig] of agents) {
          runtime.addAgent(name, agentConfig);
        }

        await runtime.start();

        // Watch agents config dir for hot-add
        runtime.watchAgentsDir(agentsDir);

        // Graceful shutdown
        const shutdown = async () => {
          process.stderr.write("\n  Shutting down...\n");
          runtime.unwatchAgentsDir();
          await runtime.stop();
          process.exit(0);
        };
        process.on("SIGINT", () => void shutdown());
        process.on("SIGTERM", () => void shutdown());

        // Keep process alive
        await new Promise(() => {});
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        process.stderr.write(`  Error: ${msg}\n`);
        process.exit(1);
      } finally {
        // Reset singleton so other commands can reinit
        resetConfig();
        resetConfigMeta();
      }
    });

  client
    .command("doctor")
    .description("Check client environment readiness")
    .action(async () => {
      process.stderr.write("\n  First Tree Hub Client Doctor\n\n");
      const results = [
        checkNodeVersion(),
        checkClientConfig(),
        await checkServerReachable(),
        checkAgentConfigs(),
        await checkWebSocket(),
      ];
      printResults(results);
    });

  client
    .command("stop")
    .description("Stop the client (sends SIGTERM to running process)")
    .action(() => {
      process.stderr.write("  Client stop: use Ctrl+C or `kill` the running process.\n");
      process.stderr.write("  Daemon mode with PID file is planned for a future release.\n");
    });

  client
    .command("status")
    .description("Show client and agent connection status")
    .action(() => {
      const agentsDir = join(DEFAULT_CONFIG_DIR, "agents");
      try {
        const agents = loadAgents({ schema: agentConfigSchema, agentsDir });
        if (agents.size === 0) {
          process.stderr.write("  No agents configured.\n");
          return;
        }
        process.stderr.write("\n  Configured agents:\n\n");
        for (const [name, config] of agents) {
          process.stderr.write(
            `  ${name.padEnd(20)} runtime: ${config.runtime.padEnd(14)} agentId: ${config.agentId}\n`,
          );
        }
        process.stderr.write("\n");
      } catch {
        process.stderr.write("  No agents directory found.\n");
      }
    });

  // ── M1: Hub-level client management ────────────────────────────────

  client
    .command("hub-list")
    .description("List connected clients on the Hub server")
    .option("--server <url>", "Hub server URL")
    .action(async (options: { server?: string }) => {
      try {
        const serverUrl = resolveServerUrl(options.server);
        const token = await ensureFreshAccessToken();
        const response = await fetch(`${serverUrl}/api/v1/admin/clients`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) {
          fail("FETCH_ERROR", `Server returned ${response.status}`, 1);
        }
        const clients = (await response.json()) as Array<{
          id: string;
          hostname: string | null;
          agentCount: number;
          connectedAt: string | null;
          lastSeenAt: string;
        }>;

        if (clients.length === 0) {
          process.stderr.write("  No connected clients.\n");
          return;
        }

        process.stderr.write(`\n  Connected Clients: ${clients.length}\n\n`);
        const header = `  ${"CLIENT".padEnd(20)} ${"HOST".padEnd(25)} ${"AGENTS".padEnd(8)} CONNECTED`;
        process.stderr.write(`${header}\n`);
        process.stderr.write(`  ${"─".repeat(header.length - 2)}\n`);
        for (const c of clients) {
          const since = c.connectedAt ? timeSince(c.connectedAt) : "—";
          process.stderr.write(
            `  ${c.id.padEnd(20)} ${(c.hostname ?? "—").padEnd(25)} ${String(c.agentCount).padEnd(8)} ${since}\n`,
          );
        }
        process.stderr.write("\n");
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        fail("CLIENT_LIST_ERROR", msg);
      }
    });

  client
    .command("hub-disconnect <clientId>")
    .description("Force-disconnect a client from the Hub server")
    .option("--server <url>", "Hub server URL")
    .action(async (clientId: string, options: { server?: string }) => {
      try {
        const serverUrl = resolveServerUrl(options.server);
        const token = await ensureFreshAccessToken();
        const response = await fetch(`${serverUrl}/api/v1/admin/clients/${clientId}/disconnect`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) {
          fail("DISCONNECT_ERROR", `Server returned ${response.status}`, 1);
        }
        process.stderr.write(`  Client "${clientId}" disconnected.\n`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        fail("DISCONNECT_ERROR", msg);
      }
    });
}

function timeSince(isoDate: string): string {
  const ms = Date.now() - new Date(isoDate).getTime();
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}
