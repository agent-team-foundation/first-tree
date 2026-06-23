import { join } from "node:path";
import {
  applyClientLoggerConfig,
  ClientOrgMismatchError,
  ClientUserMismatchError,
  configureClientLoggerForService,
  discoverClaudeCodeSkills,
} from "@first-tree/client";
import {
  agentConfigSchema,
  clientConfigSchema,
  defaultConfigDir,
  defaultDataDir,
  defaultHome,
  initConfig,
  loadAgents,
  resetConfig,
  resetConfigMeta,
} from "@first-tree/shared/config";
import type { Command } from "commander";
import { fail } from "../../cli/output.js";
import { channelConfig } from "../../core/channel.js";
import {
  CapabilityRefresher,
  ClientRuntime,
  COMMAND_VERSION,
  createApiNameResolver,
  createExecuteUpdate,
  declineUpdate,
  ensureFreshAccessToken,
  getClientServiceStatus,
  handleClientOrgMismatch,
  isServiceSupported,
  listPinnedAgents,
  loadCredentials,
  migrateLocalAgentDirs,
  promptMissingFields,
  promptUpdate,
  reconcileLocalRuntimeProviders,
  refreshServerUpdateTarget,
  runRuntimeAuthLogin,
  startClientService,
  uploadAgentSkills,
  uploadClientCapabilities,
} from "../../core/index.js";
import { print } from "../../core/output.js";
import { isWslDbusOvermount } from "./_shared/wsl-dbus.js";

