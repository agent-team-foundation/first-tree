import { join } from "node:path";
import {
  agentConfigSchema,
  clientConfigSchema,
  DEFAULT_CONFIG_DIR,
  DEFAULT_DATA_DIR,
  DEFAULT_HOME_DIR,
  initConfig,
  loadAgents,
  resetConfig,
  resetConfigMeta,
} from "@agent-team-foundation/first-tree-hub-shared/config";
import {
  applyClientLoggerConfig,
  ClientOrgMismatchError,
  configureClientLoggerForService,
} from "@first-tree-hub/client";
import type { Command } from "commander";
import { fail } from "../cli/output.js";
import {
  ClientRuntime,
  COMMAND_VERSION,
  checkAgentConfigs,
  checkClientConfig,
  checkNodeVersion,
  checkServerReachable,
  checkWebSocket,
  createApiNameResolver,
  createExecuteUpdate,
  declineUpdate,
  ensureFreshAccessToken,
  getClientServiceStatus,
  handleClientOrgMismatch,
  installClientService,
  isServiceSupported,
  migrateLocalAgentDirs,
  parseDuration,
  printResults,
  promptMissingFields,
  promptUpdate,
  resolveServerUrl,
  showServiceLogs,
  uninstallClientService,
  validateLevel,
} from "../core/index.js";
import { print } from "../core/output.js";
import { registerConnectCommand } from "./connect.js";

