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
import { ClientOrgMismatchError } from "@first-tree-hub/client";
import { select } from "@inquirer/prompts";
import type { Command } from "commander";
import { fail } from "../cli/output.js";
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
  saveCredentials,
} from "../core/index.js";
import { print } from "../core/output.js";

type ConnectJwt = {
  iss?: unknown;
  memberId?: unknown;
  organizationId?: unknown;
};

/**
 * @internal
 * Decode a JWT payload without verifying its signature. Used only by the
 * CLI's account-switch prompt and the URL-derivation helper below. Not
 * re-exported from `packages/command/src/index.ts` — external consumers
 * should call `deriveHubUrlFromToken` instead.
 */
export function decodeJwtPayload(token: string): ConnectJwt | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3 || !parts[1]) return null;
    const raw = Buffer.from(parts[1], "base64url").toString();
    const obj = JSON.parse(raw) as unknown;
    if (typeof obj !== "object" || obj === null) return null;
    return obj as ConnectJwt;
  } catch {
    return null;
  }
}

export class HubUrlDerivationError extends Error {
  constructor(
    public readonly code: "INVALID_TOKEN" | "TOKEN_MISSING_ISS" | "TOKEN_BAD_ISS",
    message: string,
  ) {
    super(message);
    this.name = "HubUrlDerivationError";
  }
}

/**
 * Derive the hub URL from a connect token's `iss` claim. Throws
 * `HubUrlDerivationError` when the claim is missing or malformed — we
 * *never* fall back to a default URL because that would let a stale
 * connect token from one environment silently re-target another (prod →
 * staging foot-gun).
 *
 * The action handler maps the thrown error to a `fail()` exit so this
 * function stays unit-testable without spawning a subprocess.
 */
export function deriveHubUrlFromToken(token: string): string {
  const payload = decodeJwtPayload(token);
  if (!payload) {
    throw new HubUrlDerivationError(
      "INVALID_TOKEN",
      "Connect token is not a valid JWT. Generate a new one from your Hub web console.",
    );
  }
  const iss = payload.iss;
  if (typeof iss !== "string" || iss.length === 0) {
    throw new HubUrlDerivationError(
      "TOKEN_MISSING_ISS",
      "Connect token does not carry an issuer (`iss` claim). Generate a new token from a Hub running v0.10+.",
    );
  }
  if (!/^https?:\/\//i.test(iss)) {
    throw new HubUrlDerivationError(
      "TOKEN_BAD_ISS",
      `Connect token issuer "${iss}" is not an http(s) URL. Generate a new token.`,
    );
  }
  return iss.replace(/\/+$/, "");
}

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
  print.line("     Replacing only affects THIS computer. Server-side data is untouched.\n\n");

  const choice = await select<"replace" | "cancel">({
    message: "How would you like to continue?",
    choices: [
      { name: "Replace — log out the other account and set up this one", value: "replace" },
      { name: "Cancel  — keep the existing setup", value: "cancel" },
    ],
  });

  return choice === "replace" ? "proceed" : "cancel";
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
 * Top-level `first-tree-hub connect <token>`. Single positional, no flags,
 * no env-var override — the connect token's `iss` claim carries the hub
 * URL so prod / staging / local environments are tagged at issuance and
 * the operator can never accidentally cross-target.
 */
export function registerSaaSConnectCommand(program: Command): void {
  program
    .command("connect <token>")
    .description("Connect this computer to the Hub using a token from the web console")
    .option("--no-service", "Skip background service install (runs inline until Ctrl+C)")
    .action(async (token: string, options: { service?: boolean }) => {
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
        if (newMemberId) {
          const decision = await promptReplaceOrCancel(newMemberId);
          if (decision === "cancel") {
            print.line("\n  Cancelled. Existing setup untouched.\n");
            return;
          }
        }

        const tokens = await exchangeToken(url, token);

        const clientConfigPath = join(DEFAULT_CONFIG_DIR, "client.yaml");
        setConfigValue(clientConfigPath, "server.url", url);
        print.line(`\n  ✓ Hub: ${url}\n`);

        saveCredentials({ ...tokens, serverUrl: url });
        print.line("  ✓ Authenticated\n");

        resetConfig();
        resetConfigMeta();
        const config = await initConfig({ schema: clientConfigSchema, role: "client" });
        print.line(`  ✓ Computer registered (id: ${config.client.id})\n`);

        const shouldInstallService = options.service !== false && isServiceSupported();
        if (shouldInstallService) {
          const info = installClientService();
          print.line(`  ✓ Background service installed (${info.platform}) — you may close this terminal.\n`);
          print.line(`    Logs: ${info.logDir}\n\n`);
          return;
        }

        if (options.service === false) {
          print.line("  (--no-service) running inline — Ctrl+C to stop\n");
        } else {
          print.line(`  Background service not supported on ${process.platform}; running inline.\n`);
        }

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

        const runtime = new ClientRuntime(config.server.url, config.client.id, {
          currentVersion: COMMAND_VERSION,
          update: {
            updateConfig: config.update,
            prompt: promptUpdate,
            executeUpdate: createExecuteUpdate({ managed: false }),
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
            configDir: DEFAULT_CONFIG_DIR,
            rerunCommand: "first-tree-hub connect <token>",
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
