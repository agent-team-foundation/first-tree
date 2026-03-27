import { existsSync, mkdirSync, rmSync } from "node:fs";
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
} from "@first-tree-core/shared/config";
import type { Command } from "commander";
import { ClientRuntime } from "../client/runtime.js";
import { promptAddAgent, promptMissingFields } from "../server/prompt.js";
import {
  checkAgentConfigs,
  checkAgentTokens,
  checkClientConfig,
  checkNodeVersion,
  checkServerReachable,
  checkWebSocket,
  printResults,
} from "./doctor.js";

export function registerClientCommands(program: Command): void {
  const client = program.command("client").description("Manage First Tree Core client");

  client
    .command("start")
    .description("Start client — connect all configured agents to the server")
    .option("--no-interactive", "Skip interactive prompts (for Docker/CI)")
    .action(async (options: { interactive?: boolean }) => {
      try {
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

        // Load agents
        const agentsDir = join(DEFAULT_CONFIG_DIR, "agents");
        const agents = loadAgents({ schema: agentConfigSchema, agentsDir });

        if (agents.size === 0) {
          process.stderr.write("  No agents configured.\n");
          process.stderr.write("  Add one with: first-tree-core client add <name> --token <token>\n");
          process.exit(1);
        }

        process.stderr.write(`\n  Connecting to ${config.server.url}...\n`);

        const runtime = new ClientRuntime(config.server.url);
        for (const [name, agentConfig] of agents) {
          runtime.addAgent(name, agentConfig);
        }

        await runtime.start();

        // Graceful shutdown
        const shutdown = async () => {
          process.stderr.write("\n  Shutting down...\n");
          await runtime.stop();
          process.exit(0);
        };
        process.on("SIGINT", () => void shutdown());
        process.on("SIGTERM", () => void shutdown());

        // Keep process alive
        await new Promise(() => {});
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        process.stderr.write(`  Error: ${msg}\n`);
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
      process.stderr.write("\n  First Tree Core Client Doctor\n\n");
      const results = [
        checkNodeVersion(),
        checkClientConfig(),
        await checkServerReachable(),
        checkAgentConfigs(),
        await checkAgentTokens(),
        await checkWebSocket(),
      ];
      printResults(results);
    });

  client
    .command("stop")
    .description("Stop the client (sends SIGTERM to running process)")
    .action(() => {
      process.stderr.write("  Client stop: use Ctrl+C or `kill` the running process.\n");
      process.stderr.write("  Daemon mode with PID file is planned for a future release.\n");
    });

  client
    .command("status")
    .description("Show client and agent connection status")
    .action(() => {
      const agentsDir = join(DEFAULT_CONFIG_DIR, "agents");
      try {
        const agents = loadAgents({ schema: agentConfigSchema, agentsDir });
        if (agents.size === 0) {
          process.stderr.write("  No agents configured.\n");
          return;
        }
        process.stderr.write("\n  Configured agents:\n\n");
        for (const [name, config] of agents) {
          const masked = config.token.length > 8 ? `${config.token.slice(0, 6)}***${config.token.slice(-2)}` : "***";
          process.stderr.write(`  ${name.padEnd(20)} type: ${config.type.padEnd(14)} token: ${masked}\n`);
        }
        process.stderr.write("\n");
      } catch {
        process.stderr.write("  No agents directory found.\n");
      }
    });

  client
    .command("add [name]")
    .description("Add an agent instance")
    .option("-t, --token <token>", "Agent token")
    .action(async (name?: string, options?: { token?: string }) => {
      try {
        let agentName = name;
        let agentToken = options?.token;

        // Interactive if name or token not provided
        if (!agentName || !agentToken) {
          const result = await promptAddAgent();
          agentName = agentName ?? result.name;
          agentToken = agentToken ?? result.token;
        }

        const agentDir = join(DEFAULT_CONFIG_DIR, "agents", agentName);
        mkdirSync(agentDir, { recursive: true, mode: 0o700 });
        setConfigValue(join(agentDir, "agent.yaml"), "token", agentToken);

        process.stderr.write(`  Agent "${agentName}" added.\n`);
        process.stderr.write(`  Config: ${join(agentDir, "agent.yaml")}\n`);
      } catch (error) {
        if ((error as { name?: string }).name === "ExitPromptError") {
          process.stderr.write("\n  Cancelled.\n");
          return;
        }
        const msg = error instanceof Error ? error.message : String(error);
        process.stderr.write(`  Error: ${msg}\n`);
        process.exit(1);
      }
    });

  client
    .command("remove <name>")
    .description("Remove an agent instance")
    .action((name: string) => {
      const agentDir = join(DEFAULT_CONFIG_DIR, "agents", name);
      if (!existsSync(agentDir)) {
        process.stderr.write(`  Agent "${name}" not found.\n`);
        process.exit(1);
      }
      rmSync(agentDir, { recursive: true, force: true });
      process.stderr.write(`  Agent "${name}" removed.\n`);
    });

  client
    .command("list")
    .description("List configured agents")
    .action(() => {
      const agentsDir = join(DEFAULT_CONFIG_DIR, "agents");
      try {
        const agents = loadAgents({ schema: agentConfigSchema, agentsDir });
        if (agents.size === 0) {
          process.stderr.write("  No agents configured.\n");
          return;
        }
        for (const [name, config] of agents) {
          const masked = config.token.length > 8 ? `${config.token.slice(0, 6)}***${config.token.slice(-2)}` : "***";
          process.stderr.write(`  ${name.padEnd(20)} type: ${config.type.padEnd(14)} token: ${masked}\n`);
        }
      } catch {
        process.stderr.write("  No agents configured.\n");
      }
    });
}
