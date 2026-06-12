import { join } from "node:path";
import type {
  InboxDeliverFrame,
  InboxEntryWithMessage,
  RuntimeState,
  SessionEvent,
  SessionState,
} from "@first-tree/shared";
import { defaultDataDir } from "@first-tree/shared/config";
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

/**
 * Canonical on-disk location of an agent's session registry — the persisted
 * `chatId → provider-native session id` mappings (`SessionRegistry`). Exposed
 * so higher layers that rebuild a slot under a different runtime provider can
 * clear the file: provider session ids are not portable across providers
 * (a Claude session id fed to Codex `resumeThread`, or vice versa, breaks
 * resume), so a provider switch must cold-start every chat.
 */
export function agentSessionRegistryPath(agentName: string): string {
  return join(defaultDataDir(), "sessions", `${agentName}.json`);
}

type ConnectionListener =
  | { event: "inbox:deliver"; fn: (inboxId: string, frame: InboxDeliverFrame) => void }
  | { event: "agent:bound"; fn: (agent: { agentId: string }) => void }
  | { event: "agent:unbound"; fn: (agentId: string, reason?: string) => void }
  | { event: "session:command"; fn: (cmd: { agentId: string; chatId: string; type: string }) => void }
  | { event: "session:reconcile:result"; fn: (result: SessionReconcileResult) => void };

export class AgentSlot {
  private sessionManager: SessionManager | null = null;
  private readonly config: AgentSlotConfig;
  private logger: pino.Logger;
  private agentConfigCache: AgentConfigCache | null = null;
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  private postBindReconcileTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners: ConnectionListener[] = [];
  private stopping: Promise<void> | null = null;
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
    // Attach listeners BEFORE `bindAgent` so the server's bind-time
    // reset+drain push (which fires within ~1ms of the `agent:bound`
    // response on the server side) never lands on a listener-less
    // emitter. Pre-PR the listeners were attached AFTER `bindAgent` +
    // `sdk.register` + `agentConfigCache.refresh` + `syncContextTree`
    // (50ms-15s window depending on Context Tree), and any
    // `inbox:deliver` frame arriving in that window was silently
    // dropped by Node's EventEmitter — the entry then stayed
    // `delivered` server-side and the in-process Deduplicator collapsed
    // every subsequent bind-reset replay (see
    // docs/inflight-message-recovery-design.md §4). The
    // `expectedInboxId` follows the agent-inbox naming convention from
    // `server/services/agent.ts:380` (`inbox_${uuid}`); the live
    // `this.inboxId` from `sdk.register()` overrides once available.
    const expectedInboxId = `inbox_${this.config.agentId}`;
    const earlyDeliverBuffer: InboxDeliverFrame[] = [];

    const onInboxDeliver = (inboxId: string, frame: InboxDeliverFrame) => {
      // Pre-`sdk.register` we don't yet have the authoritative inboxId,
      // so fall back to the convention. Once `this.inboxId` is set, the
      // strict check resumes.
      const ownInboxId = this.inboxId ?? expectedInboxId;
      if (inboxId !== ownInboxId) return;
      if (!this.sessionManager) {
        // SessionManager isn't built yet — buffer the frame; we'll
        // flush below once the manager is alive.
        earlyDeliverBuffer.push(frame);
        return;
      }
      this.dispatchPushedFrame(frame).catch((err) => {
        this.logger.warn({ err, entryId: frame.entryId }, "inbox:deliver dispatch error");
      });
    };
    const onBound = (boundAgent: { agentId: string }) => {
      if (boundAgent.agentId === this.config.agentId) {
        if (typeof this.sessionManager?.noteBindRecoveryComplete === "function") {
          this.sessionManager.noteBindRecoveryComplete();
        }
        // The first `agent:bound` can arrive while startup is still inside
        // sdk.register / config load / Context Tree sync, before
        // SessionManager exists. In that case the explicit startup
        // fullStateSync below owns both the state report and the delayed
        // reconcile. Reconnects with an existing SessionManager are handled
        // here.
        if (!this.sessionManager) return;
        this.fullStateSync();
        // One-shot post-bind reconcile catches operator-terminates that
        // landed while this client was offline. It is deliberately scheduled
        // after fullStateSync, so just-hydrated registry mappings are first
        // advertised as suspended before the server is asked for stale rows.
        this.schedulePostBindReconcile();
      }
    };
    const onReconcileResult = (result: SessionReconcileResult) => {
      if (result.agentId === this.config.agentId && this.sessionManager) {
        this.sessionManager.applyStaleChatIds(result.staleChatIds);
      }
    };
    const onUnbound = (agentId: string, reason?: string) => {
      if (agentId !== this.config.agentId || !reason) return;
      this.stop().catch((err) => {
        this.logger.error({ err, reason }, "forced agent stop failed");
      });
    };
    this.clientConnection.on("inbox:deliver", onInboxDeliver);
    this.clientConnection.on("agent:bound", onBound);
    this.clientConnection.on("agent:unbound", onUnbound);
    this.clientConnection.on("session:reconcile:result", onReconcileResult);
    this.listeners.push(
      { event: "inbox:deliver", fn: onInboxDeliver },
      { event: "agent:bound", fn: onBound },
      { event: "agent:unbound", fn: onUnbound },
      { event: "session:reconcile:result", fn: onReconcileResult },
    );

