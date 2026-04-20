import { join } from "node:path";
import {
  agentConfigSchema,
  clientConfigSchema,
  DEFAULT_CONFIG_DIR,
  initConfig,
  loadAgents,
  resetConfig,
  resetConfigMeta,
  setConfigValue,
} from "@agent-team-foundation/first-tree-hub-shared/config";
import { input, password } from "@inquirer/prompts";
import type { Command } from "commander";
import { fail } from "../cli/output.js";
import { ClientRuntime, installClientService, isServiceSupported, saveCredentials } from "../core/index.js";

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
  process.stderr.write("\n  Log in to Hub:\n");

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

        // 1. Write server URL to client.yaml
        const clientConfigPath = join(DEFAULT_CONFIG_DIR, "client.yaml");
        setConfigValue(clientConfigPath, "server.url", url);
        process.stderr.write(`\n  \u2713 Server configured: ${url}\n`);

        // 2. Authenticate — token or interactive
        const tokens = options.token
          ? await authenticateWithToken(url, options.token)
          : await authenticateInteractive(url);

        saveCredentials({ ...tokens, serverUrl: url });
        process.stderr.write("  \u2713 Authenticated\n");

        // Touch config + client.id so the background service picks up the
        // persisted clientId on its first launch (see #99).
        resetConfig();
        resetConfigMeta();
        const config = await initConfig({
          schema: clientConfigSchema,
          role: "client",
        });
        process.stderr.write(`  \u2713 Connected as this computer (id: ${config.client.id})\n`);

        // 3. Install background service (default) OR run inline (--no-service).
        const shouldInstallService = options.service !== false && isServiceSupported();

        if (shouldInstallService) {
          const info = installClientService();
          process.stderr.write(
            `  \u2713 Installed as a background service (${info.platform}) — you can close this terminal\n\n`,
          );
          process.stderr.write(`    Unit:  ${info.unitPath}\n`);
          process.stderr.write(`    Logs:  ${info.logDir}\n`);
          if (info.state === "active" && info.detail) {
            process.stderr.write(`    State: running (${info.detail})\n`);
          }
          process.stderr.write("\n");
          return;
        }

        if (options.service === false) {
          process.stderr.write("  (--no-service) running inline — Ctrl+C to stop\n");
        } else {
          process.stderr.write(`  Background service not supported on ${process.platform}; running inline.\n`);
        }

        const agentsDir = join(DEFAULT_CONFIG_DIR, "agents");
        const agents = loadAgents({ schema: agentConfigSchema, agentsDir });

        const runtime = new ClientRuntime(config.server.url, config.client.id);
        for (const [name, agentConfig] of agents) {
          runtime.addAgent(name, agentConfig);
        }

        await runtime.start();
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
        if ((error as { name?: string }).name === "ExitPromptError") {
          process.stderr.write("\n  Cancelled.\n");
          return;
        }
        const msg = error instanceof Error ? error.message : String(error);
        process.stderr.write(`  Error: ${msg}\n`);
        process.exit(1);
      } finally {
        resetConfig();
        resetConfigMeta();
      }
    });
}
