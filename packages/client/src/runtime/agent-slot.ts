import { join } from "node:path";
import type {
  InboxDeliverFrame,
  InboxEntryWithMessage,
  RuntimeState,
  SessionEvent,
  SessionState,
} from "@first-tree/shared";
import { DEFAULT_DATA_DIR } from "@first-tree/shared/config";
import type { ClientConnection, SessionReconcileResult } from "../client-connection.js";
import { createLogger, type pino } from "../observability/logger.js";
import type { RegisterResult } from "../sdk.js";
import { type AgentConfigCache, createAgentConfigCache } from "./agent-config-cache.js";
import { syncAgentContextTree } from "./bootstrap.js";
import type { SessionConfig } from "./config.js";
import type { GitMirrorManager } from "./git-mirror-manager.js";
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
  /**
   * Shared across every AgentSlot on the same runtime. The manager's per-URL
   * serial queue (`withUrlLock`) is the only thing that prevents two agents on
   * the same chat from racing on `git worktree add` against the shared bare
   * mirror's `config` file — so a per-slot instance is wrong by construction.
   */
  gitMirrorManager: GitMirrorManager;
  runtimeType?: string;
  runtimeVersion?: string;
};

type ConnectionListener =
  | { event: "inbox:deliver"; fn: (inboxId: string, frame: InboxDeliverFrame) => void }
  | { event: "agent:bound"; fn: (agent: { agentId: string }) => void }
  | { event: "session:command"; fn: (cmd: { agentId: string; chatId: string; type: string }) => void }
  | { event: "session:reconcile:result"; fn: (result: SessionReconcileResult) => void };

export class AgentSlot {
  private sessionManager: SessionManager | null = null;
  private readonly config: AgentSlotConfig;
  private logger: pino.Logger;
  private agentConfigCache: AgentConfigCache | null = null;
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  private listeners: ConnectionListener[] = [];
  /**
   * The inbox this slot's agent owns — used to filter `inbox:deliver`
   * frames addressed to other agents on the same client. Captured at
   * `start()` from `sdk.register()`.
   */
  private inboxId: string | null = null;

  constructor(config: AgentSlotConfig) {
    this.config = config;
    this.logger = createLogger("slot").child({ agentName: config.name, agentId: config.agentId });
  }

  get name(): string {
    return this.config.name;
  }

