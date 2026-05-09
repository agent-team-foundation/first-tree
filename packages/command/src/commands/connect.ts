import { join } from "node:path";
import {
  agentConfigSchema,
  clientConfigSchema,
  DEFAULT_CONFIG_DIR,
  DEFAULT_DATA_DIR,
  initConfig,
  loadAgents,
  resetConfig,
  resetConfigMeta,
  setConfigValue,
} from "@agent-team-foundation/first-tree-hub-shared/config";
import {
  ClientOrgMismatchError,
  ClientUserMismatchError,
  probeCapabilities,
  probeLocalGitRepos,
} from "@first-tree-hub/client";
import { input, password, select } from "@inquirer/prompts";
import type { Command } from "commander";
import { fail } from "../cli/output.js";
import {
  ClientRuntime,
  COMMAND_VERSION,
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
  reconcileLocalRuntimeProviders,
  saveCredentials,
  uploadClientCapabilities,
} from "../core/index.js";
import { print } from "../core/output.js";

type JwtPayload = {
  memberId?: unknown;
  organizationId?: unknown;
  role?: unknown;
  iat?: unknown;
};

/** Decode a JWT payload without signature verification. For UI purposes only. */
function decodeJwtPayload(token: string): JwtPayload | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3 || !parts[1]) return null;
    const raw = Buffer.from(parts[1], "base64url").toString();
    const obj = JSON.parse(raw) as unknown;
    if (typeof obj !== "object" || obj === null) return null;
    return obj as JwtPayload;
  } catch {
    return null;
  }
}

/**
 * Detect if the current home already holds a setup for a *different* account,
 * and give the operator a chance to back out before we overwrite credentials.
 *
 * Why this gate exists: running `client connect` implicitly overwrites
 * `~/.first-tree/hub/config/credentials.json`. Without this prompt, someone
 * onboarding a second account on their own machine silently logs themselves
 * out of the first account — they'd only notice when their "main" agents
 * appeared offline later. We treat single-account-per-machine as the product
 * default; the `FIRST_TREE_HUB_HOME` env var remains the advanced escape
 * hatch for power users who want parallel setups.
 *
 * The caller passes the *new* memberId directly so this gate can run BEFORE
 * auth. That matters for the `--token` path: connect tokens are single-use;
 * if we auth first and the user picks Cancel, the token is burned even
 * though nothing changed on disk. Decoding the connect token locally lets
 * us return early without spending it.
 *
 * Behavior:
 *   - No existing credentials → proceed silently (first-time install).
 *   - Existing credentials, same memberId → proceed silently (reconnect /
 *     token refresh — common + safe).
 *   - Existing credentials, memberId indeterminate → prompt with
 *     "unknown account" label so the user can decide.
 *   - Existing credentials, different memberId → prompt [Replace / Cancel].
 *     Cancel prints the isolation guide and returns "cancel".
 */
async function promptReplaceOrCancel(newMemberId: string, newServerUrl: string): Promise<"proceed" | "cancel"> {
  const existing = loadCredentials();
  if (!existing) return "proceed";

  const existingPayload = decodeJwtPayload(existing.accessToken);
  const existingMemberId = typeof existingPayload?.memberId === "string" ? existingPayload.memberId : null;

  // Same account reconnecting (token refresh, re-install) — no prompt.
  if (existingMemberId && existingMemberId === newMemberId) {
    return "proceed";
  }

  // Can't identify the existing account (corrupted creds, older schema) —
  // fall through to prompt with an "unknown" label so the user can still
  // make the call.

  const existingMember = existingMemberId ? `member ${existingMemberId.slice(0, 8)}` : "unknown account";
  const existingOrg = typeof existingPayload?.organizationId === "string" ? existingPayload.organizationId : null;
  const serviceStatus = getClientServiceStatus();
  const serviceLine =
    serviceStatus.state === "active"
      ? `running (${serviceStatus.detail ?? "live"})`
      : serviceStatus.state === "inactive"
        ? `installed but not running${serviceStatus.detail ? ` — ${serviceStatus.detail}` : ""}`
        : "not installed";

  print.line("\n");
  print.line("  \u26a0\ufe0f  This computer is already connected to the Hub under another account.\n\n");
  print.line(`       Existing account:  ${existingMember}\n`);
  if (existingOrg) {
    print.line(`       Organization:      ${existingOrg.slice(0, 8)}\n`);
  }
  print.line(`       Server:            ${existing.serverUrl}\n`);
  print.line(`       Background service: ${serviceLine}\n\n`);
  print.line("     Replacing only affects THIS computer. Your agents, messages, and\n");
  print.line("     settings on the Hub itself are untouched.\n\n");

  const choice = await select<"replace" | "cancel">({
    message: "How would you like to continue?",
    choices: [
      {
        name: "Replace — log out the other account and set up this one",
        value: "replace",
      },
      {
        name: "Cancel  — keep the existing setup on this computer",
        value: "cancel",
      },
    ],
  });

  if (choice === "cancel") {
    printIsolationGuide(newServerUrl);
    return "cancel";
  }

  return "proceed";
}

