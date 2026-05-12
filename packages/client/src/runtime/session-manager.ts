import type {
  InboxEntryWithMessage,
  RuntimeState,
  SessionEvent,
  SessionState,
} from "@agent-team-foundation/first-tree-hub-shared";
import { tryResolveQuestionAnswer } from "../handlers/ask-user-bridge.js";
import type { pino } from "../observability/logger.js";
import type { FirstTreeHubSDK } from "../sdk.js";
import type { AgentConfigCache } from "./agent-config-cache.js";
import { buildAgentEnv, createParticipantCache, formatInboundContent, resolveSenderLabel } from "./agent-io.js";
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
import { createResultSink, type Trigger } from "./result-sink.js";
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
  log: pino.Logger;
  registryPath?: string;
  /** Step 4: optional config cache for refresh-before-dispatch on configVersion bump. */
  agentConfigCache?: AgentConfigCache;
  /**
   * Ack channel used by `dispatch` when an entry transitions out of `delivered`.
   * Defaults to `sdk.ack` (HTTP `POST /inbox/:id/ack`) — the legacy poll path.
   * The WS push path (proposal hub-inbox-ws-data-plane §3.4) overrides this
   * with `clientConnection.sendInboxAck` so the entry is acked over the same
   * socket that delivered it. Without this hook a push-mode slot would
   * silently double-ack: HTTP first (status `delivered → acked`) followed by
   * WS (no-op against the now-acked row), and the server-side per-agent
   * in-flight counter — which only decrements on a successful WS ack —
   * would leak to the cap and stop pushing.
   */
  ackEntry?: (entryId: number) => Promise<void>;
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
  /**
   * Current trigger (messageId + senderId) per chat — the message that kicked
   * off the current or most-recent turn. Read by `forwardResult` (via the
   * resultSink closure) to attach `inReplyTo` and default mentions to the
   * outbound reply. Maintained entirely by the runtime: handlers never touch
   * this map, which keeps adding a new handler trivial.
   */
  private readonly currentTrigger = new Map<string, Trigger>();
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
   *
   * One routing guard fires before any session lookup (see
   * proposals/hub-agent-messaging-reply-and-mentions §3.5):
   *
   * - **Echo suppression** — in direct chats, a peer's reply to a message
   *   *we* sent here but whose `replyTo` points elsewhere would otherwise
   *   bounce our session back on. Suppress it so the reply routes only to
   *   the external chat where we're actually waiting.
   *
   * The mention filter used to live here too, but it moved server-side to
   * the fan-out step — see `services/message.ts sendMessage`. Anything
   * reaching dispatch has already passed that check.
   */
  async dispatch(entry: InboxEntryWithMessage): Promise<void> {
    const chatId = entry.chatId ?? entry.message.chatId;
    const messageId = entry.message.id;

    // 0. AskUserQuestion bridge: a `question_answer` message has two
    //    delivery paths:
    //
    //    a) Live waiter — the original `canUseTool` Promise is still
    //       pending in the bridge. Resolve it, ack the inbox entry, and
    //       short-circuit; the SDK takes the answer back into the same
    //       turn. This is the happy path while the agent's SDK process
    //       is still alive.
    //
    //    b) Stale waiter — the SDK process was killed (idle suspend or
    //       explicit shutdown) before the user answered. The bridge map
    //       was cleared by the handler at suspend time, so
    //       `tryResolveQuestionAnswer` reports no match. We must NOT
    //       short-circuit here: the answer needs to flow into the regular
    //       dispatch path so the handler resumes the session and feeds
    //       the answer to the SDK as fresh user input. The handler's
    //       formatInboundContent renders question_answer messages as
    //       readable text ("User selected: ..."), so the resumed turn
    //       sees a normal text prompt.
    if (entry.message.format === "question_answer") {
      const resolved = tryResolveQuestionAnswer(entry.message.content);
      if (resolved) {
        await this.ackEntry(entry.id, chatId);
        return;
      }
      this.config.log.info(
        { chatId, messageId },
        "question_answer with no live bridge waiter — resuming session with answer as input",
      );
      // Fall through to normal dispatch.
    }

    // 1. Deduplication — key by (chatId, messageId), not messageId alone.
    // replyTo cross-chat routing legitimately fan-outs the same message into
    // two inbox_entries with different chatIds (one in the original chat,
    // one in the replyTo target chat); server-side identity is (inboxId,
    // messageId, chatId) and client dedup must mirror that, otherwise the
    // second entry is silently dropped.
    const dedupKey = `${chatId}:${messageId}`;
    if (this.deduplicator.isDuplicate(dedupKey)) {
      this.config.log.debug({ chatId, messageId }, "duplicate message, skipping");
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
        this.config.log.warn(
          {
            chatId,
            agentId: this.config.agentIdentity.agentId,
            incomingVersion: entry.message.configVersion,
            err,
          },
          "config version mismatch — skipping refresh",
        );
      }
    }

    // 3. Routing guards — do not start a session for messages we must not answer.
    if (shouldSuppressEcho(entry, this.config.agentIdentity.agentId)) {
      this.config.log.info(
        { chatId, messageId },
        "suppressing echo — message replies to our own send whose replyTo points elsewhere",
      );
      await this.ackEntry(entry.id, chatId);
      return;
    }

    // Note: the "mention_only" filter now lives on the server (see
    // services/message.ts sendMessage fan-out). If an entry reaches dispatch
    // we assume server already decided we should handle it — this avoids a
    // double-guard that drifted between server / client in early M1.

    // 4. Extract message content (handler does not see inbox metadata)
    const message = this.extractMessage(entry);

    // 5. Route by session state — ACK happens inside route when handler starts
    await this.routeMessage(chatId, message, entry.id);
  }

  /** Handle a server-issued session command. Terminate drops all local state without reporting back. */
  async handleCommand(chatId: string, command: "session:suspend" | "session:terminate"): Promise<void> {
    if (command === "session:suspend") {
      const session = this.sessions.get(chatId);
      if (session?.status === "active") {
        this.config.log.info({ chatId }, "suspend command received");
        this.suspendSession(session);
      }
      return;
    }

    if (command === "session:terminate") {
      const session = this.sessions.get(chatId);
      const hadMapping = this.evictedMappings.has(chatId);
      if (!session && !hadMapping) return;

      this.config.log.info({ chatId }, "terminate command received");
      if (session?.status === "active") {
        this._activeCount--;
        await session.handler.shutdown().catch(() => {});
      }

      this.sessions.delete(chatId);
      this.evictedMappings.delete(chatId);
      this.sessionRuntimeStates.delete(chatId);
      this.lastReportedStates.delete(chatId);
      this.currentTrigger.delete(chatId);

      for (let i = this.pendingQueue.length - 1; i >= 0; i--) {
        if (this.pendingQueue[i]?.chatId === chatId) this.pendingQueue.splice(i, 1);
      }

      this.recomputeRuntimeState();
      this.persistRegistry();
      this.drainPendingQueue();
    }
  }

  /** Chat IDs this client still holds locally (sessions + evictedMappings). */
  getHeldChatIds(): string[] {
    const ids = new Set<string>();
    for (const id of this.sessions.keys()) ids.add(id);
    for (const id of this.evictedMappings.keys()) ids.add(id);
    return [...ids];
  }

  /**
   * Apply a server-declared stale list from `session:reconcile:result` — treat
   * each chatId as if a `session:terminate` command had arrived.
   */
  applyStaleChatIds(staleChatIds: string[]): void {
    for (const id of staleChatIds) {
      void this.handleCommand(id, "session:terminate");
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

  /**
   * Snapshot used by the UpdateManager's quiet gate to decide whether it is
   * safe to exit the process for a self-update. `activeCount` is the number of
   * sessions currently handling a message; `lastActivityMs` is the most recent
   * activity timestamp across all tracked sessions (0 when there are none).
   */
  getQuietGateSnapshot(): { activeCount: number; lastActivityMs: number } {
    let lastActivityMs = 0;
    for (const entry of this.sessions.values()) {
      if (entry.lastActivity > lastActivityMs) lastActivityMs = entry.lastActivity;
    }
    return { activeCount: this._activeCount, lastActivityMs };
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
    // Record the trigger BEFORE dispatching to any handler path (start /
    // resume / inject) so the resultSink constructed in buildSessionContext
    // sees the right messageId+senderId when this turn eventually produces a
    // reply. The sink clears it on forward so an intervening inject() can
    // overwrite it without the in-flight reply stealing the new trigger.
    if (message.id) {
      this.currentTrigger.set(chatId, { messageId: message.id, senderId: message.senderId });
    }

    const existing = this.sessions.get(chatId);

    if (existing) {
      switch (existing.status) {
        case "active":
          // ACK before injecting — handler is already processing
          await this.ackEntry(entryId, chatId);
          existing.handler.inject(message);
          existing.lastActivity = Date.now();
          this.config.log.debug({ chatId }, "message injected");
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
        this.config.log.info({ chatId, sessionId }, "session resumed from eviction");
      } else {
        const sessionId = await handler.start(message, ctx);
        entry.claudeSessionId = sessionId;
        this.config.log.info({ chatId, sessionId }, "session created");
      }
      this.persistRegistry();
      this.notifySessionState(chatId, "active");
    } catch (err) {
      // Pre-fix this catch only logged and torn local state down. The
      // server's `agent_chat_sessions.state` stayed `active`, no chat
      // message was emitted, and the agent looked silently failed to
      // every observer. F2 (chat-participant-mode-fix-design.md §3.3)
      // signals the failure three ways: structured log (existing),
      // `session:state=errored` to the server (so admin/UI see it), and
      // a single user-visible chat message via the result-sink (so the
      // requester knows the agent didn't drop their message on purpose).
      const errMsg = err instanceof Error ? err.message : String(err);
      const phase: "start" | "resume" = evicted ? "resume" : "start";
      this.config.log.error({ chatId, err, phase }, "session start/resume failed");

      // 1) Server-side state. notifySessionState dedupes against the last
      //    reported value, so even if we somehow already reported "active"
      //    for this chat, this `errored` transition will go through.
      this.notifySessionState(chatId, "errored");

      // 2) User-visible chat message. Truncate to 800 chars so we don't
      //    leak full stderr (which may include FS paths or git internals)
      //    into the chat timeline; the full error is in the structured log.
      try {
        const preview = errMsg.slice(0, 800);
        const agentLabel = this.config.agentIdentity.displayName ?? this.config.agentIdentity.agentId;
        const userMsg = `⚠️ Session ${phase} failed (${agentLabel}): ${preview}`;
        await ctx.forwardResult(userMsg);
      } catch (forwardErr) {
        this.config.log.warn({ chatId, forwardErr }, "session error forward failed");
      }

      // 3) Existing local cleanup. Order matters: forward FIRST while the
      //    session entry is still live (forwardResult reads currentTrigger
      //    / participant cache via the session context built above);
      //    THEN tear down so a follow-up message can route as a fresh start.
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
      this.config.log.info({ chatId: entry.chatId, sessionId: entry.claudeSessionId }, "session resumed");
      this.persistRegistry();
      this.notifySessionState(entry.chatId, "active");
    } catch (err) {
      this.config.log.warn({ chatId: entry.chatId, err }, "resume failed");
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
      this.config.log.info({ chatId: oldestActive.chatId }, "session preempted for concurrency");
      this.suspendSession(oldestActive);
      return true;
    }

    // All active sessions are busy — queue (no ACK yet — message stays as delivered)
    this.config.log.info({ chatId }, "concurrency limit reached, queuing");
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
        this.config.log.warn({ chatId: entry.chatId, err }, "suspend error");
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
      this.config.log.warn({ chatId: next.chatId, err }, "pending drain error");
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

      this.config.log.info({ chatId: candidate.key }, "session evicted (max_sessions reached)");
      if (candidate.session.status === "active") {
        this._activeCount--;
        candidate.session.handler.shutdown().catch(() => {});
      }
      // LRU eviction is a local memory-management concern, not operator intent
      // — do NOT emit a wire state. The server row stays as last reported;
      // the local `evictedMappings` entry keeps resume-on-next-message working.
      // (`suspended` here would accumulate rows in agent_chat_sessions forever
      // since the cleanup cron is out of scope for this redesign.)
      this.sessions.delete(candidate.key);
      this.sessionRuntimeStates.delete(candidate.key);
      // Drop the trigger alongside the session — the next message routed to
      // this chat will set a fresh one. Leaving stale entries here would
      // only burn memory (wrong replies are not a risk since `routeMessage`
      // overwrites before the handler runs), but since `terminate` already
      // cleans the same maps we keep the two paths symmetric.
      this.currentTrigger.delete(candidate.key);
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
        this.config.log.info(
          { chatId: session.chatId, idleTimeoutSec: this.config.session.idle_timeout },
          "session idle, suspending",
        );
        this.suspendSession(session);
      } else if (inactiveMs > blockedThresholdMs) {
        // Only mark blocked if handler was actively working — don't override idle
        const currentState = this.sessionRuntimeStates.get(session.chatId);
        if (currentState === "working") {
          this.config.log.warn(
            { chatId: session.chatId, inactiveSec: Math.round(inactiveMs / 1000) },
            "session working but no output, marking blocked",
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

  /**
   * ACK an inbox entry — delayed until handler starts processing.
   *
   * Routes through `config.ackEntry` when set (WS push path) or falls back to
   * `sdk.ack` (HTTP poll path). One ack per entry, one channel per slot —
   * mixing channels in one slot would leak the server's per-agent in-flight
   * counter (proposal hub-inbox-ws-data-plane §3.5).
   */
  private async ackEntry(entryId: number | undefined, chatId: string): Promise<void> {
    if (entryId === undefined) return;
    try {
      if (this.config.ackEntry) {
        await this.config.ackEntry(entryId);
      } else {
        await this.config.sdk.ack(entryId);
      }
    } catch {
      this.config.log.warn({ chatId, entryId }, "ACK failed, continuing");
    }
  }

  private buildSessionContext(chatId: string): SessionContext {
    const sessionLog = this.config.log.child({ chatId });
    // Runtime-facing string log (handler + result-sink expect a simple
    // `(msg: string) => void` signature). The child pino logger still goes
    // to other places that want structured fields.
    const log = (msg: string) => sessionLog.info(msg);

    // One participant cache per session — shared by result-sink (for the
    // direct-vs-group default-mention decision) and formatInboundContent
    // (for resolving `[From: <name>]`). First use triggers a fetch;
    // subsequent calls in either consumer hit memory.
    const participants = createParticipantCache(this.config.sdk, chatId, log);

    const forwardResult = createResultSink({
      sdk: this.config.sdk,
      agent: this.config.agentIdentity,
      chatId,
      getTrigger: () => this.currentTrigger.get(chatId) ?? null,
      clearTrigger: () => {
        this.currentTrigger.delete(chatId);
      },
      log,
      participants,
    });

    const envCtx = { sdk: this.config.sdk, agent: this.config.agentIdentity, chatId };

    return {
      agent: this.config.agentIdentity,
      sdk: this.config.sdk,
      log,
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
      forwardResult,
      buildAgentEnv: (parentEnv) => buildAgentEnv(parentEnv, envCtx),
      formatInboundContent: (message) => formatInboundContent(message, participants),
      resolveSenderLabel: async (senderId) => resolveSenderLabel(senderId, await participants.get()),
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
      precedingMessages: msg.precedingMessages ?? [],
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
      this.config.log.info({ count: persisted.size }, "loaded persisted session mappings");
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

/**
 * Core echo rule: a reply to a message *we* sent in this same chat, whose
 * original carried a `replyTo` pointing to a *different* chat, must not wake
 * our session on this side. Server-side replyTo routing already delivers a
 * second entry in the target chat, so suppressing the fan-out copy here
 * leaves exactly one path from peer's reply to our waiting session.
 *
 * The four early-returns spell out "when this is NOT an echo":
 *  - no snapshot        → just a regular message, not a reply
 *  - sender isn't us    → replying to someone else's message, clearly not an echo
 *  - original chat != this chat
 *       → the reply arrived in a chat where we never sent the original;
 *         could only happen via replyTo fan-out of a different thread, so
 *         suppressing would silence a legit cross-chat handoff
 *  - original had no replyTo → sender didn't ask replies to route away, so
 *                              the peer's reply here is the canonical path
 *
 * Only when all four are satisfied AND the replyTo target is a different
 * chat do we suppress — that's exactly proposal §3.5 Case A.
 */
export function shouldSuppressEcho(entry: InboxEntryWithMessage, myAgentId: string): boolean {
  const snapshot = entry.message.inReplyToSnapshot;
  if (!snapshot) return false;
  const entryChatId = entry.chatId ?? entry.message.chatId;
  if (snapshot.senderId !== myAgentId) return false;
  if (snapshot.chatId !== entryChatId) return false;
  if (snapshot.replyToChat === null) return false;
  return snapshot.replyToChat !== entryChatId;
}
