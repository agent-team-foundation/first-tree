import type {
  InboxEntryWithMessage,
  RuntimeState,
  SessionEvent,
  SessionState,
} from "@agent-team-foundation/first-tree-hub-shared";
import type { FirstTreeHubSDK } from "../sdk.js";
import type { AgentConfigCache } from "./agent-config-cache.js";
import type { SessionConfig } from "./config.js";
import { Deduplicator } from "./deduplicator.js";
import type {
  AgentHandler,
  AgentIdentity,
  HandlerConfig,
  HandlerFactory,
  SessionContext,
  SessionMessage,
} from "./handler.js";
import { SessionRegistry } from "./session-registry.js";

type SessionEntry = {
  chatId: string;
  claudeSessionId: string;
  handler: AgentHandler;
  status: SessionState;
  lastActivity: number;
  /** In-flight suspend promise; awaited before resume to avoid race conditions. */
  suspending: Promise<void> | null;
};

type PendingMessage = {
  message: SessionMessage;
  chatId: string;
  entryId: number;
};

type SessionManagerConfig = {
  session: SessionConfig;
  concurrency: number;
  handlerFactory: HandlerFactory;
  handlerConfig: HandlerConfig;
  agentIdentity: AgentIdentity;
  sdk: FirstTreeHubSDK;
  log: (msg: string) => void;
  registryPath?: string;
  /** Step 4: optional config cache for refresh-before-dispatch on configVersion bump. */
  agentConfigCache?: AgentConfigCache;
  /** Callback when a session state changes (per-session granularity). */
  onStateChange?: (chatId: string, state: SessionState) => void;
  /** Callback when aggregated runtime state changes. */
  onRuntimeStateChange?: (state: RuntimeState) => void;
  /** Callback when a session emits a structured event (tool_call / error). */
  onSessionEvent?: (chatId: string, event: SessionEvent) => void;
  /** Callback when a session query completes end-to-end. */
  onSessionCompletion?: (chatId: string) => void;
};

/**
 * Manages per-chat session entries with session-oriented handler lifecycle.
 *
 * Key design:
 * - Delayed ACK: messages are ACKed when handler starts processing
 * - Three session states: active / suspended / evicted
 * - Streaming input injection for active sessions
 * - Concurrency limit on simultaneously active sessions
 * - Registry persistence for crash recovery
 */
/** Maximum number of evicted session mappings to retain for resume recovery. */
const MAX_EVICTED_MAPPINGS = 500;

export class SessionManager {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly evictedMappings = new Map<string, { claudeSessionId: string; lastActivity: number }>();
  private readonly config: SessionManagerConfig;
  private readonly deduplicator = new Deduplicator(1000);
  private readonly registry: SessionRegistry | null;
  private readonly pendingQueue: PendingMessage[] = [];
  private readonly lastReportedStates = new Map<string, SessionState>();
  private readonly sessionRuntimeStates = new Map<string, RuntimeState>();
  private lastReportedRuntimeState: RuntimeState | null = null;
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private _activeCount = 0;

  constructor(config: SessionManagerConfig) {
    this.config = config;
    this.registry = config.registryPath ? new SessionRegistry(config.registryPath) : null;
    this.idleTimer = setInterval(() => this.evictIdle(), 10_000);

    // Load persisted sessions (all start as suspended)
    this.loadPersistedSessions();
  }

