import { ClientConnection } from "../client-connection.js";
import type { AccessTokenProvider } from "../sdk.js";
import { AgentSlot } from "./agent-slot.js";
import { syncContextTree } from "./bootstrap.js";
import type { RuntimeConfig } from "./config.js";
import { getHandlerFactory } from "./handler.js";
import { type UpdateHooks, UpdateManager } from "./update-manager.js";

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
  /**
   * Version of the consumer-facing Command package this runtime was bundled
   * with. Advertised to the server as `sdkVersion` at `client:register`, and
   * compared by the UpdateManager against the server-advertised version.
   * The UpdateManager only engages when both this and `update` are set.
   */
  currentVersion?: string;
  /**
   * Self-update config + command-layer callbacks. Grouped so half-wired
   * configurations (e.g. config without prompt) can't silently disable the
   * manager.
   */
  update?: UpdateHooks;
};

const DEFAULT_SHUTDOWN_TIMEOUT = 30_000;

export class AgentRuntime {
  private readonly slots: AgentSlot[] = [];
  private readonly config: RuntimeConfig;
  private readonly shutdownTimeout: number;
  private readonly clientConnection: ClientConnection;
  private readonly getAccessToken: AccessTokenProvider;
  private readonly currentVersion: string | undefined;
  private readonly updateHooks: UpdateHooks | undefined;
  private updateManager: UpdateManager | null = null;
  private stopping = false;

  constructor(options: AgentRuntimeOptions) {
    this.config = options.config;
    this.shutdownTimeout = options.shutdownTimeout ?? DEFAULT_SHUTDOWN_TIMEOUT;
    this.getAccessToken = options.getAccessToken;
    this.currentVersion = options.currentVersion;
    this.updateHooks = options.update;

    this.clientConnection = new ClientConnection({
      serverUrl: this.config.server,
      clientId: options.clientId,
      sdkVersion: options.currentVersion,
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

  private aggregateQuietGate(): { activeCount: number; lastActivityMs: number } {
    let activeCount = 0;
    let lastActivityMs = 0;
    for (const slot of this.slots) {
      const snap = slot.getQuietGateSnapshot();
      activeCount += snap.activeCount;
      if (snap.lastActivityMs > lastActivityMs) lastActivityMs = snap.lastActivityMs;
    }
    return { activeCount, lastActivityMs };
  }

  async start(): Promise<void> {
    const log = (msg: string) => this.log(msg);

    const contextTreePath = await syncContextTree(this.config.server, this.getAccessToken, log);
    if (!contextTreePath) {
      log("Context Tree not configured or sync skipped — agents will start without organizational context");
    }

    // Attach before connecting so the first welcome frame on a stale Client
    // is acted on rather than missed until the next reconnect.
    if (this.currentVersion && this.updateHooks) {
      this.updateManager = UpdateManager.attach(this.clientConnection, {
        currentVersion: this.currentVersion,
        ...this.updateHooks,
        isTTY: Boolean(process.stdout.isTTY),
        log: (level, msg) => this.log(`[update/${level}] ${msg}`),
        getQuietGateSnapshot: () => this.aggregateQuietGate(),
      });
      log(`Update manager attached (policy=${this.updateHooks.updateConfig.policy}, version=${this.currentVersion})`);
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
    this.updateManager?.dispose();
    this.updateManager = null;
    await Promise.allSettled(this.slots.map((slot) => slot.stop()));
    await this.clientConnection.disconnect();
  }
}
