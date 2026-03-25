import { AgentSlot } from "./agent-slot.js";
import type { RuntimeConfig } from "./config.js";
import { getHandlerFactory } from "./handler.js";

export type AgentRuntimeOptions = {
  config: RuntimeConfig;
  shutdownTimeout?: number;
};

const DEFAULT_SHUTDOWN_TIMEOUT = 30_000;

export class AgentRuntime {
  private readonly slots: AgentSlot[] = [];
  private readonly shutdownTimeout: number;
  private stopping = false;

  constructor(options: AgentRuntimeOptions) {
    const { config } = options;
    this.shutdownTimeout = options.shutdownTimeout ?? DEFAULT_SHUTDOWN_TIMEOUT;

    for (const [name, agentConfig] of Object.entries(config.agents)) {
      const handlerFactory = getHandlerFactory(agentConfig.type);
      this.slots.push(
        new AgentSlot({
          name,
          serverUrl: config.server,
          token: agentConfig.token,
          type: agentConfig.type,
          handlerFactory,
          session: agentConfig.session,
          concurrency: agentConfig.concurrency,
        }),
      );
    }
  }

  /** Start all agent slots and block until shutdown signal. */
  async start(): Promise<void> {
    const log = (msg: string) => process.stderr.write(`[runtime] ${msg}\n`);
    log(`Starting ${this.slots.length} agent(s)...`);

    const results = await Promise.allSettled(this.slots.map((slot) => slot.start()));

    let failed = 0;
    for (const result of results) {
      if (result.status === "rejected") {
        log(`Failed to start agent: ${result.reason instanceof Error ? result.reason.message : result.reason}`);
        failed++;
      }
    }

    if (failed === this.slots.length) {
      throw new Error("All agents failed to start");
    }

    log("Ready. Press Ctrl+C to stop.");

    // Wait for shutdown signal
    await new Promise<void>((resolve) => {
      const shutdown = async () => {
        if (this.stopping) return;
        this.stopping = true;
        log("Shutting down...");

        const timer = setTimeout(() => {
          log("Shutdown timeout reached, forcing exit");
          process.exit(1);
        }, this.shutdownTimeout);

        await this.stop();
        clearTimeout(timer);
        log("Stopped");
        resolve();
      };

      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    });
  }

  /** Stop all slots. */
  async stop(): Promise<void> {
    await Promise.allSettled(this.slots.map((slot) => slot.stop()));
  }
}
