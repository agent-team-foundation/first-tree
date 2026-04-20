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
import { ClientRuntime, saveCredentials } from "../core/index.js";

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
    .description("Connect to a Hub server — configure, authenticate, and start client")
    .option("--token <token>", "Connect token (from Hub web console) — skips interactive login")
    .action(async (serverUrl: string, options: { token?: string }) => {
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

        // 3. Start client process
        resetConfig();
        resetConfigMeta();

        const config = await initConfig({
          schema: clientConfigSchema,
          role: "client",
        });

        const agentsDir = join(DEFAULT_CONFIG_DIR, "agents");
        const agents = loadAgents({ schema: agentConfigSchema, agentsDir });

        process.stderr.write(`\n  Starting client (id: ${config.client.id})...\n`);

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
