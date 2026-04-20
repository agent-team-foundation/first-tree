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
  getClientServiceStatus,
  installClientService,
  isServiceSupported,
  printResults,
  promptMissingFields,
  resolveServerUrl,
  uninstallClientService,
} from "../core/index.js";
import { registerConnectCommand } from "./connect.js";

export function registerClientCommands(program: Command): void {
  const client = program
    .command("client")
    .description("Connect this computer's agents to the Hub (start/stop/status/doctor)");

  // `client connect` — first-time setup: configure server URL, authenticate,
  // and start the runtime. Registered here so all machine-level commands live
  // under a single `client` subcommand group.
  registerConnectCommand(client);

  client
    .command("start")
    .description("Start this computer — connect all configured agents to the Hub")
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

        // Load agents (may be empty — a computer can start without agents)
        const agentsDir = join(DEFAULT_CONFIG_DIR, "agents");
        const agents = loadAgents({ schema: agentConfigSchema, agentsDir });

        process.stderr.write(`\n  Connecting to ${config.server.url} (computer id: ${config.client.id})...\n`);

        const runtime = new ClientRuntime(config.server.url, config.client.id);
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
    .description("Check this computer's environment readiness")
    .action(async () => {
      process.stderr.write("\n  First Tree Hub Computer Doctor\n\n");
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
    .description("Stop this computer (sends SIGTERM to running process)")
    .action(() => {
      process.stderr.write("  To stop: use Ctrl+C or `kill` the running process.\n");
      process.stderr.write("  Daemon mode with PID file is planned for a future release.\n");
    });

  client
    .command("status")
    .description("Show this computer and agent connection status")
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

  // ── Background service (launchd / systemd --user) ─────────────────

  const service = client
    .command("service")
    .description("Install/uninstall the background service that keeps this computer online");

  service
    .command("install")
    .description("Install as a background service — auto-starts on login/boot")
    .action(() => {
      if (!isServiceSupported()) {
        process.stderr.write(
          `  Background service is not supported on ${process.platform}.\n` +
            "  Run `first-tree-hub client start` manually to keep the computer online.\n",
        );
        process.exit(1);
      }
      try {
        const info = installClientService();
        process.stderr.write(`\n  \u2713 Installed as a background service (${info.platform}).\n`);
        process.stderr.write(`    Unit:  ${info.unitPath}\n`);
        process.stderr.write(`    Logs:  ${info.logDir}\n`);
        if (info.state === "active") {
          process.stderr.write(`    State: running${info.detail ? ` (${info.detail})` : ""}\n`);
        } else {
          process.stderr.write(`    State: ${info.state}${info.detail ? ` (${info.detail})` : ""}\n`);
        }
        process.stderr.write("\n  You can close this terminal — the computer stays online.\n");
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        fail("SERVICE_INSTALL_ERROR", msg);
      }
    });

  service
    .command("status")
    .description("Show background service state")
    .action(() => {
      const info = getClientServiceStatus();
      if (info.platform === "unsupported") {
        process.stderr.write(`  Not supported on ${process.platform}.\n`);
        return;
      }
      process.stderr.write(`\n  ${info.platform}: ${info.label}\n`);
      process.stderr.write(`  Unit:  ${info.unitPath}\n`);
      process.stderr.write(`  Logs:  ${info.logDir}\n`);
      process.stderr.write(`  State: ${info.state}${info.detail ? ` (${info.detail})` : ""}\n\n`);
    });

  service
    .command("uninstall")
    .description("Stop and remove the background service")
    .action(() => {
      if (!isServiceSupported()) {
        process.stderr.write(`  Not supported on ${process.platform}.\n`);
        return;
      }
      try {
        const info = uninstallClientService();
        process.stderr.write(`\n  \u2713 Uninstalled background service (${info.platform}).\n\n`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        fail("SERVICE_UNINSTALL_ERROR", msg);
      }
    });

  // ── M1: Hub-level computer management ──────────────────────────────

  client
    .command("hub-list")
    .description("List computers connected to the Hub")
    .option("--server <url>", "Hub server URL")
    .action(async (options: { server?: string }) => {
      try {
        const serverUrl = resolveServerUrl(options.server);
        const token = await ensureFreshAccessToken();
        const response = await fetch(`${serverUrl}/api/v1/clients`, {
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
          process.stderr.write("  No computers connected.\n");
          return;
        }

        process.stderr.write(`\n  Connected Computers: ${clients.length}\n\n`);
        const header = `  ${"COMPUTER".padEnd(20)} ${"HOST".padEnd(25)} ${"AGENTS".padEnd(8)} CONNECTED`;
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
    .description("Force-disconnect a computer from the Hub")
    .option("--server <url>", "Hub server URL")
    .action(async (clientId: string, options: { server?: string }) => {
      try {
        const serverUrl = resolveServerUrl(options.server);
        const token = await ensureFreshAccessToken();
        const response = await fetch(`${serverUrl}/api/v1/clients/${clientId}/disconnect`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) {
          fail("DISCONNECT_ERROR", `Server returned ${response.status}`, 1);
        }
        process.stderr.write(`  Computer "${clientId}" disconnected.\n`);
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
