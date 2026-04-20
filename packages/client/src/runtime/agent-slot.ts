import { join } from "node:path";
import type {
  InboxEntryWithMessage,
  RuntimeState,
  SessionEvent,
  SessionState,
} from "@agent-team-foundation/first-tree-hub-shared";
import { DEFAULT_DATA_DIR } from "@agent-team-foundation/first-tree-hub-shared/config";
import type { ClientConnection } from "../client-connection.js";
import type { RegisterResult } from "../sdk.js";
import { type AgentConfigCache, createAgentConfigCache } from "./agent-config-cache.js";
import type { SessionConfig } from "./config.js";
import { createGitMirrorManager } from "./git-mirror-manager.js";
import type { HandlerFactory } from "./handler.js";
import { SessionManager } from "./session-manager.js";

export type AgentSlotConfig = {
  name: string;
  /** Agent UUID (from agent.yaml) — sent as X-Agent-Id on every HTTP call. */
  agentId: string;
  serverUrl: string;
  type: string;
  handlerFactory: HandlerFactory;
  session: SessionConfig;
  concurrency: number;
  /** Shared client connection (always present in unified-user-token milestone). */
  clientConnection: ClientConnection;
  runtimeType?: string;
  runtimeVersion?: string;
};

type ConnectionListener =
  | { event: "agent:message"; fn: (agentId: string, data: unknown) => void }
  | { event: "agent:bound"; fn: (agent: { agentId: string }) => void }
  | { event: "session:command"; fn: (cmd: { agentId: string; chatId: string; type: string }) => void };

export class AgentSlot {
  private sessionManager: SessionManager | null = null;
  private readonly config: AgentSlotConfig;
  private readonly logFn: (msg: string) => void;
  private sdk: import("../sdk.js").FirstTreeHubSDK | null = null;
  private agentConfigCache: AgentConfigCache | null = null;
  private pollingTimer: ReturnType<typeof setInterval> | null = null;
  private listeners: ConnectionListener[] = [];

  constructor(config: AgentSlotConfig) {
    this.config = config;
    this.logFn = (msg: string) => {
      process.stderr.write(`[${config.name}] ${msg}\n`);
    };
  }

  private get clientConnection(): ClientConnection {
    return this.config.clientConnection;
  }

