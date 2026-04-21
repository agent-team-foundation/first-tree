import { ClientConnection } from "../client-connection.js";
import type { AccessTokenProvider } from "../sdk.js";
import { AgentSlot } from "./agent-slot.js";
import { syncContextTree } from "./bootstrap.js";
import type { RuntimeConfig } from "./config.js";
import { getHandlerFactory } from "./handler.js";

export type AgentRuntimeOptions = {
  config: RuntimeConfig;
  /**
   * Returns the current member access JWT. Host processes (e.g. the command
   * package) are responsible for keeping this fresh; the runtime calls it on
   * every WS handshake and every SDK request.
   */
  getAccessToken: AccessTokenProvider;
  /** Stable per-machine client identifier. Generated if omitted. */
  clientId?: string;
  shutdownTimeout?: number;
};

const DEFAULT_SHUTDOWN_TIMEOUT = 30_000;

export class AgentRuntime {
  private readonly slots: AgentSlot[] = [];
  private readonly config: RuntimeConfig;
  private readonly shutdownTimeout: number;
  private readonly clientConnection: ClientConnection;
  private readonly getAccessToken: AccessTokenProvider;
  private stopping = false;

  constructor(options: AgentRuntimeOptions) {
    this.config = options.config;
    this.shutdownTimeout = options.shutdownTimeout ?? DEFAULT_SHUTDOWN_TIMEOUT;
    this.getAccessToken = options.getAccessToken;

    this.clientConnection = new ClientConnection({
      serverUrl: this.config.server,
      clientId: options.clientId,
      getAccessToken: this.getAccessToken,
    });

    // Surface transport-level errors (TLS resets, DNS hiccups, WS handshake
    // failures) to operators. ClientConnection's own reconnect loop handles
    // recovery; a process-wide crash guard lives in ClientConnection itself.
    this.clientConnection.on("error", (err) => this.log(`client connection error: ${err.message}`));

    for (const [name, agentConfig] of Object.entries(this.config.agents)) {
      const handlerFactory = getHandlerFactory(agentConfig.type);
      this.slots.push(
        new AgentSlot({
          name,
          agentId: agentConfig.agentId,
          serverUrl: this.config.server,
          type: agentConfig.type,
          handlerFactory,
          session: agentConfig.session,
          concurrency: agentConfig.concurrency,
          clientConnection: this.clientConnection,
          runtimeType: agentConfig.type,
        }),
      );
    }
  }

  private log(msg: string): void {
    process.stderr.write(`[runtime] ${msg}\n`);
  }

  async start(): Promise<void> {
    const log = (msg: string) => this.log(msg);

    const contextTreePath = await syncContextTree(this.config.server, this.getAccessToken, log);
    if (!contextTreePath) {
      log("Context Tree not configured or sync skipped — agents will start without organizational context");
    }

    log(`Connecting client (${this.clientConnection.clientId})...`);
    await this.clientConnection.connect();
    log(`Client connected (${this.clientConnection.clientId})`);

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

  async stop(): Promise<void> {
    await Promise.allSettled(this.slots.map((slot) => slot.stop()));
    await this.clientConnection.disconnect();
  }
}
