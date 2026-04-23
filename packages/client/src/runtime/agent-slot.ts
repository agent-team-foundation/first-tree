import { join } from "node:path";
import type {
  InboxEntryWithMessage,
  RuntimeState,
  SessionEvent,
  SessionState,
} from "@agent-team-foundation/first-tree-hub-shared";
import { DEFAULT_DATA_DIR } from "@agent-team-foundation/first-tree-hub-shared/config";
import type { ClientConnection, SessionReconcileResult } from "../client-connection.js";
import { createLogger, type pino } from "../observability/logger.js";
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
  | { event: "session:command"; fn: (cmd: { agentId: string; chatId: string; type: string }) => void }
  | { event: "session:reconcile:result"; fn: (result: SessionReconcileResult) => void };

export class AgentSlot {
  private sessionManager: SessionManager | null = null;
  private readonly config: AgentSlotConfig;
  private logger: pino.Logger;
  private sdk: import("../sdk.js").FirstTreeHubSDK | null = null;
  private agentConfigCache: AgentConfigCache | null = null;
  private pollingTimer: ReturnType<typeof setInterval> | null = null;
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  private listeners: ConnectionListener[] = [];

  constructor(config: AgentSlotConfig) {
    this.config = config;
    this.logger = createLogger("slot").child({ agentName: config.name, agentId: config.agentId });
  }

  private get clientConnection(): ClientConnection {
    return this.config.clientConnection;
  }

  /**
   * Snapshot of this slot's busy/idle state used by the UpdateManager's
   * quiet gate. Returns zeros before `start()` has built the session manager,
   * which is the same semantics: idle.
   */
  getQuietGateSnapshot(): { activeCount: number; lastActivityMs: number } {
    return this.sessionManager?.getQuietGateSnapshot() ?? { activeCount: 0, lastActivityMs: 0 };
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

    this.logger.info({ displayName: agent.displayName ?? agent.agentId }, "agent bound");

    if (agent.type === "human") {
      this.logger.info("server reports type=human — message processing disabled");
      return agent;
    }

    this.agentConfigCache = createAgentConfigCache({ sdk, log: this.logger });
    try {
      const cfg = await this.agentConfigCache.refresh(agent.agentId);
      this.logger.info({ version: cfg.version }, "runtime config loaded");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error({ err }, "failed to fetch agent config — bind aborted");
      throw new Error(`Hub unreachable while loading agent config: ${msg}`);
    }

    const onMessage = (agentId: string) => {
      if (agentId === this.config.agentId) this.pullAndDispatch();
    };
    const onBound = (boundAgent: { agentId: string }) => {
      if (boundAgent.agentId === this.config.agentId) {
        this.fullStateSync();
        // One-shot post-bind reconcile catches operator-terminates that
        // landed while this client was offline; a duplicate tick is harmless.
        setTimeout(() => this.reconcileNow(), 5000);
      }
    };
    const onReconcileResult = (result: SessionReconcileResult) => {
      if (result.agentId === this.config.agentId && this.sessionManager) {
        this.sessionManager.applyStaleChatIds(result.staleChatIds);
      }
    };
    this.clientConnection.on("agent:message", onMessage);
    this.clientConnection.on("agent:bound", onBound);
    this.clientConnection.on("session:reconcile:result", onReconcileResult);
    this.listeners.push(
      { event: "agent:message", fn: onMessage },
      { event: "agent:bound", fn: onBound },
      { event: "session:reconcile:result", fn: onReconcileResult },
    );

    const registryPath = join(DEFAULT_DATA_DIR, "sessions", `${this.config.name}.json`);

    // Shared bare-mirror root across all agents of this client runtime — the
    // directory layout hashes by URL so concurrent agents on the same repo
    // reuse the same mirror (PRD §5.1.5).
    const gitMirrorManager = createGitMirrorManager({
      dataDir: DEFAULT_DATA_DIR,
      log: createLogger("git-mirror").child({ agentName: this.config.name, agentId: this.config.agentId }),
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
        inboxId: agent.inboxId,
        displayName: agent.displayName,
        type: agent.type,
        delegateMention: agent.delegateMention,
        metadata: agent.metadata,
      },
      sdk,
      log: this.logger,
      registryPath,
      agentConfigCache: this.agentConfigCache,
      onStateChange: (chatId, state) => this.reportSessionState(chatId, state),
      onRuntimeStateChange: (state) => this.reportRuntimeState(state),
      onSessionEvent: (chatId, event) => this.reportSessionEvent(chatId, event),
      onSessionCompletion: (chatId) => this.reportSessionCompletion(chatId),
    });

    const onCommand = (cmd: { agentId: string; chatId: string; type: string }) => {
      if (cmd.agentId === this.config.agentId && this.sessionManager) {
        this.sessionManager
          .handleCommand(cmd.chatId, cmd.type as "session:suspend" | "session:terminate")
          .catch((err) => {
            this.logger.error({ err, chatId: cmd.chatId, type: cmd.type }, "session command error");
          });
      }
    };
    this.clientConnection.on("session:command", onCommand);
    this.listeners.push({ event: "session:command", fn: onCommand });

    this.startPolling();
    this.startReconcileLoop();

    return agent;
  }

  async stop(): Promise<void> {
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    for (const entry of this.listeners) {
      if (entry.event === "agent:message") this.clientConnection.off(entry.event, entry.fn);
      else if (entry.event === "agent:bound") this.clientConnection.off(entry.event, entry.fn);
      else if (entry.event === "session:reconcile:result") this.clientConnection.off(entry.event, entry.fn);
      else this.clientConnection.off(entry.event, entry.fn);
    }
    this.listeners = [];
    await this.clientConnection.unbindAgent(this.config.agentId);
    await this.sessionManager?.shutdown();
    this.logger.info("stopped");
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

  private startReconcileLoop(): void {
    const intervalSec = this.config.session.reconcile_interval_seconds ?? 300;
    this.reconcileTimer = setInterval(() => this.reconcileNow(), intervalSec * 1000);
  }

  private reconcileNow(): void {
    if (!this.sessionManager) return;
    const chatIds = this.sessionManager.getHeldChatIds();
    if (chatIds.length === 0) return;
    this.clientConnection.sendSessionReconcile(this.config.agentId, chatIds);
  }

  private async pullAndDispatch(): Promise<void> {
    if (!this.sdk || !this.sessionManager) return;
    try {
      const { entries } = await this.sdk.pull(10);
      for (const entry of entries) {
        await this.sessionManager.dispatch(entry);
      }
    } catch (err) {
      this.logger.warn({ err }, "poll error");
    }
  }
}

export type { InboxEntryWithMessage };
