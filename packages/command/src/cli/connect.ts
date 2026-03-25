import type { HandlerContext } from "@agent-hub/client";
import { AgentConnection, getHandlerFactory, registerBuiltinHandlers, Semaphore } from "@agent-hub/client";
import type { InboxEntryWithMessage } from "@agent-hub/shared";
import type { Command } from "commander";
import { handleError, log, resolveConfig } from "./util.js";

export function registerConnectCommand(program: Command): void {
  program
    .command("connect")
    .description("Connect a single agent to server and process messages")
    .option("-t, --type <type>", "Handler type", "claude-code")
    .option("--concurrency <n>", "Max parallel message processing", "5")
    .option("--server <url>", "Override AGENT_HUB_SERVER")
    .action(async (options: { type: string; concurrency: string; server?: string }) => {
      try {
        registerBuiltinHandlers();

        const config = resolveConfig();
        if (options.server) {
          config.serverUrl = options.server;
        }

        const handlerFactory = getHandlerFactory(options.type);
        const handler = handlerFactory({});
        const concurrency = Number.parseInt(options.concurrency, 10) || 5;
        const semaphore = new Semaphore(concurrency);

        const conn = new AgentConnection({
          serverUrl: config.serverUrl,
          token: config.token,
        });

        conn.on("connected", () => log("connect", "Connected"));
        conn.on("reconnecting", (attempt) => log("connect", `Reconnecting (attempt ${attempt})...`));
        conn.on("error", (err) => log("connect", `Error: ${err.message}`));

        const agent = await conn.connect();
        log("connect", `Registered as ${agent.displayName ?? agent.agentId} (${agent.agentId})`);

        const ctx: HandlerContext = {
          agent: { agentId: agent.agentId, displayName: agent.displayName },
          sdk: conn.sdk,
          log: (msg) => log("connect", msg),
        };

        conn.onMessage(async (entry: InboxEntryWithMessage) => {
          await semaphore.acquire();
          try {
            await handler.handle(entry, ctx);
          } catch (err) {
            log("connect", `Handler error: ${err instanceof Error ? err.message : String(err)}`);
          } finally {
            semaphore.release();
          }
        });

        const shutdown = async () => {
          log("connect", "Shutting down...");
          await handler.shutdown?.();
          await conn.disconnect();
          process.exit(0);
        };
        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
      } catch (error) {
        handleError(error);
      }
    });
}
