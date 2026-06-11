import { existsSync } from "node:fs";
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
import { select } from "@inquirer/prompts";
import type { Command } from "commander";
import { fail } from "../cli/output.js";
import { channelConfig } from "../core/channel.js";
import {
  ClientRuntime,
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
  rotateClientIdWithBackup,
  saveCredentials,
} from "../core/index.js";
import { print } from "../core/output.js";
import { cleanupStaleLocalAliases } from "./_shared/account-transfer.js";
import { decodeJwtPayload, deriveHubUrlFromToken, HubUrlDerivationError } from "./_shared/connect-token.js";

async function promptReplaceOrCancel(newMemberId: string): Promise<"proceed" | "cancel"> {
  const existing = loadCredentials();
  if (!existing) return "proceed";

  const existingPayload = decodeJwtPayload(existing.accessToken);
  const existingMemberId = typeof existingPayload?.memberId === "string" ? existingPayload.memberId : null;

  if (existingMemberId && existingMemberId === newMemberId) return "proceed";

  const existingMember = existingMemberId ? `member ${existingMemberId.slice(0, 8)}` : "unknown account";
  const serviceStatus = getClientServiceStatus();
  const serviceLine =
    serviceStatus.state === "active"
      ? `running (${serviceStatus.detail ?? "live"})`
      : serviceStatus.state === "inactive"
        ? `installed but not running${serviceStatus.detail ? ` — ${serviceStatus.detail}` : ""}`
        : "not installed";

  print.line("\n  ⚠️  This computer is already connected under another account.\n\n");
  print.line(`       Existing account:  ${existingMember}\n`);
  print.line(`       Server:            ${existing.serverUrl}\n`);
  print.line(`       Background service: ${serviceLine}\n\n`);
  print.line("     Replacing only affects THIS computer. Server-side data is untouched.\n");
  print.line("     To take this machine over for your account, re-run with `--override`: it\n");
  print.line("     registers a fresh client identity here. The other account keeps its own\n");
  print.line("     client entry and agents server-side (they show offline until removed).\n\n");

  const choice = await select<"replace" | "cancel">({
    message: "How would you like to continue?",
    choices: [
      { name: "Replace — log out the other account and set up this one", value: "replace" },
      { name: "Cancel  — keep the existing setup", value: "cancel" },
    ],
  });

  return choice === "replace" ? "proceed" : "cancel";
}

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
 * Two modes:
 *
 *   - **default**: prompts to replace an existing credentials.json under
 *     a different member account; on confirmation, exchanges the token,
 *     persists credentials, runs initConfig (generating `client.id` if
 *     fresh), and (unless `--no-start`) installs+starts the background
 *     daemon.
 *
 *   - **`--override`**: opts out of the "replace or cancel" prompt, rotates
 *     the machine's local client identity (client.yaml backed up), and
 *     registers a fresh clientId under the new account. The previous
 *     account's client row and pinned agents are left untouched server-side.
 */
export function registerLoginCommand(program: Command): void {
  program
    .command("login <token>")
    .description("Sign this computer into First Tree using a token from the web console")
    .option("--no-start", "Skip background daemon install/start (writes credentials and exits)")
    .option("--override", "Take over this machine from a different account by registering a fresh client identity")
    .action(async (token: string, options: { start?: boolean; override?: boolean }) => {
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

        const payload = decodeJwtPayload(token);
        const newMemberId = typeof payload?.memberId === "string" ? payload.memberId : null;

        // `--override` skips the local replace-or-cancel prompt because the
        // operator has explicitly asked to take over the machine. The
        // ownership-transfer POST below is the server-side counterpart.
        if (!options.override && newMemberId) {
          const decision = await promptReplaceOrCancel(newMemberId);
          if (decision === "cancel") {
            print.line("\n  Cancelled. Existing setup untouched.\n");
            return;
          }
        }

        // Capture the previous owner BEFORE saveCredentials overwrites the
        // file, so we can tell a genuine cross-account takeover from a
        // same-account reauth/retry.
        const previousOwnerSub = readOwnerSub(loadCredentials()?.accessToken);

        const tokens = await exchangeToken(url, token);
        const newOwnerSub = readOwnerSub(tokens.accessToken);

        const clientConfigPath = join(defaultConfigDir(), "client.yaml");
        // Captured before setConfigValue creates the file on fresh machines —
        // only a pre-existing client.yaml carries an identity worth rotating.
        const hadExistingClientConfig = existsSync(clientConfigPath);

        // Rotate the client identity ONLY on a real cross-account handover.
        // Same-account `--override` (a reauth or retry) must stay idempotent
        // for the client identity: abandoning a clientId we still own would
        // orphan the server row AND make our own local agent aliases look
        // `pinned-elsewhere`, deleting their mirrors during cleanup below.
        // Treat an undecodable previous owner as "unknown" → rotate, since we
        // can't prove it's the same account.
        const crossAccountOverride =
          options.override === true && (previousOwnerSub === null || previousOwnerSub !== newOwnerSub);

        setConfigValue(clientConfigPath, "server.url", url);
        print.line(`\n  ✓ Server: ${url}\n`);

        saveCredentials({ ...tokens, serverUrl: url });
        print.line("  ✓ Authenticated\n");

        // Cross-account `--override`: abandon the machine's previous client
        // identity instead of transferring it. There is no server-side
        // ownership transfer (a clientId is org-visible, so it must not double
        // as a transfer capability); rotating the local id and registering
        // fresh achieves the same handover. The previous account's client row
        // and its pinned agents stay untouched server-side — they show offline
        // until that account removes them.
        let rotatedFromId: string | null = null;
        if (crossAccountOverride && hadExistingClientConfig) {
          const rotation = rotateClientIdWithBackup(defaultConfigDir());
          rotatedFromId = rotation.oldId;
          print.line("  ✓ Rotated local client identity for account takeover\n");
          print.line(`      previous id: ${rotation.oldId ?? "(unset)"} (backup: ${rotation.backupPath})\n`);
        }

        resetConfig();
        resetConfigMeta();
        const config = await initConfig({ schema: clientConfigSchema, role: "client" });
        print.line(`  ✓ Computer registered (id: ${config.client.id})\n`);

        // Stale-alias cleanup is meaningful only after a rotation — the local
        // aliases are "stale" precisely because they were pinned to the
        // now-abandoned clientId. A same-account override leaves the clientId
        // unchanged, so there is nothing stale to prune.
        if (rotatedFromId) {
          print.line("\n  This machine now runs under a fresh client identity.\n");
          print.line("  The previous account keeps its client entry and agents server-side;\n");
          print.line("  they appear offline until that account cleans them up.\n\n");
          await cleanupStaleLocalAliases({
            serverUrl: config.server.url,
            clientId: config.client.id,
            nonInteractive: true,
          });
        }

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
