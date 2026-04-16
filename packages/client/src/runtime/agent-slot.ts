import { join } from "node:path";
import type { InboxEntryWithMessage, RuntimeState, SessionState } from "@agent-team-foundation/first-tree-hub-shared";
import { DEFAULT_DATA_DIR } from "@agent-team-foundation/first-tree-hub-shared/config";
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
  /** Shared client connection for multiplexed mode. */
  clientConnection?: ClientConnection;
  /** Runtime type for activity reporting. */
  runtimeType?: string;
  /** Runtime version for activity reporting. */
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
  private boundListeners: Array<{ event: string; fn: (...args: unknown[]) => void }> = [];

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

      const onMessage = (agentId: string) => {
        if (agentId === this.agentId) this.pullAndDispatch();
      };
      const onBound = (boundAgent: { agentId: string }) => {
        if (boundAgent.agentId === this.agentId) this.fullStateSync();
      };
      this.clientConnection.on("agent:message", onMessage);
      this.clientConnection.on("agent:bound", onBound);
      this.boundListeners.push(
        { event: "agent:message", fn: onMessage as (...args: unknown[]) => void },
        { event: "agent:bound", fn: onBound as (...args: unknown[]) => void },
      );
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
      onStateChange: this.clientConnection ? (chatId, state) => this.reportSessionState(chatId, state) : undefined,
      onRuntimeStateChange: this.clientConnection ? (state) => this.reportRuntimeState(state) : undefined,
      onSessionOutput: this.clientConnection
        ? (chatId, content) => this.reportSessionOutput(chatId, content)
        : undefined,
    });

    if (this.clientConnection) {
      // Listen for session commands from server (suspend/resume/terminate)
      const onCommand = (cmd: { agentId: string; chatId: string; type: string }) => {
        if (cmd.agentId === this.agentId && this.sessionManager) {
          this.sessionManager.handleCommand(cmd.chatId, cmd.type as "session:suspend").catch((err) => {
            this.logFn(`Session command error: ${err instanceof Error ? err.message : String(err)}`);
          });
        }
      };
      this.clientConnection.on("session:command", onCommand);
      this.boundListeners.push({ event: "session:command", fn: onCommand as (...args: unknown[]) => void });

      this.startPolling();
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
    // Remove all registered listeners to prevent accumulation on restart
    if (this.clientConnection) {
      for (const { event, fn } of this.boundListeners) {
        (this.clientConnection as unknown as { removeListener(e: string, f: unknown): void }).removeListener(event, fn);
      }
      this.boundListeners = [];
    }
    if (this.clientConnection && this.agentId) {
      await this.clientConnection.unbindAgent(this.agentId);
    }
    await this.sessionManager?.shutdown();
    if (this.legacyConnection) {
      await this.legacyConnection.disconnect();
    }
    this.logFn("Stopped");
  }

  private reportSessionState(chatId: string, state: SessionState): void {
    if (!this.clientConnection || !this.agentId) return;
    this.clientConnection.reportSessionState(this.agentId, chatId, state);
  }

  private reportRuntimeState(state: RuntimeState): void {
    if (!this.clientConnection || !this.agentId) return;
    this.clientConnection.reportRuntimeState(this.agentId, state);
  }

  private reportSessionOutput(chatId: string, content: string): void {
    if (!this.clientConnection || !this.agentId) return;
    this.clientConnection.reportSessionOutput(this.agentId, chatId, content);
  }

  private fullStateSync(): void {
    if (!this.sessionManager || !this.clientConnection || !this.agentId) return;
    // Re-sync per-session states
    for (const { chatId, state } of this.sessionManager.getSessionStates()) {
      this.clientConnection.reportSessionState(this.agentId, chatId, state);
    }
    // Re-sync aggregate runtime state so server doesn't hold stale value
    const runtimeState = this.sessionManager.getAggregateRuntimeState();
    if (runtimeState) {
      this.clientConnection.reportRuntimeState(this.agentId, runtimeState);
    }
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
