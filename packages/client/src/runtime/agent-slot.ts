import { join } from "node:path";
import type { InboxEntryWithMessage } from "@first-tree-hub/shared";
import { DEFAULT_DATA_DIR } from "@first-tree-hub/shared/config";
import { AgentConnection } from "../connection.js";
import type { RegisterResult } from "../sdk.js";
import type { SessionConfig } from "./config.js";
import type { HandlerFactory } from "./handler.js";
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

  async start(contextTreePath?: string | null): Promise<RegisterResult> {
    const agent = await this.connection.connect();
    this.logFn(`Registered as ${agent.displayName ?? agent.agentId} (${agent.agentId})`);

    const registryPath = join(DEFAULT_DATA_DIR, "sessions", `${this.config.name}.json`);

    this.sessionManager = new SessionManager({
      session: this.config.session,
      concurrency: this.config.concurrency,
      handlerFactory: this.config.handlerFactory,
      handlerConfig: {
        workspaceRoot: join(DEFAULT_DATA_DIR, "workspaces", this.config.name),
        contextTreePath: contextTreePath ?? undefined,
      },
      agentIdentity: {
        agentId: agent.agentId,
        displayName: agent.displayName,
        type: agent.type,
        delegateMention: agent.delegateMention,
        profile: agent.profile,
        metadata: agent.metadata,
      },
      sdk: this.connection.sdk,
      log: this.logFn,
      registryPath,
    });

    this.connection.onMessage(async (entry: InboxEntryWithMessage) => {
      await this.sessionManager?.dispatch(entry);
    });

    return agent;
  }

  async stop(): Promise<void> {
    await this.sessionManager?.shutdown();
    await this.connection.disconnect();
    this.logFn("Stopped");
  }
}
