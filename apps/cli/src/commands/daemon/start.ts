import { join } from "node:path";
import {
  applyClientLoggerConfig,
  ClientOrgMismatchError,
  ClientRetiredError,
  ClientUserMismatchError,
  captureClientException,
  configureClientLoggerForService,
  createLogger,
  discoverClaudeCodeSkills,
  flushClientSentry,
  initClientSentry,
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
import { CLIENT_SENTRY_DSN, GIT_SHA } from "../../build-info.js";
import { fail } from "../../cli/output.js";
import { channelConfig } from "../../core/channel.js";
import {
  CapabilityRefresher,
  ClientRuntime,
  COMMAND_VERSION,
  createApiNameResolver,
  createExecuteUpdate,
  createLoggerRuntimeOutput,
  declineUpdate,
  ensureActiveRootClientIdPersisted,
  ensureFreshAccessToken,
  getClientServiceStatus,
  getClientSwitchStartupBlock,
  handleClientOrgMismatch,
  isServiceSupported,
  listPinnedAgents,
  loadCredentials,
  loadDaemonEnv,
  migrateLocalAgentDirs,
  promptMissingFields,
  promptUpdate,
  reconcileLocalRuntimeProviders,
  refreshServerUpdateTarget,
  registerClientRuntimeMarker,
  resolveClientRuntimeStopReason,
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
      const serviceMode = process.env.FIRST_TREE_SERVICE_MODE === "1";
      const isSupervisorChild = options.foreground !== true && options.interactive === false && serviceMode;
      if (isSupervisorChild) {
        configureClientLoggerForService(join(defaultHome(), "logs"));
        // The CLI preAction defaults one-shot command logs to `warn`; the
        // daemon service is long-running and needs startup diagnostics in
        // client.log even before client.yaml has been parsed. This is
        // config-driven, so explicit operator levels still win.
        applyClientLoggerConfig({ level: "info" });
      }
      const daemonOutput = isSupervisorChild ? createLoggerRuntimeOutput(createLogger("daemon")) : null;
      const writeLine = (text: string) => (daemonOutput ? daemonOutput.line(text) : print.line(text));
      const writeStatus = (symbol: string, msg: string) =>
        daemonOutput ? daemonOutput.status(symbol, msg) : print.status(symbol, msg);
      const writeErrorAndExit = (message: string): never => {
        if (daemonOutput) {
          daemonOutput.status("✗", message);
        } else {
          print.line(`  ${message}\n`);
        }
        process.exit(1);
      };
      // Compatibility, not management: a launchd / systemd daemon does not inherit
      // the user's login-shell environment, so load the user-owned
      // `~/.first-tree/daemon.env` (if present) into our env BEFORE the runtime
      // spawns any child — so the Claude CLI / git / npm it launches inherit
      // whatever proxy the user configured. First Tree only reads this file.
      const appliedDaemonEnv = loadDaemonEnv();
      if (appliedDaemonEnv.length > 0) {
        writeLine(`  loaded ${appliedDaemonEnv.length} var(s) from daemon.env (${appliedDaemonEnv.join(", ")})\n`);
      }
      const switchBlock = getClientSwitchStartupBlock();
      if (switchBlock) {
        const message =
          "client switch is in progress; daemon startup is parked before reading root credentials/config.";
        if (daemonOutput) {
          writeStatus("•", message);
          process.exit(0);
        }
        writeLine(`  ${message}\n`);
        return;
      }
      // Fail closed: never spin up the runtime without persisted credentials.
      // Hooking this in BEFORE the service-delegation branch keeps the policy
      // uniform — supervisor child, foreground debug, or background daemon
      // launch all bail out the same way pointing at `login`.
      if (!loadCredentials()) {
        const message = `no credentials — run \`${binName} login <code>\` to sign in before starting the daemon.`;
        if (daemonOutput) {
          writeErrorAndExit(message);
        }
        fail("NO_CREDENTIALS", message, 1);
      }

      let unregisterRuntimeMarker: (() => void) | null = null;
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
            writeLine("\n");
            writeLine(`  Service is already running (${svc.platform}${svc.detail ? `, ${svc.detail}` : ""}).\n`);
            writeLine(`  Use \`${binName} daemon restart\` to restart, or \`--foreground\` to run inline.\n\n`);
            return;
          }
          if (svc.state === "inactive") {
            const res = startClientService();
            if (!res.ok) {
              writeLine(`\n  Failed to start service: ${res.reason}\n`);
              if (isWslDbusOvermount(res.reason)) {
                writeLine("\n");
                writeLine("  WSL2 detected — WSLg has over-mounted /run/user/$UID and is hiding\n");
                writeLine("  the user dbus socket. The systemd user manager is fine; the bus\n");
                writeLine("  socket just isn't reachable from your shell.\n\n");
                writeLine("  Quick fix (one-shot, lost on reboot):\n");
                writeLine("      sudo umount -l /run/user/$(id -u)\n\n");
                writeLine("  Permanent fix — install a boot-time helper, then update wsl.conf:\n\n");
                writeLine("      sudo tee /usr/local/bin/strip-wslg-overlay.sh >/dev/null <<'EOF'\n");
                writeLine("      #!/bin/sh\n");
                writeLine("      for d in /run/user/*; do\n");
                writeLine('        uid=$(basename "$d")\n');
                writeLine('        case "$uid" in ""|*[!0-9]*) continue ;; esac\n');
                writeLine("        for i in $(seq 1 30); do\n");
                writeLine('          if mount | grep -q "tmpfs on $d .*mode=755"; then\n');
                writeLine('            umount -l "$d"; break\n');
                writeLine("          fi\n");
                writeLine("          sleep 1\n");
                writeLine("        done\n");
                writeLine("      done\n");
                writeLine("      EOF\n");
                writeLine("      sudo chmod +x /usr/local/bin/strip-wslg-overlay.sh\n\n");
                writeLine("  Then add to /etc/wsl.conf under [boot]:\n");
                writeLine("      command=/usr/local/bin/strip-wslg-overlay.sh\n\n");
                writeLine("  Then run `wsl --shutdown` in Windows PowerShell and reopen the shell.\n");
              }
              writeLine("  Try `--foreground` to run inline instead.\n\n");
              process.exit(1);
            }
            const after = getClientServiceStatus();
            writeLine("\n");
            writeLine(`  Started ${after.platform} service${after.detail ? ` (${after.detail})` : ""}.\n`);
            writeLine(`  Logs:  ${join(after.logDir, "client.log")}\n`);
            const supervisorHint =
              after.platform === "systemd"
                ? `  Supervisor fallback: \`journalctl ${after.managerScope === "system" ? "" : "--user "}-u ${after.label.replace(/\.service$/, "")}\`\n\n`
                : after.platform === "task-scheduler"
                  ? `  Supervisor log: ${join(after.logDir, "supervisor.log")}\n  Wrapper fallback: ${join(
                      after.logDir,
                      "supervisor-wrapper.log",
                    )}\n\n`
                  : `  Supervisor fallback: ${join(after.logDir, "client.stdout.log")} / ${join(after.logDir, "client.stderr.log")}\n\n`;
            writeLine(supervisorHint);
            return;
          }
          if (svc.state === "unknown") {
            // Defensive: launchctl/systemctl probe came back with shape we
            // don't recognise. Falling through to the inline path here would
            // race a still-supervised process for the same client.id, which
            // is exactly the failure mode this whole PR is trying to
            // eliminate. Known migration-required states get stricter
            // guidance because foreground bypass can recreate the duplicate
            // runtime we are refusing.
            writeLine(
              `\n  Service state could not be determined (${svc.platform}${svc.detail ? `: ${svc.detail}` : ""}).\n`,
            );
            if (svc.migrationRequired === "root-systemd-user-to-system") {
              writeLine(`  Complete the root systemd migration out-of-service with \`${binName} login <code>\`.\n\n`);
            } else {
              writeLine(`  Inspect with \`${binName} daemon doctor\`, or pass \`--foreground\` to bypass.\n\n`);
            }
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
        ensureActiveRootClientIdPersisted(config.client.id);
        unregisterRuntimeMarker = registerClientRuntimeMarker({
          clientId: config.client.id,
          mode: isSupervisorChild ? "service" : "foreground",
        });

        // Wire the resolved logLevel into the client logger — without this,
        // `logLevel: debug` in client.yaml is parsed but never reaches pino.
        applyClientLoggerConfig({ level: config.logLevel });

        initClientSentry({ version: COMMAND_VERSION, gitSha: GIT_SHA, defaultDsn: CLIENT_SENTRY_DSN });

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
            log: writeStatus,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          writeStatus("⚠️", `agent-dir migration skipped: ${msg}`);
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
            log: (level, msg) => writeStatus(level === "warn" ? "⚠️" : "•", msg),
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          writeStatus("⚠️", `runtime-provider reconcile skipped: ${msg}`);
        }
        const agents = loadAgents({ schema: agentConfigSchema, agentsDir });

        writeLine(`\n  Connecting to ${config.server.url} (client id: ${config.client.id})...\n`);

        // `--no-interactive` suppresses update prompts, but it does not by
        // itself prove a supervisor will relaunch us after exit(75). Only the
        // service-unit child has FIRST_TREE_SERVICE_MODE=1, so keep the
        // exit-for-restart path scoped to that case.
        const noInteractive = options.interactive === false;
        const managed = isSupervisorChild;
        const updateLogger = createLogger("update");
        // The `executeUpdate` closure needs access to the ClientRuntime's
        // connection to emit `resilience.update.failed`, but the runtime
        // doesn't exist yet at construction time. Use a deferred reference
        // (set immediately after `new ClientRuntime`) so the closure can
        // reach the connection by the time it actually fires (npm install
        // failures only happen after `runtime.start()`).
        let runtimeRef: ClientRuntime | null = null;
        const executeUpdate = createExecuteUpdate({
          managed,
          log: managed ? (level, msg) => updateLogger[level](msg) : undefined,
          onUpdateFailed: (payload) => {
            runtimeRef?.emitConnectionResilienceEvent("resilience.update.failed", payload);
          },
        });
        const runtime = new ClientRuntime(config.server.url, config.client.id, {
          currentVersion: COMMAND_VERSION,
          output: daemonOutput ?? undefined,
          update: {
            updateConfig: config.update,
            prompt: noInteractive ? declineUpdate : promptUpdate,
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
          log: (symbol, msg) => writeStatus(symbol, msg),
        });
        runtime.onReconnect(() => capabilityRefresher.onReconnect());

        // In-product runtime-auth: the server pushes `runtime-auth:start` when a
        // member clicks "Connect <provider>" in the console. The daemon drives
        // the provider's official browser-OAuth login on this host and surfaces
        // progress (success / failure) by re-PATCHing capabilities through the
        // refresher, which the web already polls — no bespoke channel.
        runtime.onRuntimeAuthStart((command) => {
          // Serialize per provider: ignore a duplicate start while a login is
          // already running, else a second `codex login` spawns and races the
          // first. The interactive flag also tells the background poll to
          // preserve the pending browser-auth entry instead of clobbering it on
          // the next re-probe.
          if (capabilityRefresher.isInteractive(command.provider)) {
            writeStatus(
              "•",
              `runtime-auth: ${command.provider} login already in progress — ignoring duplicate (ref ${command.ref})`,
            );
            return;
          }
          capabilityRefresher.beginInteractive(command.provider);
          void runRuntimeAuthLogin(command, {
            currentEntry: (provider) => capabilityRefresher.currentEntry(provider),
            setProviderEntry: (provider, entry) => capabilityRefresher.setProviderEntry(provider, entry),
            log: (symbol, msg) => writeStatus(symbol, msg),
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
              warn: (msg) => writeStatus("⚠️", `skill scan: ${msg}`),
            });
            const accessToken = await ensureFreshAccessToken();
            let pinnedByAgentId: Map<string, { agentId: string; clientId: string }> | null = null;
            try {
              const pinned = await listPinnedAgents({ serverUrl: config.server.url, accessToken });
              pinnedByAgentId = new Map(pinned.map((agent) => [agent.agentId, agent]));
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              writeStatus("⚠️", `skills upload pin check skipped: ${msg}`);
            }
            await Promise.all(
              claudeAgents.map(async ([name, c]) => {
                try {
                  const pinned = pinnedByAgentId?.get(c.agentId);
                  if (pinnedByAgentId && !pinned) {
                    writeStatus(
                      "⚠️",
                      `skills upload for ${name} skipped: local agent ${c.agentId} is not pinned to this user; run \`${binName} agent prune --dry-run\` to inspect stale aliases.`,
                    );
                    return;
                  }
                  if (pinned && pinned.clientId !== config.client.id) {
                    writeStatus(
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
                  writeStatus("⚠️", `skills upload for ${name} skipped: ${msg}`);
                }
              }),
            );
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          writeStatus("⚠️", `skills upload skipped: ${msg}`);
        }

        // Watch agents config dir for hot-add
        runtime.watchAgentsDir(agentsDir);

        // Graceful shutdown
        const shutdown = async () => {
          writeLine("\n  Shutting down...\n");
          capabilityRefresher.stop();
          runtime.unwatchAgentsDir();
          await runtime.stop(resolveClientRuntimeStopReason());
          unregisterRuntimeMarker?.();
          unregisterRuntimeMarker = null;
          await flushClientSentry();
          process.exit(0);
        };
        process.on("SIGINT", () => void shutdown());
        process.on("SIGTERM", () => void shutdown());

        // Keep process alive
        await new Promise(() => {});
      } catch (error) {
        if (error instanceof ClientRetiredError) {
          const resetCommand = `${binName} computer reset`;
          const loginCommand = `${binName} login <code>`;
          if (daemonOutput) {
            writeStatus(
              "✗",
              `client identity has been retired (${error.message}); run \`${resetCommand}\`, then run \`${loginCommand}\` with a fresh connect code.`,
            );
            process.exit(1);
          }
          writeLine("\n");
          writeLine("  ⚠️  This machine's client identity has been retired.\n");
          writeLine(`     Server message: ${error.message}\n`);
          writeLine(
            `  Back up local workspaces if needed, run \`${resetCommand}\`, then run \`${loginCommand}\` with a fresh connect code.\n\n`,
          );
          process.exit(1);
        }
        if (error instanceof ClientUserMismatchError) {
          if (daemonOutput) {
            writeStatus(
              "✗",
              `client.yaml is not accepted for the current credentials; back up local workspaces, run \`${binName} computer reset\`, then run \`${binName} login <code>\` with the intended account.`,
            );
            process.exit(1);
          }
          writeLine("\n");
          writeLine("  ⚠️  This client.yaml is not accepted for the current credentials.\n");
          writeLine("  The active client id and current credentials do not form a valid server-side owner pair.\n");
          writeLine(
            `  Back up local workspaces, run \`${binName} computer reset\`, then run \`${binName} login <code>\` with the intended account.\n\n`,
          );
          process.exit(1);
        }
        if (error instanceof ClientOrgMismatchError) {
          await handleClientOrgMismatch(error, {
            managed: isSupervisorChild,
            configDir: defaultConfigDir(),
            rerunCommand: `${binName} daemon start`,
            output: daemonOutput ?? undefined,
          });
        }
        const msg = error instanceof Error ? error.message : String(error);
        captureClientException(error, { command: "daemon start" });
        unregisterRuntimeMarker?.();
        unregisterRuntimeMarker = null;
        await flushClientSentry();
        writeErrorAndExit(`Error: ${msg}`);
      } finally {
        unregisterRuntimeMarker?.();
        // Reset singleton so other commands can reinit
        resetConfig();
        resetConfigMeta();
      }
    });
}
