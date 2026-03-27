import { AgentRuntime, loadRuntimeConfig, registerBuiltinHandlers } from "@first-tree-core/client";
import type { Command } from "commander";
import { fail } from "./output.js";
import { log } from "./util.js";

export function registerStartCommand(program: Command): void {
  program
    .command("start")
    .description("Start the Agent Runtime — manage multiple agents from a config file")
    .option("-c, --config <path>", "Path to agents.yaml config file", "./agents.yaml")
    .option("--server <url>", "Override server URL from config")
    .option("--shutdown-timeout <ms>", "Graceful shutdown timeout in ms", "30000")
    .action(async (options: { config: string; server?: string; shutdownTimeout: string }) => {
      try {
        registerBuiltinHandlers();

        log("runtime", `Loading config from ${options.config}`);
        const config = loadRuntimeConfig(options.config);

        if (options.server) {
          config.server = options.server;
        }

        const shutdownTimeout = Number.parseInt(options.shutdownTimeout, 10);
        if (Number.isNaN(shutdownTimeout) || shutdownTimeout < 0) {
          fail("INVALID_OPTION", "shutdown-timeout must be a positive number", 2);
        }

        const runtime = new AgentRuntime({ config, shutdownTimeout });
        await runtime.start();
      } catch (error) {
        if (error instanceof Error) {
          log("runtime", `Fatal: ${error.message}`);
          process.exit(1);
        }
        throw error;
      }
    });
}