  /**
   * Dispatch an inbox entry. ACK is deferred until handler starts processing.
   *
   * Delayed ACK: messages are ACKed when the handler begins processing,
   * not on pull. `delivered` = pulled but not yet processing,
   * `acked` = handler has started processing (read receipt).
   */
  async dispatch(entry: InboxEntryWithMessage): Promise<void> {
    const chatId = entry.chatId ?? entry.message.chatId;
    const messageId = entry.message.id;

    // 1. Deduplication
    if (this.deduplicator.isDuplicate(messageId)) {
      this.config.log(`Session ${chatId}: duplicate message ${messageId}, skipping`);
      return;
    }

    // 2. Step 4: refresh runtime config if the message brought a newer
    // version. This is the *only* trigger for active-session re-config —
    // matches PRD §7.2. Failures are logged but do not block delivery on
    // M1: handler integration in Step 6 will decide whether to use the
    // stale config or hold the message until Hub recovers.
    if (this.config.agentConfigCache) {
      try {
        await this.config.agentConfigCache.refreshIfNewer(
          this.config.agentIdentity.agentId,
          entry.message.configVersion,
        );
      } catch (err) {
        this.config.log(
          `[configVersionMismatch] agentId=${this.config.agentIdentity.agentId} chatId=${chatId} incomingVersion=${entry.message.configVersion} action=skip — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // 3. Extract message content (handler does not see inbox metadata)
    const message = this.extractMessage(entry);

    // 4. Route by session state — ACK happens inside route when handler starts
    await this.routeMessage(chatId, message, entry.id);
  }

  /** Handle a session command from the server (suspend/resume/terminate). */
  async handleCommand(
    chatId: string,
    command: "session:suspend" | "session:resume" | "session:terminate",
  ): Promise<void> {
    const session = this.sessions.get(chatId);

    if (command === "session:suspend") {
      if (session?.status === "active") {
        this.config.log(`Session ${chatId}: suspend command received`);
        this.suspendSession(session);
      }
    } else if (command === "session:resume") {
      if (session?.status === "suspended") {
        this.config.log(`Session ${chatId}: resume command received`);
        // Resume with no new user message — pass null to signal admin-triggered resume
        await this.resumeSession(session, null);
      }
    } else if (command === "session:terminate") {
      if (session) {
        this.config.log(`Session ${chatId}: terminate command received`);
        if (session.status === "active") {
          this._activeCount--;
          await session.handler.shutdown();
        }
        // Move to evicted
        this.addEvictedMapping(chatId, {
          claudeSessionId: session.claudeSessionId,
          lastActivity: session.lastActivity,
        });
        this.sessions.delete(chatId);
        this.sessionRuntimeStates.delete(chatId);
        this.recomputeRuntimeState();
        this.notifySessionState(chatId, "evicted");
        this.persistRegistry();
        this.drainPendingQueue();
      }
    }
  }

  /** Shut down all sessions gracefully. */
  async shutdown(): Promise<void> {
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }

    const shutdowns = [...this.sessions.values()].map((s) =>
      s.status === "active" ? s.handler.shutdown() : Promise.resolve(),
    );
    await Promise.allSettled(shutdowns);

    // Report active sessions as suspended before clearing
    for (const [chatId, session] of this.sessions) {
      if (session.status === "active") {
        this.notifySessionState(chatId, "suspended");
      }
    }

    // Persist final state
    this.persistRegistry();
    this.registry?.dispose();

    this.sessions.clear();
    this.evictedMappings.clear();
    this.lastReportedStates.clear();
    this.sessionRuntimeStates.clear();
    this.lastReportedRuntimeState = null;
    this._activeCount = 0;
  }

  get activeCount(): number {
    return this._activeCount;
  }

  get totalCount(): number {
    return this.sessions.size;
  }

  /** Return the current aggregate runtime state, or null if no sessions have reported. */
  getAggregateRuntimeState(): RuntimeState | null {
    return this.lastReportedRuntimeState;
  }

  /** Return all current session states for full state sync after reconnect. */
  getSessionStates(): Array<{ chatId: string; state: SessionState }> {
    return [...this.sessions.entries()].map(([chatId, entry]) => ({
      chatId,
      state: entry.status,
    }));
  }

  // ---- Internal -----------------------------------------------------------

  private async routeMessage(chatId: string, message: SessionMessage, entryId?: number): Promise<void> {
    const existing = this.sessions.get(chatId);

    if (existing) {
      switch (existing.status) {
        case "active":
          // ACK before injecting — handler is already processing
          await this.ackEntry(entryId, chatId);
          existing.handler.inject(message);
          existing.lastActivity = Date.now();
          this.config.log(`Session ${chatId}: message injected`);
          return;

        case "suspended":
        case "evicted":
          // Resume session — ACK happens inside resumeSession
          await this.resumeSession(existing, message, entryId);
          return;
      }
    }

    // No existing session — create new
    await this.startNewSession(chatId, message, entryId);
  }

  private async startNewSession(chatId: string, message: SessionMessage, entryId?: number): Promise<void> {
    // Enforce concurrency limit
    if (!this.acquireActiveSlot(chatId, message, entryId)) return;

    // ACK now — handler is about to start processing
    await this.ackEntry(entryId, chatId);

    // Enforce max_sessions (evict LRU)
    this.evictIfNeeded();

    // Check for prior evicted session mapping
    const evicted = this.evictedMappings.get(chatId);

    // Step 6: thread the AgentConfigCache to the handler so it can read the
    // current per-agent runtime config when launching its sub-process.
    const handlerCfg = this.config.agentConfigCache
      ? { ...this.config.handlerConfig, agentConfigCache: this.config.agentConfigCache }
      : this.config.handlerConfig;
    const handler = this.config.handlerFactory(handlerCfg);
    const ctx = this.buildSessionContext(chatId);

    const entry: SessionEntry = {
      chatId,
      claudeSessionId: evicted?.claudeSessionId ?? "",
      handler,
      status: "active",
      lastActivity: Date.now(),
      suspending: null,
    };

    this.sessions.set(chatId, entry);
    this._activeCount++;
    if (evicted) this.evictedMappings.delete(chatId);

    try {
      if (evicted) {
        const sessionId = await handler.resume(message, evicted.claudeSessionId, ctx);
        entry.claudeSessionId = sessionId;
        this.config.log(`Session ${chatId}: resumed from eviction (${sessionId})`);
      } else {
        const sessionId = await handler.start(message, ctx);
        entry.claudeSessionId = sessionId;
        this.config.log(`Session ${chatId}: created (${sessionId})`);
      }
      this.persistRegistry();
      this.notifySessionState(chatId, "active");
    } catch (err) {
      this.config.log(
        `Session ${chatId}: ${evicted ? "resume" : "start"} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.sessions.delete(chatId);
      this.sessionRuntimeStates.delete(chatId);
      this.recomputeRuntimeState();
      this._activeCount--;
    }
  }

  private async resumeSession(
    entry: SessionEntry,
    message: SessionMessage | null | undefined,
    entryId?: number,
  ): Promise<void> {
    // Wait for in-flight suspension to complete before resuming
    if (entry.suspending) {
      await entry.suspending;
    }

    // For admin-triggered resume (no message), synthesize a minimal stub for slot acquisition only
    const slotMessage: SessionMessage = message ?? {
      id: "",
      chatId: entry.chatId,
      senderId: "",
      format: "text",
      content: "",
      metadata: {},
    };

    // Enforce concurrency limit
    if (!this.acquireActiveSlot(entry.chatId, slotMessage, entryId)) return;

    // ACK now — handler is about to resume processing
    await this.ackEntry(entryId, entry.chatId);

    const ctx = this.buildSessionContext(entry.chatId);
    entry.status = "active";
    this._activeCount++;
    entry.lastActivity = Date.now();

    try {
      await entry.handler.resume(message ?? undefined, entry.claudeSessionId, ctx);
      this.config.log(`Session ${entry.chatId}: resumed (${entry.claudeSessionId})`);
      this.persistRegistry();
      this.notifySessionState(entry.chatId, "active");
    } catch (err) {
      this.config.log(`Session ${entry.chatId}: resume failed: ${err instanceof Error ? err.message : String(err)}`);
      entry.status = "suspended";
      this._activeCount--;
    }
  }

  /**
   * Try to acquire an active slot. If at concurrency limit:
   * 1. Suspend the least-recently-active session to free a slot
   * 2. If no candidates, queue the message
   *
   * Returns true if slot acquired, false if queued.
   */
  private acquireActiveSlot(chatId: string, message: SessionMessage, entryId?: number): boolean {
    if (this._activeCount < this.config.concurrency) return true;

    // Find least-recently-active session (excluding the target chat)
    let oldestActive: SessionEntry | null = null;
    for (const session of this.sessions.values()) {
      if (session.status !== "active") continue;
      if (session.chatId === chatId) continue;
      if (!oldestActive || session.lastActivity < oldestActive.lastActivity) {
        oldestActive = session;
      }
    }

    if (oldestActive) {
      this.config.log(`Session ${oldestActive.chatId}: preempted for concurrency`);
      this.suspendSession(oldestActive);
      return true;
    }

    // All active sessions are busy — queue (no ACK yet — message stays as delivered)
    this.config.log(`Session ${chatId}: concurrency limit reached, queuing`);
    this.pendingQueue.push({ message, chatId, entryId: entryId ?? -1 });
    return false;
  }

  private suspendSession(entry: SessionEntry): void {
    entry.status = "suspended";
    this._activeCount--;
    // Clear per-session runtime state on suspend
    this.sessionRuntimeStates.delete(entry.chatId);
    this.recomputeRuntimeState();
    entry.suspending = entry.handler
      .suspend()
      .catch((err) => {
        this.config.log(`Session ${entry.chatId}: suspend error: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        entry.suspending = null;
      });
    this.persistRegistry();
    this.notifySessionState(entry.chatId, "suspended");

    // Drain pending queue
    this.drainPendingQueue();
  }

  private drainPendingQueue(): void {
    if (this.pendingQueue.length === 0) return;
    if (this._activeCount >= this.config.concurrency) return;

    const next = this.pendingQueue.shift();
    if (!next) return;
    // Route asynchronously — entryId is passed for delayed ACK
    this.routeMessage(next.chatId, next.message, next.entryId > 0 ? next.entryId : undefined).catch((err) => {
      this.config.log(
        `Session ${next.chatId}: pending drain error: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  private evictIfNeeded(): void {
    const { max_sessions } = this.config.session;
    if (this.sessions.size < max_sessions) return;

    // Single pass: find LRU session, preferring non-active over active
    let candidate: { key: string; session: SessionEntry } | null = null;
    for (const [key, session] of this.sessions) {
      if (!candidate) {
        candidate = { key, session };
        continue;
      }
      const preferNonActive = session.status !== "active" && candidate.session.status === "active";
      const sameCategory = (session.status === "active") === (candidate.session.status === "active");
      if (preferNonActive || (sameCategory && session.lastActivity < candidate.session.lastActivity)) {
        candidate = { key, session };
      }
    }

    if (candidate) {
      // Preserve mapping for future recovery
      this.addEvictedMapping(candidate.key, {
        claudeSessionId: candidate.session.claudeSessionId,
        lastActivity: candidate.session.lastActivity,
      });

      this.config.log(`Session ${candidate.key}: evicted (max_sessions reached)`);
      if (candidate.session.status === "active") {
        this._activeCount--;
        candidate.session.handler.shutdown().catch(() => {});
      }
      candidate.session.status = "evicted";
      this.notifySessionState(candidate.key, "evicted");
      this.sessions.delete(candidate.key);
      this.sessionRuntimeStates.delete(candidate.key);
      this.recomputeRuntimeState();
      this.persistRegistry();
    }
  }

  private evictIdle(): void {
    const timeoutMs = this.config.session.idle_timeout * 1000;
    // Blocked detection — 2 minutes without activity while session is active
    const blockedThresholdMs = 120_000;
    const now = Date.now();

    for (const [, session] of this.sessions) {
      if (session.status !== "active") continue;
      const inactiveMs = now - session.lastActivity;

      if (inactiveMs > timeoutMs) {
        this.config.log(`Session ${session.chatId}: idle ${this.config.session.idle_timeout}s, suspending`);
        this.suspendSession(session);
      } else if (inactiveMs > blockedThresholdMs) {
        // Only mark blocked if handler was actively working — don't override idle
        const currentState = this.sessionRuntimeStates.get(session.chatId);
        if (currentState === "working") {
          this.config.log(
            `Session ${session.chatId}: working but no output for ${Math.round(inactiveMs / 1000)}s, marking blocked`,
          );
          this.setSessionRuntimeState(session.chatId, "blocked");
        }
      }
    }
  }

  /** Add an evicted mapping, pruning the oldest if over capacity. */
  private addEvictedMapping(chatId: string, mapping: { claudeSessionId: string; lastActivity: number }): void {
    this.evictedMappings.set(chatId, mapping);
    if (this.evictedMappings.size > MAX_EVICTED_MAPPINGS) {
      // Map iteration order is insertion order — first key is the oldest
      const oldest = this.evictedMappings.keys().next().value;
      if (oldest !== undefined) this.evictedMappings.delete(oldest);
    }
  }

  /** Notify per-session state change to the server via callback. Deduplicates redundant reports. */
  private notifySessionState(chatId: string, state: SessionState): void {
    if (!this.config.onStateChange) return;
    if (this.lastReportedStates.get(chatId) === state) return;
    this.lastReportedStates.set(chatId, state);
    this.config.onStateChange(chatId, state);
  }

  /** ACK an inbox entry — delayed until handler starts processing. */
  private async ackEntry(entryId: number | undefined, chatId: string): Promise<void> {
    if (entryId === undefined) return;
    try {
      await this.config.sdk.ack(entryId);
    } catch {
      this.config.log(`Session ${chatId}: ACK failed for entry ${entryId}, continuing`);
    }
  }

  private buildSessionContext(chatId: string): SessionContext {
    return {
      agent: this.config.agentIdentity,
      sdk: this.config.sdk,
      log: (msg) => this.config.log(`Session ${chatId}: ${msg}`),
      chatId,
      touch: () => {
        const entry = this.sessions.get(chatId);
        if (entry && entry.status === "active") {
          entry.lastActivity = Date.now();
        }
      },
      setRuntimeState: (state) => {
        this.setSessionRuntimeState(chatId, state);
      },
      emitEvent: (event) => {
        this.config.onSessionEvent?.(chatId, event);
      },
      reportSessionCompletion: () => {
        this.config.onSessionCompletion?.(chatId);
      },
    };
  }

  /** Update per-session runtime state and recompute aggregate. Only active sessions may update. */
  private setSessionRuntimeState(chatId: string, state: RuntimeState): void {
    const session = this.sessions.get(chatId);
    if (!session || session.status !== "active") return;
    this.sessionRuntimeStates.set(chatId, state);
    this.recomputeRuntimeState();
  }

  /** Aggregate per-session runtime states: error > blocked > working > idle. */
  private recomputeRuntimeState(): void {
    if (!this.config.onRuntimeStateChange) return;

    let aggregate: RuntimeState = "idle";
    for (const state of this.sessionRuntimeStates.values()) {
      if (state === "error") {
        aggregate = "error";
        break;
      }
      if (state === "blocked") {
        aggregate = "blocked";
      } else if (state === "working" && aggregate !== "blocked") {
        aggregate = "working";
      }
    }

    if (aggregate !== this.lastReportedRuntimeState) {
      this.lastReportedRuntimeState = aggregate;
      this.config.onRuntimeStateChange(aggregate);
    }
  }

  private extractMessage(entry: InboxEntryWithMessage): SessionMessage {
    const msg = entry.message;
    return {
      id: msg.id,
      chatId: entry.chatId ?? msg.chatId,
      senderId: msg.senderId,
      format: msg.format,
      content: msg.content as string | Record<string, unknown>,
      metadata: msg.metadata,
    };
  }

  private loadPersistedSessions(): void {
    if (!this.registry) return;

    const persisted = this.registry.load();
    for (const [chatId, data] of persisted) {
      // All persisted sessions become evicted mappings on load.
      // Handlers are allocated lazily when a message arrives (startNewSession
      // checks evictedMappings and calls handler.resume instead of start).
      this.addEvictedMapping(chatId, {
        claudeSessionId: data.claudeSessionId,
        lastActivity: data.lastActivity,
      });
    }

    if (persisted.size > 0) {
      this.config.log(`Loaded ${persisted.size} persisted session mapping(s)`);
    }
  }

  private persistRegistry(): void {
    if (!this.registry) return;

    const entries = new Map<string, { claudeSessionId: string; lastActivity: number; status: string }>();
    for (const [chatId, session] of this.sessions) {
      entries.set(chatId, {
        claudeSessionId: session.claudeSessionId,
        lastActivity: session.lastActivity,
        status: session.status,
      });
    }
    // Include evicted mappings for crash recovery
    for (const [chatId, mapping] of this.evictedMappings) {
      entries.set(chatId, {
        claudeSessionId: mapping.claudeSessionId,
        lastActivity: mapping.lastActivity,
        status: "evicted",
      });
    }
    this.registry.save(entries);
  }
}
