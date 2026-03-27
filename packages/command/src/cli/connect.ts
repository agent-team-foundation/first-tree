import { AgentSlot, getHandlerFactory, registerBuiltinHandlers } from "@first-tree-hub/client";
import type { Command } from "commander";
import { handleError, log, resolveConfig } from "./util.js";

export function registerConnectCommand(program: Command): void {
  program
    .command("connect")
    .description("Connect a single agent to server and process messages")
    .option("-t, --type <type>", "Handler type", "claude-code")
    .option("--concurrency <n>", "Max parallel message processing", "5")
    .option("--server <url>", "Override FIRST_TREE_HUB_SERVER")
    .action(async (options: { type: string; concurrency: string; server?: string }) => {
      try {
        registerBuiltinHandlers();

        const config = resolveConfig();
        if (options.server) {
          config.serverUrl = options.server;
        }

        const concurrency = Number.parseInt(options.concurrency, 10) || 5;
        const handlerFactory = getHandlerFactory(options.type);

        const slot = new AgentSlot({
          name: "connect",
          serverUrl: config.serverUrl,
          token: config.token,
          type: options.type,
          handlerFactory,
          session: { idle_timeout: 300, max_sessions: 10 },
          concurrency,
        });

        const agent = await slot.start();
        log("connect", `Registered as ${agent.displayName ?? agent.agentId} (${agent.agentId})`);

        const shutdown = async () => {
          log("connect", "Shutting down...");
          await slot.stop();
          process.exit(0);
        };
        process.on("SIGINT", () => void shutdown());
        process.on("SIGTERM", () => void shutdown());
      } catch (error) {
        handleError(error);
      }
    });
}
