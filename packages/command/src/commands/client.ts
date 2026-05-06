import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  agentConfigSchema,
  clientConfigSchema,
  DEFAULT_CONFIG_DIR,
  DEFAULT_DATA_DIR,
  DEFAULT_HOME_DIR,
  initConfig,
  loadAgents,
  readConfigFile,
  resetConfig,
  resetConfigMeta,
} from "@agent-team-foundation/first-tree-hub-shared/config";
import {
  applyClientLoggerConfig,
  ClientOrgMismatchError,
  ClientUserMismatchError,
  configureClientLoggerForService,
  FirstTreeHubSDK,
  probeCapabilities,
} from "@first-tree-hub/client";
import { confirm } from "@inquirer/prompts";
import type { Command } from "commander";
import { fail } from "../cli/output.js";
import {
  ClientRuntime,
  COMMAND_VERSION,
  checkAgentConfigs,
  checkBackgroundService,
  checkClientConfig,
  checkNodeVersion,
  checkServerReachable,
  checkWebSocket,
  createApiNameResolver,
  createExecuteUpdate,
  declineUpdate,
  ensureFreshAccessToken,
  findStaleAliases,
  formatStaleReason,
  getClientServiceStatus,
  handleClientOrgMismatch,
  isServiceSupported,
  migrateLocalAgentDirs,
  printResults,
  promptMissingFields,
  promptUpdate,
  reconcileAgentConfigs,
  reconcileLocalRuntimeProviders,
  removeLocalAgent,
  resolveServerUrl,
  restartClientService,
  startClientService,
  stopClientService,
  uploadClientCapabilities,
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
    .option("--foreground", "Run inline instead of delegating to the background service (for debugging)")
    .action(async (options: { interactive?: boolean; foreground?: boolean }) => {
      try {
        // Service-mode delegation. We split four cases so the user gets a
        // single coherent command:
        //   1. service active           → refuse, point at `client restart`
        //   2. service installed/inactive → systemctl/launchctl start
        //   3. service not installed    → fall through to inline run
        //   4. --foreground             → always inline (debug / --no-service users)
        // The supervisor itself reaches this code with --no-interactive and
        // FIRST_TREE_HUB_SERVICE_MODE=1 set; we treat that combo as
        // "supervisor invoking us, run inline" so we don't recursively call
        // systemctl from inside our own ExecStart.
        const isSupervisorChild = options.interactive === false && process.env.FIRST_TREE_HUB_SERVICE_MODE === "1";
        const wantInline = options.foreground === true || isSupervisorChild;
        if (!wantInline && isServiceSupported()) {
          const svc = getClientServiceStatus();
          if (svc.state === "active") {
            print.line("\n");
            print.line(`  Service is already running (${svc.platform}${svc.detail ? `, ${svc.detail}` : ""}).\n`);
            print.line("  Use `first-tree-hub client restart` to restart, or `--foreground` to run inline.\n\n");
            return;
          }
          if (svc.state === "inactive") {
            const res = startClientService();
            if (!res.ok) {
              print.line(`\n  Failed to start service: ${res.reason}\n`);
              print.line("  Try `--foreground` to run inline instead.\n\n");
              process.exit(1);
            }
            const after = getClientServiceStatus();
            print.line("\n");
            print.line(`  Started ${after.platform} service${after.detail ? ` (${after.detail})` : ""}.\n`);
            const journalHint =
              after.platform === "systemd"
                ? `  (or \`journalctl --user -u ${after.label.replace(/\.service$/, "")}\`)`
                : "";
            print.line(`  Logs:  ${after.logDir}${journalHint}\n\n`);
            return;
          }
          if (svc.state === "unknown") {
            // Defensive: launchctl/systemctl probe came back with shape we
            // don't recognise. Falling through to the inline path here would
            // race a still-supervised process for the same client.id, which
            // is exactly the failure mode this whole PR is trying to
            // eliminate. Refuse and let the operator inspect.
            print.line(
              `\n  Service state could not be determined (${svc.platform}${svc.detail ? `: ${svc.detail}` : ""}).\n`,
            );
            print.line("  Inspect with `first-tree-hub client doctor`, or pass `--foreground` to bypass.\n\n");
            process.exit(1);
          }
          // state === "not-installed" → fall through to inline run.
        }

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

        // Pre-flight runtime-provider reconciliation: probe local runtime SDKs
        // and rewrite any local `agent.yaml::runtime` whose value drifted from
        // the authoritative `agents.runtime_provider` (so the spawn loop sees
        // up-to-date config). The capabilities upload itself runs AFTER WS
        // registration — see post-start block — because the `clients` row is
        // created lazily during the `client:register` handshake.
        let probedCapabilities: Awaited<ReturnType<typeof probeCapabilities>> | null = null;
        try {
          const accessToken = await ensureFreshAccessToken();
          probedCapabilities = await probeCapabilities();
          await reconcileLocalRuntimeProviders({
            serverUrl: config.server.url,
            accessToken,
            agentsDir,
            log: (level, msg) => print.status(level === "warn" ? "⚠️" : "•", msg),
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          print.status("⚠️", `runtime-provider reconcile skipped: ${msg}`);
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

        // Post-register capabilities upload — the `clients` row only exists
        // after the `client:register` WS handshake, so we run the PATCH here
        // instead of pre-flight. Best-effort: a transient failure logs and
        // moves on; agents still bind, and a subsequent restart retries.
        if (probedCapabilities) {
          try {
            const accessToken = await ensureFreshAccessToken();
            await uploadClientCapabilities({
              serverUrl: config.server.url,
              accessToken,
              clientId: config.client.id,
              capabilities: probedCapabilities,
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            print.status("⚠️", `capabilities upload skipped: ${msg}`);
          }
        }

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
        if (error instanceof ClientUserMismatchError) {
          print.line("\n");
          print.line("  ⚠️  This client.yaml is owned by a different user.\n");
          print.line("  Run `first-tree-hub client claim --confirm` to transfer ownership\n");
          print.line("  to your account. The previous owner's agents will be unpinned\n");
          print.line("  from this machine.\n\n");
          process.exit(1);
        }
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
      // The "Agents" line cross-references local aliases against the
      // server's pinned-agent set, filtered to THIS client.id (so the
      // verdict matches what R-RUN will accept). Without a configured
      // server URL we can't talk to anything; fall back to the legacy
      // local-only count.
      let agentCheck: Awaited<ReturnType<typeof reconcileAgentConfigs>>;
      try {
        const serverUrl = resolveServerUrl();
        const cfg = await initConfig({ schema: clientConfigSchema, role: "client" });
        const sdk = new FirstTreeHubSDK({ serverUrl, getAccessToken: () => ensureFreshAccessToken() });
        agentCheck = await reconcileAgentConfigs({
          clientId: cfg.client.id,
          listPinnedAgents: () => sdk.listMyAgents(),
        });
      } catch {
        agentCheck = checkAgentConfigs();
      } finally {
        // Doctor is read-only; release the singleton so subsequent
        // commands re-resolve config cleanly.
        resetConfig();
        resetConfigMeta();
      }
      const results = [
        checkNodeVersion(),
        checkClientConfig(),
        await checkServerReachable(),
        agentCheck,
        await checkWebSocket(),
        checkBackgroundService(),
      ];
      printResults(results);
    });

  client
    .command("stop")
    .description("Stop the background service (preserves auto-start; use `client start` to bring it back)")
    .action(() => {
      if (!isServiceSupported()) {
        print.line(`\n  Service control not supported on ${process.platform}.\n`);
        print.line("  If running inline, use Ctrl+C or kill the process.\n\n");
        return;
      }
      const svc = getClientServiceStatus();
      if (svc.state === "not-installed") {
        print.line("\n  No background service installed — nothing to stop.\n");
        print.line("  If running inline, use Ctrl+C or kill the process.\n\n");
        return;
      }
      if (svc.state === "inactive") {
        print.line("\n  Service is already stopped.\n\n");
        return;
      }
      const res = stopClientService();
      if (!res.ok) {
        print.line(`\n  Failed to stop service: ${res.reason}\n\n`);
        process.exit(1);
      }
      print.line(`\n  Stopped ${svc.platform} service.\n`);
      print.line("  Auto-start on next login is preserved. Run `first-tree-hub client start` to bring it back.\n\n");
    });

  client
    .command("restart")
    .description("Restart the background service")
    .action(() => {
      if (!isServiceSupported()) {
        print.line(`\n  Service control not supported on ${process.platform}.\n`);
        print.line("  Restart your inline `client start` process manually.\n\n");
        return;
      }
      const svc = getClientServiceStatus();
      if (svc.state === "not-installed") {
        print.line("\n  No background service installed.\n");
        print.line("  Run `first-tree-hub client connect <url>` first.\n\n");
        process.exit(1);
      }
      const res = restartClientService();
      if (!res.ok) {
        print.line(`\n  Failed to restart service: ${res.reason}\n\n`);
        process.exit(1);
      }
      const after = getClientServiceStatus();
      print.line(`\n  Restarted ${after.platform} service${after.detail ? ` (${after.detail})` : ""}.\n\n`);
    });

  client
    .command("status")
    .description("Show CLI, service, hub, and agent status (one-screen overview)")
    .action(() => {
      print.line("\n");

      // CLI version. Drift check (npm registry) is intentionally NOT run here
      // — `status` should be fast (< 1s, no network). Users can run
      // `first-tree-hub update --check` for that.
      print.line(`  CLI:      ${COMMAND_VERSION}\n`);

      // Service state.
      if (isServiceSupported()) {
        const svc = getClientServiceStatus();
        const tail =
          svc.platform === "systemd" ? `  (logs: journalctl --user -u ${svc.label.replace(/\.service$/, "")} -f)` : "";
        if (svc.state === "active") {
          print.line(`  Service:  ✓ running (${svc.platform}${svc.detail ? `, ${svc.detail}` : ""})${tail}\n`);
        } else if (svc.state === "inactive") {
          print.line(`  Service:  ✗ stopped (${svc.platform}${svc.detail ? `, ${svc.detail}` : ""})\n`);
        } else if (svc.state === "not-installed") {
          print.line("  Service:  not installed — run `first-tree-hub client connect <url>`\n");
        } else {
          print.line(`  Service:  unknown (${svc.platform}${svc.detail ? `, ${svc.detail}` : ""})\n`);
        }
      } else {
        print.line(`  Service:  not supported on ${process.platform} (runs inline)\n`);
      }

      // Hub + clientId — read the YAML directly so an incomplete config
      // doesn't bounce us through the schema-validation prompt path.
      const clientYaml = join(DEFAULT_CONFIG_DIR, "client.yaml");
      if (existsSync(clientYaml)) {
        try {
          const cfg = readConfigFile(clientYaml);
          const serverUrl = getNested(cfg, "server.url");
          const clientId = getNested(cfg, "client.id");
          print.line(`  Hub:      ${serverUrl ?? "(not configured)"}\n`);
          print.line(`  Client:   ${clientId ?? "(not configured)"}\n`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          print.line(`  Hub:      (could not read ${clientYaml}: ${msg.slice(0, 60)})\n`);
        }
      } else {
        print.line("  Hub:      (not configured — run `first-tree-hub client connect <url>`)\n");
      }

      // Agents.
      const agentsDir = join(DEFAULT_CONFIG_DIR, "agents");
      try {
        const agents = loadAgents({ schema: agentConfigSchema, agentsDir });
        if (agents.size === 0) {
          print.line("  Agents:   0 configured\n\n");
          return;
        }
        print.line(`  Agents:   ${agents.size} configured\n\n`);
        for (const [name, config] of agents) {
          print.line(`    ${name.padEnd(20)} runtime: ${config.runtime.padEnd(14)} agentId: ${config.agentId}\n`);
        }
        print.line("\n");
      } catch {
        print.line("  Agents:   (no agents directory)\n\n");
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

  // ── client claim — transfer ownership of this machine to the current user ──
  // Triggered after a 4403 CLIENT_USER_MISMATCH on `client start`. The
  // server-side transaction:
  //   1. UPDATE clients.user_id to the JWT's user_id
  //   2. Unpins every agent whose manager belongs to the previous owner
  //   3. Marks those agents' presence offline
  // After claim, the operator runs `client start` to reconnect.
  client
    .command("claim")
    .description(
      "Transfer ownership of this machine to your account (unpins the previous owner's agents from this machine)",
    )
    .option("--confirm", "Skip confirmation prompts (claim + auto-prune stale aliases)")
    .option("--server <url>", "Hub server URL")
    .action(async (options: { confirm?: boolean; server?: string }) => {
      try {
        const config = await initConfig({ schema: clientConfigSchema, role: "client" });
        const serverUrl = resolveServerUrl(options.server) ?? config.server.url;
        const clientId = config.client.id;

        print.line("\n");
        print.line("  Transferring ownership of this machine to your account.\n");
        print.line("  This will unpin the previous owner's agents from this client.\n\n");
        print.status("client.id", clientId);
        print.status("server", serverUrl);
        print.line("\n");

        if (!options.confirm) {
          const approved = await confirm({
            message: "Proceed with ownership transfer?",
            default: false,
          }).catch(() => false);
          if (!approved) {
            print.line("  Cancelled.\n\n");
            return;
          }
        }

        const token = await ensureFreshAccessToken();
        const response = await fetch(`${serverUrl}/api/v1/me/clients/${clientId}/claim`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: "{}",
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) {
          const body = await response.text();
          fail("CLAIM_ERROR", `Server returned ${response.status}: ${body}`, 1);
        }
        const result = (await response.json()) as {
          clientId: string;
          previousUserId: string | null;
          unpinnedAgentCount: number;
        };

        print.line(`  ✓ Ownership transferred. ${result.unpinnedAgentCount} agent(s) unpinned.\n`);

        // After claim, the previous owner's pinned agents are unpinned
        // server-side but their `agents/<name>/agent.yaml` files still
        // sit on disk. Without cleanup, the next `client start` tries to
        // bind those orphaned agentIds, R-RUN rejects each one, and
        // doctor keeps reporting the inflated "N configured" count.
        // Detect + offer to prune in the same breath as the claim.
        try {
          const sdk = new FirstTreeHubSDK({ serverUrl, getAccessToken: () => ensureFreshAccessToken() });
          const stale = await findStaleAliases({
            clientId,
            listPinnedAgents: () => sdk.listMyAgents(),
          });
          if (stale.length === 0) {
            print.line("  No stale local aliases — local config already matches the server.\n");
          } else {
            print.line(
              `\n  ${stale.length} local ${stale.length === 1 ? "alias" : "aliases"} won't bind on this client:\n\n`,
            );
            for (const s of stale) {
              const id = s.agentId ?? "—";
              print.line(`    - ${s.name.padEnd(30)} ${id.padEnd(38)} ${formatStaleReason(s.reason)}\n`);
            }
            print.line("\n");

            // `--confirm` was the operator pre-acknowledging the claim
            // itself; reusing the flag here keeps `client claim --confirm`
            // a fully non-interactive command (which the docs and the
            // CLIENT_USER_MISMATCH error message both rely on). The flag
            // description on the command spells this scope out.
            const approved =
              options.confirm === true
                ? true
                : await confirm({
                    message: `Remove the ${stale.length} stale ${stale.length === 1 ? "alias" : "aliases"} above (config + workspace + session state)?`,
                    default: true,
                  }).catch(() => false);

            if (approved) {
              let removed = 0;
              let failed = 0;
              for (const s of stale) {
                try {
                  removeLocalAgent(s.name);
                  print.line(`  ✓ removed ${s.name}\n`);
                  removed++;
                } catch (err) {
                  const msg = err instanceof Error ? err.message : String(err);
                  print.line(`  ✗ ${s.name} (${msg.slice(0, 80)})\n`);
                  failed++;
                }
              }
              print.line(
                `\n  ${removed} pruned${failed > 0 ? `, ${failed} failed (re-run \`agent prune\` to retry)` : ""}.\n`,
              );
            } else {
              print.line("  Skipped. Run `first-tree-hub agent prune` later to clean up.\n");
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          print.line(`  (Could not check for stale aliases: ${msg.slice(0, 100)})\n`);
          print.line("  Run `first-tree-hub agent prune` after reconnecting.\n");
        }

        print.line("\n  Run `first-tree-hub client start` to reconnect.\n\n");
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        fail("CLAIM_ERROR", msg);
      } finally {
        resetConfig();
        resetConfigMeta();
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

/** Read a `dot.path.like.this` from a parsed YAML object, returning string | null. */
function getNested(obj: Record<string, unknown>, path: string): string | null {
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    if (cur === null || cur === undefined || typeof cur !== "object") return null;
    cur = (cur as Record<string, unknown>)[part];
  }
  return typeof cur === "string" ? cur : null;
}
