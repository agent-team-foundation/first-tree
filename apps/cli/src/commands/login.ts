import { join } from "node:path";
import { ClientOrgMismatchError } from "@first-tree/client";
import {
  agentConfigSchema,
  clientConfigSchema,
  defaultConfigDir,
  defaultDataDir,
  initConfig,
  loadAgents,
  resetConfig,
  resetConfigMeta,
  setConfigValue,
} from "@first-tree/shared/config";
import type { Command } from "commander";
import { fail } from "../cli/output.js";
import { channelConfig } from "../core/channel.js";
import {
  authorizeDifferentUserLoginSwitch,
  ClientRuntime,
  ClientSwitchAuthorizationError,
  type ClientSwitchLoginAuthorization,
  COMMAND_VERSION,
  cliFetch,
  createApiNameResolver,
  createExecuteUpdate,
  ensureFreshAccessToken,
  getClientServiceStatus,
  handleClientOrgMismatch,
  installClientService,
  isServiceSupported,
  loadCredentials,
  migrateLocalAgentDirs,
  promptUpdate,
  refreshServerUpdateTarget,
  saveCredentials,
} from "../core/index.js";
import { print } from "../core/output.js";
import { decodeJwtPayload, deriveHubUrlFromToken, HubUrlDerivationError } from "./_shared/connect-token.js";

/** Owning user id (`sub`) from a server-issued JWT, or null if undecodable. */
function readOwnerSub(token: string | undefined): string | null {
  if (!token) return null;
  const payload = decodeJwtPayload(token);
  return typeof payload?.sub === "string" ? payload.sub : null;
}

function formatServiceLine(): string {
  const serviceStatus = getClientServiceStatus();
  if (serviceStatus.state === "active") return `running (${serviceStatus.detail ?? "live"})`;
  if (serviceStatus.state === "inactive") {
    return `installed but not running${serviceStatus.detail ? ` — ${serviceStatus.detail}` : ""}`;
  }
  return "not installed";
}

function rejectAccountSwitch(opts: {
  reason: string;
  serverUrl?: string;
  authorization?: ClientSwitchLoginAuthorization;
  authorizationError?: ClientSwitchAuthorizationError;
}): never {
  const switchCommand = `${channelConfig.binName} login <token> --force-switch`;
  print.line("\n  This computer already has First Tree login state for another or unknown user.\n\n");
  if (opts.serverUrl) print.line(`       Existing server:    ${opts.serverUrl}\n`);
  print.line(`       Background service: ${formatServiceLine()}\n\n`);
  print.line("  Refusing to overwrite local credentials or reuse this machine's client identity.\n\n");

  if (opts.authorizationError) {
    print.line("  Different-user login changes the active First Tree user on this computer.\n");
    print.line("  In non-interactive contexts this requires explicit authorization because it\n");
    print.line("  may stop the current daemon, agents, and provider turn.\n\n");
    print.line(`  Re-run with \`${switchCommand}\` to authorize the switch attempt.\n\n`);
    fail(opts.authorizationError.code, opts.authorizationError.message, 1);
  }

  if (opts.authorization) {
    const mode = opts.authorization.mode === "force-switch" ? "authorized by --force-switch" : "approved interactively";
    print.line(`  Account switch ${mode}: the switch may interrupt the current daemon,\n`);
    print.line("  agents, and provider turn. A new First Tree user must receive a separate\n");
    print.line("  local client id; the existing client id is not transferred or reused.\n\n");
    print.line("  This Phase 0.5 build has the safety gates but not the root state\n");
    print.line("  park/restore transaction, so it cannot complete the switch yet.\n");
    print.line("  Safety gates are not bypassed by --force-switch.\n\n");
    fail(
      "CLIENT_SWITCH_NOT_IMPLEMENTED",
      `${opts.reason} Controlled client switch is not implemented in this build.`,
      1,
    );
  }

  fail("CLIENT_SWITCH_NOT_IMPLEMENTED", opts.reason, 1);
}