    let bindSucceeded = false;
    try {
      const bound = await this.clientConnection.bindAgent(
        this.config.agentId,
        this.config.runtimeType ?? this.config.type,
        this.config.runtimeVersion,
      );
      bindSucceeded = true;
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
        throw new Error(`First Tree server unreachable while loading agent config: ${msg}`);
      }

      this.inboxId = agent.inboxId;
      const contextTreeBinding = await syncAgentContextTree(sdk, (msg) => this.logger.info(msg));
      if (!contextTreeBinding) {
        this.logger.info(
          "context tree not configured or sync skipped — agent will start without organizational context",
        );
      }

      const registryPath = agentSessionRegistryPath(this.config.name);

      // The runtime owns the GitMirrorManager and injects it here — sharing one
      // manager across slots is what makes `withUrlLock` actually serialise
      // concurrent worktree adds for the same URL (PRD §5.1.5).
      const gitMirrorManager = this.config.gitMirrorManager;

      const ackEntry = (entryId: number) => this.clientConnection.sendInboxAck(entryId, agent.agentId);
      const recoverChat = (chatId: string) => this.clientConnection.sendInboxRecover(agent.agentId, chatId);

      this.sessionManager = new SessionManager({
        session: this.config.session,
        concurrency: this.config.concurrency,
        handlerFactory: this.config.handlerFactory,
        handlerConfig: {
          workspaceRoot: join(defaultDataDir(), "workspaces", this.config.name),
          agentName: this.config.name,
          contextTreePath: contextTreeBinding?.path,
          contextTreeRepoUrl: contextTreeBinding?.repoUrl,
          contextTreeBranch: contextTreeBinding?.branch,
          gitMirrorManager,
          // Identifies the owning client process. The claude-code-tui handler
          // uses it to scope tmux session ownership (orphan sweep / names) so
          // it never touches another live client's sessions. Other handlers
          // ignore it.
          clientId: this.clientConnection.clientId,
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
        recoverChat,
        onStateChange: (chatId, state) => this.reportSessionState(chatId, state),
        onRuntimeStateChange: (state) => this.reportRuntimeState(state),
        onSessionEvent: (chatId, event) => this.reportSessionEvent(chatId, event),
        onSessionRuntimeChange: (chatId, state) => this.reportSessionRuntime(chatId, state),
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

      // Flush any `inbox:deliver` frames the early listener captured
      // during init. With the bind-time reset+drain path (see design §4)
      // the server pushes pending entries the instant it processes the
      // `agent:bind` frame, but the surrounding `sdk.register` +
      // `agentConfigCache.refresh` + `syncAgentContextTree` chain above
      // can take anywhere from ~100ms (no Context Tree) to 15s
      // (cold-clone Context Tree). Without this flush every restart with
      // an un-acked in-flight message lost the recovery push and the
      // server row stayed `delivered` indefinitely — the in-process
      // Deduplicator absorbed every subsequent bind-reset replay so the
      // entry never re-dispatched and never acked.
      if (earlyDeliverBuffer.length > 0) {
        this.logger.info(
          { buffered: earlyDeliverBuffer.length },
          "flushing early inbox:deliver buffer — frames received during init window",
        );
        for (const frame of earlyDeliverBuffer.splice(0)) {
          this.dispatchPushedFrame(frame).catch((err) => {
            this.logger.warn({ err, entryId: frame.entryId }, "buffered inbox:deliver dispatch error");
          });
        }
      }

      // Initial-startup fullStateSync. The `on("agent:bound", onBound)`
      // listener above also fires here now that it's attached pre-bind,
      // but `sessionManager` was null inside its callback — so its
      // `fullStateSync()` call was a no-op. Run it explicitly now that
      // the manager exists.
      this.fullStateSync();
      this.schedulePostBindReconcile();

      this.startReconcileLoop();

      return agent;
    } catch (err) {
      await this.cleanupFailedStart({ unbind: bindSucceeded });
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = this.stopOnce();
    try {
      await this.stopping;
    } finally {
      this.stopping = null;
    }
  }

  private async stopOnce(): Promise<void> {
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    if (this.postBindReconcileTimer) {
      clearTimeout(this.postBindReconcileTimer);
      this.postBindReconcileTimer = null;
    }
    for (const entry of this.listeners) {
      this.clientConnection.off(entry.event, entry.fn);
    }
    this.listeners = [];
    await this.clientConnection.unbindAgent(this.config.agentId);
    await this.sessionManager?.shutdown();
    this.sessionManager = null;
    this.agentConfigCache = null;
    this.inboxId = null;
    this.logger.info("stopped");
  }

  private async cleanupFailedStart(opts: { unbind: boolean }): Promise<void> {
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    if (this.postBindReconcileTimer) {
      clearTimeout(this.postBindReconcileTimer);
      this.postBindReconcileTimer = null;
    }
    for (const entry of this.listeners) {
      this.clientConnection.off(entry.event, entry.fn);
    }
    this.listeners = [];
    if (opts.unbind) {
      try {
        await this.clientConnection.unbindAgent(this.config.agentId);
      } catch (err) {
        this.logger.warn({ err }, "failed to unbind after aborted agent start");
      }
    }
    await this.sessionManager?.shutdown();
    this.sessionManager = null;
    this.agentConfigCache = null;
    this.inboxId = null;
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

  private reportSessionRuntime(chatId: string, state: RuntimeState): void {
    this.clientConnection.reportSessionRuntime(this.config.agentId, chatId, state);
  }

  private fullStateSync(): void {
    if (!this.sessionManager) return;
    // ORDERING IS LOAD-BEARING: `session:state` frames flush before any
    // `session:runtime` frame so the server's `setSessionRuntime` (gated
    // on `state='active'`) can't fail-close because the state write
    // hadn't landed yet. TCP/WS preserves the order across this single
    // send loop, and the server-side `chainSessionOp` per-(agent,chat)
    // queue preserves it through the processing pipeline as well.
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
    // Re-assert the *real* per-chat runtime of every still-live session.
    // On a network reconnect (process intact) a session mid-turn is still
    // `working` and must stay so — this is what distinguishes a reconnect
    // from a process restart (where `sessions` is empty, so nothing here
    // reports `working` and the agent-global reset below settles
    // everything to idle).
    for (const { chatId, runtimeState } of this.sessionManager.getSessionRuntimeStates()) {
      this.clientConnection.reportSessionRuntime(this.config.agentId, chatId, runtimeState);
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
   * Ack happens INSIDE the SessionManager via the `ackEntry` callback we
   * pinned at construction time — `clientConnection.sendInboxAck`. Post
   * inflight-message-recovery the ack is deferred until the handler closes
   * the turn via `ctx.finishTurn(...)`. Sending an additional ack here
   * would double-ack: a WS frame the server cannot match against any
   * `delivered` row, which leaks the server's per-agent in-flight counter
   * and stalls push after `inboxMaxInFlightPerAgent` messages.
   *
   * Dispatch errors propagate up; the entry stays `delivered` server-side
   * and the next `agent:bind` resets it back to `pending` for redelivery
   * (see inflight-message-recovery-design.md §4).
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

  private schedulePostBindReconcile(): void {
    if (this.postBindReconcileTimer) clearTimeout(this.postBindReconcileTimer);
    this.postBindReconcileTimer = setTimeout(() => {
      this.postBindReconcileTimer = null;
      this.reconcileNow();
    }, 5000);
  }

  private reconcileNow(): void {
    if (!this.sessionManager) return;
    const chatIds = this.sessionManager.getHeldChatIds();
    if (chatIds.length === 0) return;
    this.clientConnection.sendSessionReconcile(this.config.agentId, chatIds);
  }
}

export type { InboxEntryWithMessage };