  async start(contextTreePath?: string | null): Promise<RegisterResult> {
    const bound = await this.clientConnection.bindAgent(
      this.config.agentId,
      this.config.runtimeType ?? this.config.type,
      this.config.runtimeVersion,
    );
    const sdk = bound.sdk;
    this.sdk = sdk;
    const agent = await sdk.register();

    this.logFn(`Bound as ${agent.displayName ?? agent.agentId} (${agent.agentId})`);

    if (agent.type === "human") {
      this.logFn("Server reports type=human — message processing disabled");
      return agent;
    }

    this.agentConfigCache = createAgentConfigCache({ sdk, log: this.logFn });
    try {
      const cfg = await this.agentConfigCache.refresh(agent.agentId);
      this.logFn(`Loaded runtime config v${cfg.version}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logFn(`Failed to fetch agent config — bind aborted: ${msg}`);
      throw new Error(`Hub unreachable while loading agent config: ${msg}`);
    }

    const onMessage = (agentId: string) => {
      if (agentId === this.config.agentId) this.pullAndDispatch();
    };
    const onBound = (boundAgent: { agentId: string }) => {
      if (boundAgent.agentId === this.config.agentId) this.fullStateSync();
    };
    this.clientConnection.on("agent:message", onMessage);
    this.clientConnection.on("agent:bound", onBound);
    this.listeners.push({ event: "agent:message", fn: onMessage }, { event: "agent:bound", fn: onBound });

    const registryPath = join(DEFAULT_DATA_DIR, "sessions", `${this.config.name}.json`);

    // Shared bare-mirror root across all agents of this client runtime — the
    // directory layout hashes by URL so concurrent agents on the same repo
    // reuse the same mirror (PRD §5.1.5).
    const gitMirrorManager = createGitMirrorManager({
      dataDir: DEFAULT_DATA_DIR,
      log: (event, fields) => this.logFn(`git[${event}] ${JSON.stringify(fields)}`),
    });

    this.sessionManager = new SessionManager({
      session: this.config.session,
      concurrency: this.config.concurrency,
      handlerFactory: this.config.handlerFactory,
      handlerConfig: {
        workspaceRoot: join(DEFAULT_DATA_DIR, "workspaces", this.config.name),
        contextTreePath: contextTreePath ?? undefined,
        gitMirrorManager,
      },
      agentIdentity: {
        agentId: agent.agentId,
        displayName: agent.displayName,
        type: agent.type,
        delegateMention: agent.delegateMention,
        metadata: agent.metadata,
      },
      sdk,
      log: this.logFn,
      registryPath,
      agentConfigCache: this.agentConfigCache,
      onStateChange: (chatId, state) => this.reportSessionState(chatId, state),
      onRuntimeStateChange: (state) => this.reportRuntimeState(state),
      onSessionEvent: (chatId, event) => this.reportSessionEvent(chatId, event),
      onSessionCompletion: (chatId) => this.reportSessionCompletion(chatId),
    });

    const onCommand = (cmd: { agentId: string; chatId: string; type: string }) => {
      if (cmd.agentId === this.config.agentId && this.sessionManager) {
        this.sessionManager.handleCommand(cmd.chatId, cmd.type as "session:suspend").catch((err) => {
          this.logFn(`Session command error: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
    };
    this.clientConnection.on("session:command", onCommand);
    this.listeners.push({ event: "session:command", fn: onCommand });

    this.startPolling();

    return agent;
  }

  async stop(): Promise<void> {
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }
    for (const entry of this.listeners) {
      if (entry.event === "agent:message") this.clientConnection.off(entry.event, entry.fn);
      else if (entry.event === "agent:bound") this.clientConnection.off(entry.event, entry.fn);
      else this.clientConnection.off(entry.event, entry.fn);
    }
    this.listeners = [];
    await this.clientConnection.unbindAgent(this.config.agentId);
    await this.sessionManager?.shutdown();
    this.logFn("Stopped");
  }

  private reportSessionState(chatId: string, state: SessionState): void {
    this.clientConnection.reportSessionState(this.config.agentId, chatId, state);
  }

  private reportRuntimeState(state: RuntimeState): void {
    this.clientConnection.reportRuntimeState(this.config.agentId, state);
  }

  private reportSessionEvent(chatId: string, event: SessionEvent): void {
    this.clientConnection.reportSessionEvent(this.config.agentId, chatId, event);
  }

  private reportSessionCompletion(chatId: string): void {
    this.clientConnection.reportSessionCompletion(this.config.agentId, chatId);
  }

  private fullStateSync(): void {
    if (!this.sessionManager) return;
    for (const { chatId, state } of this.sessionManager.getSessionStates()) {
      this.clientConnection.reportSessionState(this.config.agentId, chatId, state);
    }
    const runtimeState = this.sessionManager.getAggregateRuntimeState();
    if (runtimeState) {
      this.clientConnection.reportRuntimeState(this.config.agentId, runtimeState);
    }
  }

  private startPolling(): void {
    this.pollingTimer = setInterval(() => {
      this.pullAndDispatch();
    }, 5000);
    this.pullAndDispatch();
  }

  private async pullAndDispatch(): Promise<void> {
    if (!this.sdk || !this.sessionManager) return;
    try {
      const { entries } = await this.sdk.pull(10);
      for (const entry of entries) {
        await this.sessionManager.dispatch(entry);
      }
    } catch (err) {
      this.logFn(`Poll error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export type { InboxEntryWithMessage };