async function exchangeToken(url: string, token: string): Promise<{ accessToken: string; refreshToken: string }> {
  const res = await cliFetch(`${url}/api/v1/auth/connect-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    fail("AUTH_ERROR", body.error ?? `Token exchange failed (HTTP ${res.status})`, 1);
  }
  return (await res.json()) as { accessToken: string; refreshToken: string };
}

/**
 * `login <token>` — single entry point. The connect token's
 * `iss` claim carries the server URL so prod / staging / local environments are
 * tagged at issuance and the operator can never accidentally cross-target.
 *
 * Account switches are fail-closed when credentials already exist. The stored
 * access token owner is compared with the new server-issued access token's
 * `sub` claim; a mismatch must go through controlled local-client switch, not
 * credential overwrite or client-id reuse. Without credentials, login preserves
 * the local client identity so a normal `logout` can be followed by same-user
 * reconnect.
 */
export function registerLoginCommand(program: Command): void {
  program
    .command("login <token>")
    .description("Sign this computer into First Tree using a token from the web console")
    .option("--no-start", "Skip background daemon install/start (writes credentials and exits)")
    .option(
      "--force-switch",
      "Authorize a different First Tree user to become active here; may interrupt the current runtime",
    )
    .action(async (token: string, options: { forceSwitch?: boolean; start?: boolean }) => {
      try {
        let url: string;
        try {
          url = deriveHubUrlFromToken(token);
        } catch (err) {
          if (err instanceof HubUrlDerivationError) {
            fail(err.code, err.message, 1);
          }
          throw err;
        }

        const configDir = defaultConfigDir();
        const existingCredentials = loadCredentials();
        const previousOwnerSub = readOwnerSub(existingCredentials?.accessToken);

        const tokens = await exchangeToken(url, token);
        const newOwnerSub = readOwnerSub(tokens.accessToken);
        if (!newOwnerSub) {
          fail("AUTH_ERROR", "Server access token is missing the required `sub` claim.", 1);
        }
        if (existingCredentials && (!previousOwnerSub || previousOwnerSub !== newOwnerSub)) {
          let authorization: ClientSwitchLoginAuthorization | undefined;
          let authorizationError: ClientSwitchAuthorizationError | undefined;
          try {
            authorization = authorizeDifferentUserLoginSwitch({
              forceSwitch: options.forceSwitch === true,
              isInteractive: process.stdin.isTTY === true,
            });
          } catch (err) {
            if (err instanceof ClientSwitchAuthorizationError) authorizationError = err;
            else throw err;
          }
          rejectAccountSwitch({
            reason:
              "This connect token belongs to a different user than the credentials already stored on this machine.",
            serverUrl: existingCredentials.serverUrl,
            authorization,
            authorizationError,
          });
        }

        const clientConfigPath = join(configDir, "client.yaml");
        setConfigValue(clientConfigPath, "server.url", url);
        print.line(`\n  ✓ Server: ${url}\n`);

        saveCredentials({ ...tokens, serverUrl: url });
        print.line("  ✓ Authenticated\n");

        resetConfig();
        resetConfigMeta();
        const config = await initConfig({ schema: clientConfigSchema, role: "client" });
        print.line(`  ✓ Computer registered (id: ${config.client.id})\n`);

        const shouldInstallService = options.start !== false && isServiceSupported();
        if (shouldInstallService) {
          const info = installClientService();
          print.line(`  ✓ Background service installed (${info.platform}) — you may close this terminal.\n`);
          print.line(`    Logs: ${info.logDir}\n\n`);
          return;
        }

        if (options.start === false) {
          print.line("  (--no-start) credentials written; daemon not launched.\n");
          print.line(
            `  Run \`${channelConfig.binName} daemon start\` when ready, or re-run \`login\` without \`--no-start\`.\n\n`,
          );
          return;
        }

        // Service not supported on this platform — fall back to inline run so
        // the user still gets a connected client without manually invoking
        // `daemon start` afterward.
        print.line(`  Background service not supported on ${process.platform}; running inline.\n`);

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
        const agents = loadAgents({ schema: agentConfigSchema, agentsDir });

        const runtime = new ClientRuntime(config.server.url, config.client.id, {
          currentVersion: COMMAND_VERSION,
          update: {
            updateConfig: config.update,
            prompt: promptUpdate,
            executeUpdate: createExecuteUpdate({ managed: false }),
            refreshServerTarget: refreshServerUpdateTarget,
          },
        });
        for (const [name, agentConfig] of agents) runtime.addAgent(name, agentConfig);
        await runtime.start();
        runtime.watchAgentsDir(agentsDir);

        const shutdown = async () => {
          print.line("\n  Shutting down...\n");
          runtime.unwatchAgentsDir();
          await runtime.stop();
          process.exit(0);
        };
        process.on("SIGINT", () => void shutdown());
        process.on("SIGTERM", () => void shutdown());
        await new Promise(() => {});
      } catch (error) {
        if ((error as { name?: string }).name === "ExitPromptError") {
          print.line("\n  Cancelled.\n");
          return;
        }
        if (error instanceof ClientOrgMismatchError) {
          await handleClientOrgMismatch(error, {
            managed: false,
            configDir: defaultConfigDir(),
            rerunCommand: `${channelConfig.binName} login <token>`,
          });
        }
        const msg = error instanceof Error ? error.message : String(error);
        print.line(`  Error: ${msg}\n`);
        process.exit(1);
      } finally {
        resetConfig();
        resetConfigMeta();
      }
    });
}