function printIsolationGuide(newServerUrl: string): void {
  print.line("\n  Cancelled. The existing account on this computer is untouched.\n\n");
  print.line("  To run this new account alongside it (advanced — no background service):\n\n");
  print.line('    export FIRST_TREE_HUB_HOME="$HOME/.first-tree/hub-<label>"\n');
  print.line(`    first-tree-hub client connect ${newServerUrl} --token <token>\n`);
  print.line("    first-tree-hub client start\n\n");
  print.line("  Notes:\n");
  print.line("    - Run the commands in a FRESH terminal (the isolated home must be set first).\n");
  print.line("    - In isolated mode the client stays online only while that terminal runs.\n");
  print.line("    - The main account's background service is not affected.\n\n");
}

/**
 * Authenticate via connect token — exchange for full JWT credentials.
 */
async function authenticateWithToken(
  url: string,
  token: string,
): Promise<{ accessToken: string; refreshToken: string }> {
  const res = await fetch(`${url}/api/v1/auth/connect-token`, {
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
 * Authenticate via interactive username/password login.
 */
async function authenticateInteractive(url: string): Promise<{ accessToken: string; refreshToken: string }> {
  print.line("\n  Log in to Hub:\n");

  const username = await input({ message: "  Username:" });
  const pw = await password({ message: "  Password:" });

  const loginRes = await fetch(`${url}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: pw }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!loginRes.ok) {
    const body = (await loginRes.json().catch(() => ({}))) as { error?: string };
    fail("AUTH_ERROR", body.error ?? `Login failed (HTTP ${loginRes.status})`, 1);
  }

  return (await loginRes.json()) as { accessToken: string; refreshToken: string };
}

export function registerConnectCommand(parent: Command): void {
  parent
    .command("connect <server-url>")
    .description("Connect to a Hub server — configure, authenticate, and install the background service")
    .option("--token <token>", "Connect token (from Hub web console) — skips interactive login")
    .option("--no-service", "Skip background service install (runs inline until Ctrl+C)")
    .action(async (serverUrl: string, options: { token?: string; service?: boolean }) => {
      try {
        const url = serverUrl.replace(/\/+$/, "");

        // 1. Pre-auth account-switch gate (token path).
        //
        // Connect tokens are single-use. If we authed first and the user
        // picked Cancel, the token would be burned even though nothing
        // changed on disk — forcing them to re-Generate a new one for a
        // second attempt. Decoding the connect token's JWT payload locally
        // lets the prompt run BEFORE we spend the token.
        //
        // Interactive login doesn't have this concern (user re-enters
        // username/password trivially) — we defer that check to after auth.
        let preAuthDecided = false;
        if (options.token) {
          const connectPayload = decodeJwtPayload(options.token);
          const newMemberId = typeof connectPayload?.memberId === "string" ? connectPayload.memberId : null;
          if (newMemberId !== null) {
            const decision = await promptReplaceOrCancel(newMemberId, url);
            if (decision === "cancel") return;
            preAuthDecided = true;
          }
        }

        // 2. Authenticate — token or interactive.
        const tokens = options.token
          ? await authenticateWithToken(url, options.token)
          : await authenticateInteractive(url);

        // 3. Post-auth fallback gate. Fires only when we couldn't decide in
        // step 1 (interactive login, or connect token that didn't carry a
        // memberId claim). Token is already spent here, but creds haven't
        // hit disk yet so Cancel still leaves the prior setup intact.
        if (!preAuthDecided) {
          const newPayload = decodeJwtPayload(tokens.accessToken);
          const newMemberId = typeof newPayload?.memberId === "string" ? newPayload.memberId : null;
          if (newMemberId !== null) {
            const decision = await promptReplaceOrCancel(newMemberId, url);
            if (decision === "cancel") return;
          }
        }

        // 4. Write server URL and credentials.
        const clientConfigPath = join(DEFAULT_CONFIG_DIR, "client.yaml");
        setConfigValue(clientConfigPath, "server.url", url);
        print.line(`\n  \u2713 Server configured: ${url}\n`);

        saveCredentials({ ...tokens, serverUrl: url });
        print.line("  \u2713 Authenticated\n");

        // Touch config + client.id so the background service picks up the
        // persisted clientId on its first launch (see #99).
        resetConfig();
        resetConfigMeta();
        const config = await initConfig({
          schema: clientConfigSchema,
          role: "client",
        });
        print.line(`  \u2713 Connected as this computer (id: ${config.client.id})\n`);

        // 5. Install background service (default) OR run inline (--no-service).
        const shouldInstallService = options.service !== false && isServiceSupported();

        if (shouldInstallService) {
          const info = installClientService();
          print.line(`  \u2713 Installed as a background service (${info.platform}) — you can close this terminal\n\n`);
          print.line(`    Unit:  ${info.unitPath}\n`);
          print.line(`    Logs:  ${info.logDir}\n`);
          if (info.state === "active" && info.detail) {
            print.line(`    State: running (${info.detail})\n`);
          }
          print.line("\n");
          return;
        }

        if (options.service === false) {
          print.line("  (--no-service) running inline — Ctrl+C to stop\n");
        } else {
          print.line(`  Background service not supported on ${process.platform}; running inline.\n`);
        }

        const agentsDir = join(DEFAULT_CONFIG_DIR, "agents");
        // Phase 3 of the agent-naming refactor: reconcile local agent dir
        // names with the server-authoritative `agent.name`. Best-effort —
        // a network blip doesn't block startup.
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

        // Pre-flight: probe local SDKs and reconcile local YAMLs against the
        // authoritative `agents.runtime_provider`. The capabilities upload runs
        // AFTER WS register (post-start block) because the `clients` row is
        // created lazily during the `client:register` handshake.
        let probedCapabilities: Awaited<ReturnType<typeof probeCapabilities>> | null = null;
        let probedLocalGitRepos: Awaited<ReturnType<typeof probeLocalGitRepos>> | null = null;
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
        // Local git repo scan is independent of runtime-provider reconcile —
        // a transient hub failure above must not silently kill the picker
        // data. Best-effort: any scanner error returns the partial list.
        try {
          probedLocalGitRepos = await probeLocalGitRepos();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          print.status("⚠️", `local repo scan skipped: ${msg}`);
        }
        const agents = loadAgents({ schema: agentConfigSchema, agentsDir });

        // `connect --no-service` runs inline until Ctrl+C — no supervisor,
        // so managed=false: self-update stays alive and prints a restart
        // hint instead of exiting.
        const runtime = new ClientRuntime(config.server.url, config.client.id, {
          currentVersion: COMMAND_VERSION,
          update: {
            updateConfig: config.update,
            prompt: promptUpdate,
            executeUpdate: createExecuteUpdate({ managed: false }),
          },
        });
        for (const [name, agentConfig] of agents) {
          runtime.addAgent(name, agentConfig);
        }

        await runtime.start();

        // Post-register capabilities upload — see client.ts for the rationale.
        if (probedCapabilities) {
          try {
            const accessToken = await ensureFreshAccessToken();
            await uploadClientCapabilities({
              serverUrl: config.server.url,
              accessToken,
              clientId: config.client.id,
              capabilities: probedCapabilities,
              ...(probedLocalGitRepos ? { localGitRepos: probedLocalGitRepos } : {}),
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            print.status("⚠️", `capabilities upload skipped: ${msg}`);
          }
        }

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
        if ((error as { name?: string }).name === "ExitPromptError") {
          print.line("\n  Cancelled.\n");
          return;
        }
        if (error instanceof ClientUserMismatchError) {
          print.line("\n");
          print.line("  ⚠️  This client.yaml is owned by a different user.\n");
          print.line("  Run `first-tree-hub client claim --confirm` to transfer ownership\n");
          print.line("  to your account. The previous owner's agents will be unpinned\n");
          print.line("  from this machine.\n\n");
          process.exit(1);
        }
        if (error instanceof ClientOrgMismatchError) {
          // --no-service path lands here when the credentials we just saved
          // belong to a different org than the local clientId. Reuse the
          // same rotate-and-guide flow as `client start` — interactive mode
          // so the operator can decline if they prefer to keep the old id.
          await handleClientOrgMismatch(error, {
            managed: false,
            configDir: DEFAULT_CONFIG_DIR,
            rerunCommand: `first-tree-hub client connect ${serverUrl}${options.token ? " --token <token>" : ""}${options.service === false ? " --no-service" : ""}`,
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