export function registerClientCommands(program: Command): void {
  const client = program.command("client").description("Client runtime — connect agents to the server");

  // `client connect` — first-time setup: configure server URL, authenticate,
  // and start the runtime. Registered here so all machine-level commands live
  // under a single `client` subcommand group.
  registerConnectCommand(client);

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

        // Wire the resolved logLevel into the client logger — without this,
        // `logLevel: debug` in client.yaml is parsed but never reaches pino.
        applyClientLoggerConfig({ level: config.logLevel });

        // Service mode (launchd / systemd): route pino through a rotating
        // NDJSON file instead of stderr, so the supervisor's stdout/stderr
        // capture stays empty under normal operation.
        if (process.env.FIRST_TREE_HUB_SERVICE_MODE === "1") {
          configureClientLoggerForService(join(DEFAULT_HOME_DIR, "logs"));
        }

        // Load agents (may be empty — client can start without agents).
        // Phase 3 of the agent-naming refactor: run the local-dir rename
        // migration BEFORE `loadAgents` so any config dir whose name
        // drifted from the server-side `agent.name` slug is renamed
        // first. `loadAgents` then enumerates the up-to-date layout.
        // The migration is best-effort — it never blocks startup.
        const agentsDir = join(DEFAULT_CONFIG_DIR, "agents");
        try {
          await migrateLocalAgentDirs({
            agentsDir,
            workspacesDir: join(DEFAULT_DATA_DIR, "workspaces"),
            sessionsDir: join(DEFAULT_DATA_DIR, "sessions"),
            resolver: createApiNameResolver(config.server.url, () => ensureFreshAccessToken()),
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          print.status("⚠️", `agent-dir migration skipped: ${msg}`);
        }
        const agents = loadAgents({ schema: agentConfigSchema, agentsDir });

        print.line(`\n  Connecting to ${config.server.url} (client id: ${config.client.id})...\n`);

        // `--no-interactive` is the signal the service units (launchd /
        // systemd) set — we piggy-back on it for two things: (1) suppress
        // the update-confirm prompt so policy=prompt doesn't block a
        // supervised run, (2) enable exit-for-restart since the supervisor
        // will relaunch us on the new binary.
        const managed = options.interactive === false;
        const runtime = new ClientRuntime(config.server.url, config.client.id, {
          currentVersion: COMMAND_VERSION,
          update: {
            updateConfig: config.update,
            prompt: managed ? declineUpdate : promptUpdate,
            executeUpdate: createExecuteUpdate({ managed }),
          },
        });
        for (const [name, agentConfig] of agents) {
          runtime.addAgent(name, agentConfig);
        }

        await runtime.start();

        // Watch agents config dir for hot-add
        runtime.watchAgentsDir(agentsDir);

        // Graceful shutdown
        const shutdown = async () => {
          print.line("\n  Shutting down...\n");
          runtime.unwatchAgentsDir();
          await runtime.stop();
          process.exit(0);
        };
        process.on("SIGINT", () => void shutdown());
        process.on("SIGTERM", () => void shutdown());

        // Keep process alive
        await new Promise(() => {});
      } catch (error) {
        if (error instanceof ClientOrgMismatchError) {
          await handleClientOrgMismatch(error, {
            managed: options.interactive === false,
            configDir: DEFAULT_CONFIG_DIR,
            rerunCommand: "first-tree-hub client start",
          });
        }
        const msg = error instanceof Error ? error.message : String(error);
        print.line(`  Error: ${msg}\n`);
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
      print.line("\n  First Tree Hub Client Doctor\n\n");
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
      print.line("  Client stop: use Ctrl+C or `kill` the running process.\n");
      print.line("  Daemon mode with PID file is planned for a future release.\n");
    });

  client
    .command("status")
    .description("Show client and agent connection status")
    .action(() => {
      const agentsDir = join(DEFAULT_CONFIG_DIR, "agents");
      try {
        const agents = loadAgents({ schema: agentConfigSchema, agentsDir });
        if (agents.size === 0) {
          print.line("  No agents configured.\n");
          return;
        }
        print.line("\n  Configured agents:\n\n");
        for (const [name, config] of agents) {
          print.line(`  ${name.padEnd(20)} runtime: ${config.runtime.padEnd(14)} agentId: ${config.agentId}\n`);
        }
        print.line("\n");
      } catch {
        print.line("  No agents directory found.\n");
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
        print.line(
          `  Background service is not supported on ${process.platform}.\n` +
            "  Run `first-tree-hub client start` manually to keep the computer online.\n",
        );
        process.exit(1);
      }
      try {
        const info = installClientService();
        print.line(`\n  \u2713 Installed as a background service (${info.platform}).\n`);
        print.line(`    Unit:  ${info.unitPath}\n`);
        print.line(`    Logs:  ${info.logDir}\n`);
        if (info.state === "active") {
          print.line(`    State: running${info.detail ? ` (${info.detail})` : ""}\n`);
        } else {
          print.line(`    State: ${info.state}${info.detail ? ` (${info.detail})` : ""}\n`);
        }
        print.line("\n  You can close this terminal — the computer stays online.\n");
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
        print.line(`  Not supported on ${process.platform}.\n`);
        return;
      }
      print.line(`\n  ${info.platform}: ${info.label}\n`);
      print.line(`  Unit:  ${info.unitPath}\n`);
      print.line(`  Logs:  ${info.logDir}\n`);
      print.line(`  State: ${info.state}${info.detail ? ` (${info.detail})` : ""}\n\n`);
    });

  service
    .command("uninstall")
    .description("Stop and remove the background service")
    .action(() => {
      if (!isServiceSupported()) {
        print.line(`  Not supported on ${process.platform}.\n`);
        return;
      }
      try {
        const info = uninstallClientService();
        print.line(`\n  \u2713 Uninstalled background service (${info.platform}).\n\n`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        fail("SERVICE_UNINSTALL_ERROR", msg);
      }
    });

  service
    .command("logs")
    .description("Read background-service logs (pretty by default)")
    .option("-f, --tail", "follow new lines as they arrive (Ctrl+C to stop)", false)
    .option("--since <duration>", "only show records newer than duration (e.g. 10s, 5m, 2h, 1d)")
    .option("--level <level>", "minimum level (trace|debug|info|warn|error|fatal)")
    .option("--json", "emit raw NDJSON lines instead of pretty formatting", false)
    .action(async (options: { tail?: boolean; since?: string; level?: string; json?: boolean }) => {
      try {
        const level = validateLevel(options.level);
        const sinceMs = options.since ? parseDuration(options.since) : undefined;
        await showServiceLogs({
          tail: options.tail === true,
          level,
          sinceMs,
          json: options.json === true,
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        fail("SERVICE_LOGS_ERROR", msg);
      }
    });

  // ── M1: Hub-level client management ────────────────────────────────

  client
    .command("hub-list")
    .description("List clients on the Hub server")
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
          print.line("  No clients.\n");
          return;
        }

        print.line(`\n  Clients: ${clients.length}\n\n`);
        const header = `  ${"CLIENT".padEnd(20)} ${"HOST".padEnd(25)} ${"AGENTS".padEnd(8)} CONNECTED`;
        print.line(`${header}\n`);
        print.line(`  ${"─".repeat(header.length - 2)}\n`);
        for (const c of clients) {
          const since = c.connectedAt ? timeSince(c.connectedAt) : "—";
          print.line(
            `  ${c.id.padEnd(20)} ${(c.hostname ?? "—").padEnd(25)} ${String(c.agentCount).padEnd(8)} ${since}\n`,
          );
        }
        print.line("\n");
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
        const response = await fetch(`${serverUrl}/api/v1/clients/${clientId}/disconnect`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) {
          fail("DISCONNECT_ERROR", `Server returned ${response.status}`, 1);
        }
        print.line(`  Client "${clientId}" disconnected.\n`);
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
