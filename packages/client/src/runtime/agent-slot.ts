import type { InboxEntryWithMessage } from "@agent-hub/shared";
import { AgentConnection } from "../connection.js";
import type { RegisterResult } from "../sdk.js";
import type { SessionConfig } from "./config.js";
import type { HandlerFactory } from "./handler.js";
import { Semaphore } from "./semaphore.js";
import { SessionManager } from "./session-manager.js";

export type AgentSlotConfig = {
  name: string;
  serverUrl: string;
  token: string;
  type: string;
  handlerFactory: HandlerFactory;
  session: SessionConfig;
  concurrency: number;
};

export class AgentSlot {
  private readonly connection: AgentConnection;
  private sessionManager: SessionManager | null = null;
  private readonly config: AgentSlotConfig;
  private readonly logFn: (msg: string) => void;
  private readonly semaphore: Semaphore;

  constructor(config: AgentSlotConfig) {
    this.config = config;
    this.semaphore = new Semaphore(config.concurrency);
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

  async start(): Promise<RegisterResult> {
    const agent = await this.connection.connect();
    this.logFn(`Registered as ${agent.displayName ?? agent.agentId} (${agent.agentId})`);

    this.sessionManager = new SessionManager({
      session: this.config.session,
      handlerFactory: this.config.handlerFactory,
      handlerConfig: {},
      agentIdentity: { agentId: agent.agentId, displayName: agent.displayName },
      sdk: this.connection.sdk,
      log: this.logFn,
    });

    this.connection.onMessage(async (entry: InboxEntryWithMessage) => {
      await this.semaphore.acquire();
      try {
        await this.sessionManager?.dispatch(entry);
      } finally {
        this.semaphore.release();
      }
    });

    return agent;
  }

  async stop(): Promise<void> {
    await this.sessionManager?.shutdown();
    await this.connection.disconnect();
    this.logFn("Stopped");
  }
}
