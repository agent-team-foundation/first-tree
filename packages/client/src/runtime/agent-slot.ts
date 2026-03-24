import type { InboxEntryWithMessage } from "@agent-hub/shared";
import { AgentConnection } from "../connection.js";
import type { RegisterResult } from "../sdk.js";
import type { SessionConfig } from "./config.js";
import { SessionManager } from "./session-manager.js";

export type AgentSlotConfig = {
  name: string;
  serverUrl: string;
  token: string;
  command: string;
  session: SessionConfig;
  concurrency: number;
  env?: Record<string, string>;
};

export class AgentSlot {
  private readonly connection: AgentConnection;
  private sessionManager: SessionManager | null = null;
  private readonly config: AgentSlotConfig;
  private readonly logFn: (msg: string) => void;
  private active = 0;

  constructor(config: AgentSlotConfig) {
    this.config = config;
    this.logFn = (msg: string) => {
      process.stderr.write(`[${config.name}] ${msg}\n`);
    };
    this.connection = new AgentConnection({
      serverUrl: config.serverUrl,
      token: config.token,
    });

    this.connection.on("connected", () => this.logFn("Connected"));
    this.connection.on("reconnecting", (attempt) => this.logFn(`Reconnecting (attempt ${attempt})...`));
    this.connection.on("error", (err) => this.logFn(`Error: ${err.message}`));
  }

  /** Start the agent slot: connect to server and begin processing. */
  async start(): Promise<RegisterResult> {
    const agent = await this.connection.connect();
    this.logFn(`Registered as ${agent.displayName ?? agent.agentId} (${agent.agentId})`);

    this.sessionManager = new SessionManager({
      session: this.config.session,
      command: this.config.command,
      env: this.config.env,
      agentIdentity: { agentId: agent.agentId, displayName: agent.displayName },
      sdk: this.connection.sdk,
      log: this.logFn,
    });

    this.connection.onMessage(async (entry: InboxEntryWithMessage) => {
      await this.acquireConcurrency();
      try {
        await this.sessionManager?.dispatch(entry);
      } finally {
        this.releaseConcurrency();
      }
    });

    return agent;
  }

  /** Stop the agent slot gracefully. */
  async stop(): Promise<void> {
    await this.sessionManager?.shutdown();
    await this.connection.disconnect();
    this.logFn("Stopped");
  }

  // Simple semaphore for concurrency control
  private acquireResolvers: Array<() => void> = [];

  private async acquireConcurrency(): Promise<void> {
    if (this.active < this.config.concurrency) {
      this.active++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.acquireResolvers.push(() => {
        this.active++;
        resolve();
      });
    });
  }

  private releaseConcurrency(): void {
    this.active--;
    const next = this.acquireResolvers.shift();
    if (next) {
      next();
    }
  }
}