export function registerDaemonStartCommand(daemon: Command): void {
  daemon
    .command("start")
    .description("Start the daemon — connect all configured agents to the server")
    .option("--no-interactive", "Skip interactive prompts (for Docker/CI)")
    .option("--foreground", "Run inline instead of delegating to the background service (for debugging)")
    .action(async (options: { interactive?: boolean; foreground?: boolean }) => {
      const binName = channelConfig.binName;
      // Fail closed: never spin up the runtime without persisted credentials.
      // Hooking this in BEFORE the service-delegation branch keeps the policy
      // uniform — supervisor child, foreground debug, or background daemon
      // launch all bail out the same way pointing at `login`.
      const isSupervisorChild = options.interactive === false && process.env.FIRST_TREE_SERVICE_MODE === "1";
      if (!loadCredentials()) {
        fail(
          "NO_CREDENTIALS",
          `no credentials — run \`${binName} login <token>\` to sign in before starting the daemon.`,
          1,
        );
      }

      try {
        // Service-mode delegation. We split four cases so the user gets a
        // single coherent command:
        //   1. service active           → refuse, point at `daemon restart`
        //   2. service installed/inactive → systemctl/launchctl start
        //   3. service not installed    → fall through to inline run
        //   4. --foreground             → always inline (debug / --no-start users)
        // The supervisor itself reaches this code with --no-interactive and
        // FIRST_TREE_SERVICE_MODE=1 set; we treat that combo as "supervisor
        // invoking us, run inline" so we don't recursively call systemctl
        // from inside our own ExecStart.
        const wantInline = options.foreground === true || isSupervisorChild;
        if (!wantInline && isServiceSupported()) {
          const svc = getClientServiceStatus();
          if (svc.state === "active") {
            print.line("\n");
            print.line(`  Service is already running (${svc.platform}${svc.detail ? `, ${svc.detail}` : ""}).\n`);
            print.line(`  Use \`${binName} daemon restart\` to restart, or \`--foreground\` to run inline.\n\n`);
            return;
          }
          if (svc.state === "inactive") {
            const res = startClientService();
            if (!res.ok) {
              print.line(`\n  Failed to start service: ${res.reason}\n`);
              if (isWslDbusOvermount(res.reason)) {
                print.line("\n");
                print.line("  WSL2 detected — WSLg has over-mounted /run/user/$UID and is hiding\n");
                print.line("  the user dbus socket. The systemd user manager is fine; the bus\n");
                print.line("  socket just isn't reachable from your shell.\n\n");
                print.line("  Quick fix (one-shot, lost on reboot):\n");
                print.line("      sudo umount -l /run/user/$(id -u)\n\n");
                print.line("  Permanent fix — install a boot-time helper, then update wsl.conf:\n\n");
                print.line("      sudo tee /usr/local/bin/strip-wslg-overlay.sh >/dev/null <<'EOF'\n");
                print.line("      #!/bin/sh\n");
                print.line("      for d in /run/user/*; do\n");
                print.line('        uid=$(basename "$d")\n');
                print.line('        case "$uid" in ""|*[!0-9]*) continue ;; esac\n');
                print.line("        for i in $(seq 1 30); do\n");
                print.line('          if mount | grep -q "tmpfs on $d .*mode=755"; then\n');
                print.line('            umount -l "$d"; break\n');
                print.line("          fi\n");
                print.line("          sleep 1\n");
                print.line("        done\n");
                print.line("      done\n");
                print.line("      EOF\n");
                print.line("      sudo chmod +x /usr/local/bin/strip-wslg-overlay.sh\n\n");
                print.line("  Then add to /etc/wsl.conf under [boot]:\n");
                print.line("      command=/usr/local/bin/strip-wslg-overlay.sh\n\n");
                print.line("  Then run `wsl --shutdown` in Windows PowerShell and reopen the shell.\n");
              }
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
            print.line(`  Inspect with \`${binName} daemon doctor\`, or pass \`--foreground\` to bypass.\n\n`);
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
        if (process.env.FIRST_TREE_SERVICE_MODE === "1") {
          configureClientLoggerForService(join(defaultHome(), "logs"));
        }

        // Load agents (may be empty — daemon can start without agents).
        // Phase 3 of the agent-naming refactor: run the local-dir rename
        // migration BEFORE `loadAgents` so any config dir whose name
        // drifted from the server-authoritative `agent.name` slug is renamed
        // first. `loadAgents` then enumerates the up-to-date layout.
        // The migration is best-effort — it never blocks startup.
        const agentsDir = join(defaultConfigDir(), "agents");
        try {
          await migrateLocalAgentDirs({
            agentsDir,
            workspacesDir: join(defaultDataDir(), "workspaces"),
            sessionsDir: join(defaultDataDir(), "sessions"),
            resolver: createApiNameResolver(config.server.url, () => ensureFreshAccessToken()),
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          print.status("⚠️", `agent-dir migration skipped: ${msg}`);
        }

        // Pre-flight runtime-provider reconciliation rewrites any local
        // `agent.yaml::runtime` whose value drifted from the server-authoritative
        // `agents.runtime_provider`, so the spawn loop sees up-to-date config.
        // Do NOT run full capability probes here: provider smokes can take
        // seconds and should not delay the daemon from connecting/registering.
        try {
          const accessToken = await ensureFreshAccessToken();
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
        // The `executeUpdate` closure needs access to the ClientRuntime's
        // connection to emit `resilience.update.failed`, but the runtime
        // doesn't exist yet at construction time. Use a deferred reference
        // (set immediately after `new ClientRuntime`) so the closure can
        // reach the connection by the time it actually fires (npm install
        // failures only happen after `runtime.start()`).
        let runtimeRef: ClientRuntime | null = null;
        const executeUpdate = createExecuteUpdate({
          managed,
          onUpdateFailed: (payload) => {
            runtimeRef?.emitConnectionResilienceEvent("resilience.update.failed", payload);
          },
        });
        const runtime = new ClientRuntime(config.server.url, config.client.id, {
          currentVersion: COMMAND_VERSION,
          update: {
            updateConfig: config.update,
            prompt: managed ? declineUpdate : promptUpdate,
            executeUpdate,
            refreshServerTarget: refreshServerUpdateTarget,
          },
        });
        runtimeRef = runtime;
        for (const [name, agentConfig] of agents) {
          runtime.addAgent(name, agentConfig);
        }

        // Runtime-capability refresh as a single probing model. The refresher
        // owns startup, WS-reconnect, and bounded background probes. Startup is
        // deliberately post-registration and fire-and-forget: capability rows
        // still come from launch-verified full probes, but slow provider smokes
        // must not delay `Connecting...`, WS registration, or agent bind.
        const capabilityRefresher = new CapabilityRefresher({
          upload: async (capabilities) => {
            const accessToken = await ensureFreshAccessToken();
            await uploadClientCapabilities({
              serverUrl: config.server.url,
              accessToken,
              clientId: config.client.id,
              capabilities,
            });
          },
          log: (symbol, msg) => print.status(symbol, msg),
        });
        runtime.onReconnect(() => capabilityRefresher.onReconnect());

        // In-product runtime-auth: the server pushes `runtime-auth:start` when a
        // member clicks "Connect <provider>" in the console. The daemon drives
        // the provider's official login on this host and surfaces progress
        // (device code / success / failure) by re-PATCHing capabilities through
        // the refresher, which the web already polls — no bespoke channel.
        runtime.onRuntimeAuthStart((command) => {
          // Serialize per provider: ignore a duplicate start while a login is
          // already running, else a second `codex login --device-auth` spawns
          // and its device code races the first. The interactive flag also
          // tells the background poll to preserve the pending device-code entry
          // instead of clobbering it on the next re-probe.
          if (capabilityRefresher.isInteractive(command.provider)) {
            print.status(
              "•",
              `runtime-auth: ${command.provider} login already in progress — ignoring duplicate (ref ${command.ref})`,
            );
            return;
          }
          capabilityRefresher.beginInteractive(command.provider);
          void runRuntimeAuthLogin(command, {
            currentEntry: (provider) => capabilityRefresher.currentEntry(provider),
            setProviderEntry: (provider, entry) => capabilityRefresher.setProviderEntry(provider, entry),
            log: (symbol, msg) => print.status(symbol, msg),
          }).finally(() => capabilityRefresher.endInteractive(command.provider));
        });

        await runtime.start();

        // Post-register capabilities upload + arm the background poll — the
        // `clients` row only exists after the `client:register` WS handshake,
        // so the first PATCH runs here rather than pre-flight. Best-effort: a
        // transient failure logs and moves on; agents still bind, and the poll
        // (or a later restart) retries.
        void capabilityRefresher.start();

        // Post-register slash-command skill upload. Phase 1B scope is
        // user-global Claude Code skills — every claude-code agent on this
        // client receives the same payload, which the web composer reads
        // via `GET /api/v1/agents/:uuid/skills` after the user @mentions
        // the agent. Codex (and any future runtime without a skill system)
        // is skipped. Best-effort: log + continue on failure.
        try {
          const claudeAgents = [...agents].filter(([, c]) => c.runtime === "claude-code");
          if (claudeAgents.length > 0) {
            const skills = await discoverClaudeCodeSkills({
              warn: (msg) => print.status("⚠️", `skill scan: ${msg}`),
            });
            const accessToken = await ensureFreshAccessToken();
            let pinnedByAgentId: Map<string, { agentId: string; clientId: string }> | null = null;
            try {
              const pinned = await listPinnedAgents({ serverUrl: config.server.url, accessToken });
              pinnedByAgentId = new Map(pinned.map((agent) => [agent.agentId, agent]));
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              print.status("⚠️", `skills upload pin check skipped: ${msg}`);
            }
            await Promise.all(
              claudeAgents.map(async ([name, c]) => {
                try {
                  const pinned = pinnedByAgentId?.get(c.agentId);
                  if (pinnedByAgentId && !pinned) {
                    print.status(
                      "⚠️",
                      `skills upload for ${name} skipped: local agent ${c.agentId} is not pinned to this user; run \`${binName} agent prune --dry-run\` to inspect stale aliases.`,
                    );
                    return;
                  }
                  if (pinned && pinned.clientId !== config.client.id) {
                    print.status(
                      "⚠️",
                      `skills upload for ${name} skipped: local agent ${c.agentId} is pinned to another client (${pinned.clientId}); run \`${binName} agent prune --dry-run\` to inspect stale aliases.`,
                    );
                    return;
                  }
                  await uploadAgentSkills({
                    serverUrl: config.server.url,
                    accessToken,
                    agentId: c.agentId,
                    skills,
                  });
                } catch (err) {
                  const msg = err instanceof Error ? err.message : String(err);
                  print.status("⚠️", `skills upload for ${name} skipped: ${msg}`);
                }
              }),
            );
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          print.status("⚠️", `skills upload skipped: ${msg}`);
        }

        // Watch agents config dir for hot-add
        runtime.watchAgentsDir(agentsDir);

        // Graceful shutdown
        const shutdown = async () => {
          print.line("\n  Shutting down...\n");
          capabilityRefresher.stop();
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
          print.line(`  Run \`${binName} logout --purge\` before logging in with another account.\n`);
          print.line("  This signs out the current user and removes this machine's local client\n");
          print.line("  identity plus local agent configs, workspaces, and session state. Server-side\n");
          print.line("  clients, agents, chats, and history are not deleted; the previous client and\n");
          print.line("  agents simply stop running from this machine unless they are set up again.\n\n");
          process.exit(1);
        }
        if (error instanceof ClientOrgMismatchError) {
          await handleClientOrgMismatch(error, {
            managed: options.interactive === false,
            configDir: defaultConfigDir(),
            rerunCommand: `${binName} daemon start`,
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
}
