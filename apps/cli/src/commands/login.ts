import { join } from "node:path";
import { ClientOrgMismatchError } from "@first-tree/client";
import {
  agentConfigSchema,
  type ClientConfig,
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
  ClientRuntime,
  COMMAND_VERSION,
  cliFetch,
  confirmLocalClientSwitch,
  createApiNameResolver,
  createExecuteUpdate,
  ensureFreshAccessToken,
  handleClientOrgMismatch,
  hasIncompleteClientSwitch,
  installClientService,
  isServiceSupported,
  loadCredentials,
  migrateLocalAgentDirs,
  promptUpdate,
  readActiveClientOwner,
  readActiveRootClientId,
  readRememberedLocalClientIdForAccount,
  recordActiveClientOwner,
  refreshServerUpdateTarget,
  resolveClientRuntimeStopReason,
  saveCredentials,
  switchLocalClientForLogin,
} from "../core/index.js";
import { print } from "../core/output.js";
import { decodeJwtPayload, deriveHubUrlFromToken, HubUrlDerivationError } from "./_shared/connect-token.js";

/** Owning user id (`sub`) from a server-issued JWT, or null if undecodable. */
function readOwnerSub(token: string | undefined): string | null {
  if (!token) return null;
  const payload = decodeJwtPayload(token);
  return typeof payload?.sub === "string" ? payload.sub : null;
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
 * Account switches are explicit local-client switches. The stored access token
 * owner is compared with the new server-issued access token's `sub` claim; a
 * mismatch prompts in TTY mode, requires `--force-switch` in non-TTY mode, then
 * stops/drains the current runtime before moving root state.
 */
export function registerLoginCommand(program: Command): void {
  program
    .command("login <token>")
    .description("Sign this computer into First Tree using a token from the web console")
    .option("--no-start", "Skip background daemon install/start (writes credentials and exits)")
    .option("--force-switch", "Confirm switching this computer to a different First Tree user in non-TTY mode")
    .action(async (token: string, options: { start?: boolean; forceSwitch?: boolean }) => {
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
        const rememberedOwner = readActiveClientOwner();

        const tokens = await exchangeToken(url, token);
        const newOwnerSub = readOwnerSub(tokens.accessToken);
        if (!newOwnerSub) {
          fail("AUTH_ERROR", "Server access token is missing the required `sub` claim.", 1);
        }
        let config: ClientConfig | null = null;
        if (existingCredentials && !previousOwnerSub) {
          fail(
            "CLIENT_OWNER_UNKNOWN_REQUIRES_RESET_OR_OWNER_LOGIN",
            "Existing credentials do not expose an owner user id, so First Tree cannot safely decide whether this is a same-user refresh or account switch.",
            1,
          );
        }
        if (hasIncompleteClientSwitch()) {
          config = await switchLocalClientForLogin({
            targetTokens: { ...tokens, serverUrl: url },
            targetOwnerSub: newOwnerSub,
          });
          print.line("\n  ✓ Interrupted local client switch recovered\n");
        }
        const existingOwnerSub = previousOwnerSub;
        const switchFrom = config
          ? null
          : existingCredentials && existingOwnerSub && existingOwnerSub !== newOwnerSub
            ? { serverUrl: existingCredentials.serverUrl, userId: existingOwnerSub }
            : rememberedOwner && rememberedOwner.userId !== newOwnerSub
              ? { serverUrl: rememberedOwner.serverUrl, userId: rememberedOwner.userId }
              : null;
        if (switchFrom) {
          await confirmLocalClientSwitch({
            existingServerUrl: switchFrom.serverUrl,
            targetServerUrl: url,
            existingUserId: switchFrom.userId,
            targetUserId: newOwnerSub,
            existingClientId: readActiveRootClientId(configDir) ?? rememberedOwner?.clientId,
            targetClientId: readRememberedLocalClientIdForAccount(url, newOwnerSub) ?? undefined,
            forceSwitch: options.forceSwitch === true,
          });
          config = await switchLocalClientForLogin({
            existingCredentials: {
              accessToken: existingCredentials?.accessToken ?? "",
              refreshToken: existingCredentials?.refreshToken ?? "",
              serverUrl: switchFrom.serverUrl,
            },
            previousOwnerSub: switchFrom.userId,
            targetTokens: { ...tokens, serverUrl: url },
            targetOwnerSub: newOwnerSub,
          });
          print.line("\n  ✓ Previous local client parked\n");
        }
        if (!existingCredentials && !rememberedOwner && readActiveRootClientId(configDir)) {
          fail(
            "CLIENT_OWNER_UNKNOWN_REQUIRES_RESET_OR_OWNER_LOGIN",
            `Existing client.yaml has no credentials or remembered owner metadata, so First Tree cannot safely decide whether this is a same-user reconnect or account switch. Run \`${channelConfig.binName} computer reset\` after backing up local state, or restore/log in from a state that still has the current owner's credentials.`,
            1,
          );
        }

        print.line(`\n  ✓ Server: ${url}\n`);

        if (!config) {
          const clientConfigPath = join(configDir, "client.yaml");
          setConfigValue(clientConfigPath, "server.url", url);
          saveCredentials({ ...tokens, serverUrl: url });

          resetConfig();
          resetConfigMeta();
          config = await initConfig({ schema: clientConfigSchema, role: "client" });
          recordActiveClientOwner({ clientId: config.client.id, userId: newOwnerSub, serverUrl: url });
        }
        print.line("  ✓ Authenticated\n");
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
          await runtime.stop(resolveClientRuntimeStopReason());
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
