import { join } from "node:path";
import type {
  InboxDeliverFrame,
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
import type { ContextTreeBinding } from "./bootstrap.js";
import type { SessionConfig } from "./config.js";
import { createGitMirrorManager } from "./git-mirror-manager.js";
import type { HandlerFactory } from "./handler.js";
import { SessionManager } from "./session-manager.js";
import { TreeWriteBackgroundRunner } from "./tree-write-runner.js";

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
  | { event: "inbox:deliver"; fn: (inboxId: string, frame: InboxDeliverFrame) => void }
  | {
      event: "task:tree_write:start";
      fn: (agentId: string, task: import("@agent-team-foundation/first-tree-hub-shared").TreeWriteTaskStart) => void;
    }
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
  private treeWriteRunner: TreeWriteBackgroundRunner | null = null;
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

  private reportContextTreeBinding(contextTreeBinding?: ContextTreeBinding | null): void {
    this.clientConnection.reportContextTreeBinding(this.config.agentId, {
      contextTreeRepoUrl: contextTreeBinding?.repoUrl ?? null,
      contextTreeBranch: contextTreeBinding?.branch ?? null,
      verificationStatus: contextTreeBinding?.verificationStatus ?? "unknown",
    });
  }

  async start(contextTreeBinding?: ContextTreeBinding | null): Promise<RegisterResult> {
    const bound = await this.clientConnection.bindAgent(
      this.config.agentId,
      this.config.runtimeType ?? this.config.type,
      this.config.runtimeVersion,
    );
    const sdk = bound.sdk;
    this.sdk = sdk;
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

    const onMessage = (agentId: string) => {
      if (agentId === this.config.agentId) this.pullAndDispatch();
    };
    const onInboxDeliver = (inboxId: string, frame: InboxDeliverFrame) => {
      if (inboxId !== this.inboxId) return;
      this.dispatchPushedFrame(frame).catch((err) => {
        this.logger.warn({ err, entryId: frame.entryId }, "inbox:deliver dispatch error");
      });
    };
    const onBound = (boundAgent: { agentId: string }) => {
      if (boundAgent.agentId === this.config.agentId) {
        this.fullStateSync();
        this.reportContextTreeBinding(contextTreeBinding);
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
    this.clientConnection.on("inbox:deliver", onInboxDeliver);
    this.clientConnection.on("agent:bound", onBound);
    this.clientConnection.on("session:reconcile:result", onReconcileResult);
    this.listeners.push(
      { event: "agent:message", fn: onMessage },
      { event: "inbox:deliver", fn: onInboxDeliver },
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

    // Pin the ack channel ONCE per slot. `clientConnection.supportsWsInboxDeliver`
    // is per-connection (resolves on `server:welcome`) and cannot flip mid-slot
    // — server-side per-socket subscriptions register a push handler OR the
    // legacy doorbell, never both, so the ack channel matches the delivery
    // channel for this slot's lifetime. Mixing them would leak the server's
    // per-agent in-flight counter (proposal hub-inbox-ws-data-plane §3.5).
    const ackEntry = this.clientConnection.supportsWsInboxDeliver
      ? (entryId: number) => {
          this.clientConnection.sendInboxAck(entryId);
          // sendInboxAck is fire-and-forget (`ws.send` doesn't block on flush);
          // SessionManager treats ack as advisory. Wrap in resolved Promise to
          // satisfy the `(id) => Promise<void>` config signature.
          return Promise.resolve();
        }
      : undefined;

    const handlerCfg = {
      workspaceRoot: join(DEFAULT_DATA_DIR, "workspaces", this.config.name),
      agentName: this.config.name,
      contextTreePath: contextTreeBinding?.path ?? undefined,
      contextTreeRepoUrl: contextTreeBinding?.repoUrl ?? undefined,
      gitMirrorManager,
    };

    this.sessionManager = new SessionManager({
      session: this.config.session,
      concurrency: this.config.concurrency,
      handlerFactory: this.config.handlerFactory,
      handlerConfig: handlerCfg,
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
      ackEntry,
      onStateChange: (chatId, state) => this.reportSessionState(chatId, state),
      onRuntimeStateChange: (state) => this.reportRuntimeState(state),
      onSessionEvent: (chatId, event) => this.reportSessionEvent(chatId, event),
    });

    this.treeWriteRunner = new TreeWriteBackgroundRunner({
      agent: {
        agentId: agent.agentId,
        inboxId: agent.inboxId,
        displayName: agent.displayName,
        type: agent.type,
        delegateMention: agent.delegateMention,
        metadata: agent.metadata,
      },
      handlerFactory: this.config.handlerFactory,
      handlerConfig: handlerCfg,
      sdk,
      log: (msg) => this.logger.info(msg),
      onHeartbeat: (taskId, attemptCount) =>
        this.clientConnection.reportTreeWriteTaskHeartbeat(this.config.agentId, taskId, attemptCount),
      onResult: (result) => this.clientConnection.reportTreeWriteTaskResult(this.config.agentId, result),
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
    const onTreeWriteTask = (
      agentId: string,
      task: import("@agent-team-foundation/first-tree-hub-shared").TreeWriteTaskStart,
    ) => {
      if (agentId !== this.config.agentId || !this.treeWriteRunner) return;
      this.treeWriteRunner.enqueue(task);
    };
    this.clientConnection.on("session:command", onCommand);
    this.clientConnection.on("task:tree_write:start", onTreeWriteTask);
    this.listeners.push(
      { event: "session:command", fn: onCommand },
      { event: "task:tree_write:start", fn: onTreeWriteTask },
    );

    this.startPolling();
    this.startReconcileLoop();
    this.reportContextTreeBinding(contextTreeBinding);

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
    await this.treeWriteRunner?.shutdown();
    for (const entry of this.listeners) {
      if (entry.event === "agent:message") this.clientConnection.off(entry.event, entry.fn);
      else if (entry.event === "inbox:deliver") this.clientConnection.off(entry.event, entry.fn);
      else if (entry.event === "task:tree_write:start") this.clientConnection.off(entry.event, entry.fn);
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
    // Skip the 5s HTTP poll when the server has negotiated the WS data plane
    // (`server:welcome.capabilities.wsInboxDeliver`). The push path drains
    // any in-flight backlog immediately after `agent:bound` (server-side),
    // so we don't need a kick-poll either. Legacy servers leave the
    // capability off and we keep polling exactly as before — that's the
    // rollback path (proposal hub-inbox-ws-data-plane §3.6).
    if (this.clientConnection.supportsWsInboxDeliver) {
      this.logger.info("WS inbox data plane active — skipping 5s HTTP poll");
      return;
    }
    this.pollingTimer = setInterval(() => {
      this.pullAndDispatch();
    }, 5000);
    this.pullAndDispatch();
  }

  /**
   * Translate an `inbox:deliver` push frame into the {@link InboxEntryWithMessage}
   * shape `SessionManager.dispatch` expects, then dispatch.
   *
   * Ack happens INSIDE `dispatch` via the `ackEntry` callback we pinned at
   * construction time — for push slots that's `clientConnection.sendInboxAck`,
   * for poll slots it stays the legacy `sdk.ack`. Sending an additional ack
   * here would double-ack: HTTP first (`delivered → acked`) followed by a
   * WS frame the server can no longer match against any `delivered` row,
   * which leaks the server's per-agent in-flight counter and stalls push
   * after `inboxMaxInFlightPerAgent` messages.
   *
   * Dispatch errors propagate up; the entry stays `delivered` server-side
   * and the 300s timeout reaper rolls it back to `pending` for replay
   * (proposal §3.7).
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
