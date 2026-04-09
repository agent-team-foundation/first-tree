import { join } from "node:path";
import type { InboxEntryWithMessage, RuntimeState } from "@first-tree-hub/shared";
import { DEFAULT_DATA_DIR } from "@first-tree-hub/shared/config";
import type { ClientConnection } from "../client-connection.js";
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
  /** M1: optional shared client connection */
  clientConnection?: ClientConnection;
  /** M1: runtime type for activity reporting */
  runtimeType?: string;
  /** M1: runtime version for activity reporting */
  runtimeVersion?: string;
};

export class AgentSlot {
  private readonly legacyConnection: AgentConnection | null;
  private readonly clientConnection: ClientConnection | null;
  private sessionManager: SessionManager | null = null;
  private readonly config: AgentSlotConfig;
  private readonly logFn: (msg: string) => void;
  private agentId: string | null = null;
  private sdk: import("../sdk.js").FirstTreeHubSDK | null = null;
  private pollingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: AgentSlotConfig) {
    this.config = config;
    this.logFn = (msg: string) => {
      process.stderr.write(`[${config.name}] ${msg}\n`);
    };

    if (config.clientConnection) {
      this.clientConnection = config.clientConnection;
      this.legacyConnection = null;
    } else {
      this.legacyConnection = new AgentConnection({
        serverUrl: config.serverUrl,
        token: config.token,
      });
      this.clientConnection = null;

      this.legacyConnection.on("connected", () => this.logFn("Connected"));
      this.legacyConnection.on("reconnecting", (attempt) => this.logFn(`Reconnecting (attempt ${attempt})...`));
      this.legacyConnection.on("error", (err) => this.logFn(`Error: ${err.message}`));
    }
  }

  async start(contextTreePath?: string | null): Promise<RegisterResult> {
    let agent: RegisterResult;
    let sdk: import("../sdk.js").FirstTreeHubSDK;

    if (this.clientConnection) {
      const bound = await this.clientConnection.bindAgent(
        this.config.token,
        this.config.runtimeType ?? this.config.type,
        this.config.runtimeVersion,
      );
      this.agentId = bound.agentId;
      sdk = bound.sdk;
      this.sdk = sdk;
      agent = await sdk.register();

      this.logFn(`Bound as ${agent.displayName ?? agent.agentId} (${agent.agentId})`);

      this.clientConnection.on("agent:message", () => {
        this.pullAndDispatch();
      });
    } else {
      const conn = this.legacyConnection as AgentConnection;
      agent = await conn.connect();
      this.agentId = agent.agentId;
      sdk = conn.sdk;

      this.logFn(`Registered as ${agent.displayName ?? agent.agentId} (${agent.agentId})`);
    }

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
      sdk,
      log: this.logFn,
      registryPath,
      onStateChange: this.clientConnection
        ? (state, description) => this.reportActivity(state, description)
        : undefined,
    });

    if (this.clientConnection) {
      this.startPolling();
      this.reportActivity("idle");
    } else {
      const conn = this.legacyConnection as AgentConnection;
      conn.onMessage(async (entry: InboxEntryWithMessage) => {
        await this.sessionManager?.dispatch(entry);
      });
    }

    return agent;
  }

  async stop(): Promise<void> {
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }
    if (this.clientConnection && this.agentId) {
      this.reportActivity("idle");
      await this.clientConnection.unbindAgent(this.agentId);
    }
    await this.sessionManager?.shutdown();
    if (this.legacyConnection) {
      await this.legacyConnection.disconnect();
    }
    this.logFn("Stopped");
  }

  private reportActivity(state: RuntimeState, description?: string): void {
    if (!this.clientConnection || !this.agentId) return;
    this.clientConnection.reportActivity(this.agentId, {
      state,
      description,
      activeSessions: this.sessionManager?.activeCount ?? 0,
      totalSessions: this.sessionManager?.totalCount ?? 0,
    });
  }

  private startPolling(): void {
    this.pollingTimer = setInterval(() => {
      this.pullAndDispatch();
    }, 5000);
    this.pullAndDispatch();
  }

  private async pullAndDispatch(): Promise<void> {
    if (!this.sdk) return;
    try {
      const { entries } = await this.sdk.pull(10);
      for (const entry of entries) {
        await this.sessionManager?.dispatch(entry);
      }
    } catch {
      // ignore polling errors
    }
  }
}