  get agentId(): string {
    return this.config.agentId;
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

  async start(): Promise<RegisterResult> {
    const bound = await this.clientConnection.bindAgent(
      this.config.agentId,
      this.config.runtimeType ?? this.config.type,
      this.config.runtimeVersion,
    );
    const sdk = bound.sdk;
    const agent = await sdk.register();

    this.logger.info({ displayName: agent.displayName }, "agent bound");

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

    this.inboxId = agent.inboxId;
    const contextTreeBinding = await syncAgentContextTree(sdk, (msg) => this.logger.info(msg));
    if (!contextTreeBinding) {
      this.logger.info("context tree not configured or sync skipped — agent will start without organizational context");
    }

    const onInboxDeliver = (inboxId: string, frame: InboxDeliverFrame) => {
      if (inboxId !== this.inboxId) return;
      this.dispatchPushedFrame(frame).catch((err) => {
        this.logger.warn({ err, entryId: frame.entryId }, "inbox:deliver dispatch error");
      });
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
    this.clientConnection.on("inbox:deliver", onInboxDeliver);
    this.clientConnection.on("agent:bound", onBound);
    this.clientConnection.on("session:reconcile:result", onReconcileResult);
    this.listeners.push(
      { event: "inbox:deliver", fn: onInboxDeliver },
      { event: "agent:bound", fn: onBound },
      { event: "session:reconcile:result", fn: onReconcileResult },
    );

    const registryPath = join(DEFAULT_DATA_DIR, "sessions", `${this.config.name}.json`);

    // The runtime owns the GitMirrorManager and injects it here — sharing one
    // manager across slots is what makes `withUrlLock` actually serialise
    // concurrent worktree adds for the same URL (PRD §5.1.5).
    const gitMirrorManager = this.config.gitMirrorManager;

    // Ack is fire-and-forget over WS: `ws.send` doesn't block on flush and
    // SessionManager treats ack as advisory. Wrap in a resolved Promise so
    // the `(id) => Promise<void>` config signature is satisfied.
    const ackEntry = (entryId: number) => {
      this.clientConnection.sendInboxAck(entryId);
      return Promise.resolve();
    };

    this.sessionManager = new SessionManager({
      session: this.config.session,
      concurrency: this.config.concurrency,
      handlerFactory: this.config.handlerFactory,
      handlerConfig: {
        workspaceRoot: join(DEFAULT_DATA_DIR, "workspaces", this.config.name),
        agentName: this.config.name,
        contextTreePath: contextTreeBinding?.path,
        contextTreeRepoUrl: contextTreeBinding?.repoUrl,
        gitMirrorManager,
      },
      agentIdentity: {
        agentId: agent.agentId,
        inboxId: agent.inboxId,
        displayName: agent.displayName,
        type: agent.type,
        visibility: agent.visibility,
        delegateMention: agent.delegateMention,
        metadata: agent.metadata,
      },
      sdk,
      log: this.logger,
      registryPath,
      agentConfigCache: this.agentConfigCache,
      ackEntry,
      onStateChange: (chatId, state) => this.reportSessionState(chatId, state),
      onRuntimeStateChange: (state) => this.reportRuntimeState(state),
      onSessionEvent: (chatId, event) => this.reportSessionEvent(chatId, event),
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

    this.startReconcileLoop();

    return agent;
  }

  async stop(): Promise<void> {
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    for (const entry of this.listeners) {
      this.clientConnection.off(entry.event, entry.fn);
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

  private fullStateSync(): void {
    if (!this.sessionManager) return;
    for (const { chatId, state } of this.sessionManager.getSessionStates()) {
      this.clientConnection.reportSessionState(this.config.agentId, chatId, state);
    }
    // After a process restart `sessions` is empty but SessionRegistry just
    // hydrated every persisted (chatId → claudeSessionId) row into
    // `evictedMappings`. Without this loop, the server's
    // `agent_chat_sessions.state` would stay on the pre-restart snapshot
    // (commonly `active`) forever — the next inbound message would only
    // refresh that one row, leaving the rest stale. "suspended" is the
    // closest in-schema state for "handler is gone but resumable".
    for (const chatId of this.sessionManager.getEvictedChatIds()) {
      this.clientConnection.reportSessionState(this.config.agentId, chatId, "suspended");
    }
    // Explicit "idle" clears any stale `working`/`blocked` on the server:
    // any in-flight work owned by the previous process died with its SDK
    // transport. The first inbound message will flip it back to `working`
    // through the normal session-runtime-state path.
    const runtimeState = this.sessionManager.getAggregateRuntimeState();
    this.clientConnection.reportRuntimeState(this.config.agentId, runtimeState ?? "idle");
  }

  /**
   * Translate an `inbox:deliver` push frame into the {@link InboxEntryWithMessage}
   * shape `SessionManager.dispatch` expects, then dispatch.
   *
   * Ack happens INSIDE `dispatch` via the `ackEntry` callback we pinned at
   * construction time — `clientConnection.sendInboxAck`. Sending an additional
   * ack here would double-ack: a WS frame the server cannot match against any
   * `delivered` row, which leaks the server's per-agent in-flight counter and
   * stalls push after `inboxMaxInFlightPerAgent` messages.
   *
   * Dispatch errors propagate up; the entry stays `delivered` server-side
   * and the 300s timeout reaper rolls it back to `pending` for replay.
   */
  private async dispatchPushedFrame(frame: InboxDeliverFrame): Promise<void> {
    if (!this.sessionManager) return;
    const entry: InboxEntryWithMessage = {
      id: frame.entryId,
      inboxId: frame.inboxId,
      messageId: frame.message.id,
      chatId: frame.chatId,
      // The DB columns we don't carry on the wire — set to the values the
      // claim path would have produced. Only `chatId`, `id`, and `message`
      // are read by SessionManager.dispatch, but keeping the shape correct
      // lets test fixtures and downstream consumers depend on the schema.
      status: "delivered",
      retryCount: 0,
      createdAt: frame.message.createdAt,
      deliveredAt: new Date().toISOString(),
      ackedAt: null,
      message: frame.message,
    };
    await this.sessionManager.dispatch(entry);
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
}

export type { InboxEntryWithMessage };
