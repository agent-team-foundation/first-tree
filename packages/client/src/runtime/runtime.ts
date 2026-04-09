import { ClientConnection } from "../client-connection.js";
import { AgentSlot } from "./agent-slot.js";
import { syncContextTree } from "./bootstrap.js";
import type { RuntimeConfig } from "./config.js";
import { getHandlerFactory } from "./handler.js";

export type AgentRuntimeOptions = {
  config: RuntimeConfig;
  shutdownTimeout?: number;
  /** M1: use shared client connection (default: true if multiple agents) */
  useClientConnection?: boolean;
};

const DEFAULT_SHUTDOWN_TIMEOUT = 30_000;

export class AgentRuntime {
  private readonly slots: AgentSlot[] = [];
  private readonly config: RuntimeConfig;
  private readonly shutdownTimeout: number;
  private clientConnection: ClientConnection | null = null;
  private stopping = false;

  constructor(options: AgentRuntimeOptions) {
    this.config = options.config;
    this.shutdownTimeout = options.shutdownTimeout ?? DEFAULT_SHUTDOWN_TIMEOUT;

    const agentEntries = Object.entries(this.config.agents);
    const useClientConn = options.useClientConnection ?? agentEntries.length > 1;

    if (useClientConn) {
      this.clientConnection = new ClientConnection({
        serverUrl: this.config.server,
      });
    }

    for (const [name, agentConfig] of agentEntries) {
      const handlerFactory = getHandlerFactory(agentConfig.type);
      this.slots.push(
        new AgentSlot({
          name,
          serverUrl: this.config.server,
          token: agentConfig.token,
          type: agentConfig.type,
          handlerFactory,
          session: agentConfig.session,
          concurrency: agentConfig.concurrency,
          clientConnection: this.clientConnection ?? undefined,
          runtimeType: agentConfig.type,
        }),
      );
    }
  }

  /** Start all agent slots and block until shutdown signal. */
  async start(): Promise<void> {
    const log = (msg: string) => process.stderr.write(`[runtime] ${msg}\n`);

    // Sync shared Context Tree clone (uses first agent's token)
    const firstToken = Object.values(this.config.agents)[0]?.token;
    let contextTreePath: string | null = null;
    if (firstToken) {
      contextTreePath = await syncContextTree(this.config.server, firstToken, log);
    }
    if (!contextTreePath) {
      log("Context Tree not configured or sync skipped — agents will start without organizational context");
    }

    // M1: Connect shared client connection first
    if (this.clientConnection) {
      log(`Connecting client (${this.clientConnection.clientId})...`);
      await this.clientConnection.connect();
      log(`Client connected (${this.clientConnection.clientId})`);
    }

    log(`Starting ${this.slots.length} agent(s)...`);

    const results = await Promise.allSettled(this.slots.map((slot) => slot.start(contextTreePath)));

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
    if (this.clientConnection) {
      await this.clientConnection.disconnect();
    }
  }
}
